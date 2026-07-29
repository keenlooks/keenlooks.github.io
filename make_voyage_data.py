#!/usr/bin/env python3
"""
make_voyage_data.py -- builds assets/js/voyage-data.js for /voyage/ (Mission to Anywhere).

Sources (downloaded once into %LOCALAPPDATA%/Temp/voyagedata/, --fresh re-downloads):
  * AT-HYG (Augmented Tycho-HYG) stellar database v4.0 -- (c) David Nash,
    astronexus.com, CC BY-SA 4.0. The generated star arrays are a derivative work
    and inherit that license; the headers written into voyage-data.js and
    voyage-bg.js carry the attribution and the modification note.
  * HYG v4.x (same author, same license) -- used ONLY to recover colour indices
    AT-HYG drops (see COLOUR INDEX below).

COLOUR INDEX (B-V), three sources in strict priority order. The rule is applied
identically to the navigable tier and to both background bands, and the counts
per source are printed at build time:

  1. AT-HYG's own `ci` column. A measured Johnson B-V wherever the catalog has
     one, and the source for ~99.9% of every tier.
  2. HYG's `ci`, joined on AT-HYG's own `hyg` cross-reference column. AT-HYG
     re-sources photometry from Tycho and its `ci` is blank wherever Tycho
     carries VT but not BT, which is precisely the brightest stars in the sky:
     Sirius, Vega, Capella, Arcturus, Procyon, Rigil Kentaurus, Hadar, Toliman,
     Castor, Alsephina, Dubhe, Alhena, Avior and Mintaka all ship with a blank
     ci in AT-HYG v4.0 and a measured B-V in HYG. This is a RECOVERY of a
     measurement the two catalogs share, not a new estimate. No Tycho
     transform is used: AT-HYG has no BT/VT columns, and where its ci is blank
     the transform's input is what is missing.
  3. Only if both fail and the row carries a published MK spectral type, B-V is
     ESTIMATED from that type through the standard intrinsic-colour sequences
     (Pecaut & Mamajek 2013 for dwarfs, the Johnson giant and supergiant
     sequences for III and I). A spectral type is itself a measurement, and this
     is the same class of conversion as the Ballesteros ci-from-teff already
     used for exoplanet hosts. It reaches the components of bright multiples
     (Capella B, Castor B, Sabik B, Procyon B) that no catalog photometers.
     Two known limits, both accepted because the alternative is no colour at
     all: it returns the INTRINSIC colour, so a reddened distant OB star comes
     out bluer than it looks from here; and a type with no subtype ('A m')
     resolves to the middle of its class.

  Anything that survives all three keeps ci = null and the page simply omits the
  temperature and width lines. Nothing is invented: a star with no measured
  colour, no cross-reference and no spectral type gets no colour.
  * NASA Exoplanet Archive, Planetary Systems Composite Parameters (pscomppars),
    via the TAP sync endpoint.
  * Far-side beacons, none of which carry a NonCommercial clause:
      - Skowron et al. 2024, ApJS 278, 57 (mid-infrared classical Cepheids)
      - Reid et al. 2019, ApJ 885, 131 (BeSSeL VLBI maser parallaxes)
      - Baumgardt & Vasiliev 2021, MNRAS 505, 5957 (globular cluster distances)
      - GRAVITY Collaboration 2021, A&A 647 A59 (Sagittarius A*)
      - Pietrzynski et al. 2019, Nature 567, 200 (Large Magellanic Cloud)
      - Graczyk et al. 2020, ApJ 904, 13 (Small Magellanic Cloud)

Output: assets/js/voyage-data.js -- a window/worker/node-safe global VOYAGE_DATA with
flat parallel arrays: ~10k navigable stars (naked-eye set + all proper-named +
exoplanet hosts + the luminous distant tier, hard-cut at 16,000 light-years)
positioned in ECLIPTIC J2000 xyz light-years, every known planet within ~20 pc plus
a short list of famous distant systems, and VOYAGE_DATA.far: a few hundred named
objects out across the galaxy (Cepheids, masers, globular clusters, Sgr A*, the
Magellanic Clouds) as FLOAT records, which the packed background format cannot hold.

Run:  python -u make_voyage_data.py [--fresh]
The script hard-asserts a battery of astronomy anchors (Sirius/Proxima/Vega distances,
Big Dipper angular separations, Regulus on the ecliptic, TRAPPIST-1's seven planets,
the galactic-to-equatorial frame, the far-tier distances) and refuses to write the
files if any fail.

It also writes assets/js/voyage-bg.js: a NON-interactive background tier in TWO
packed bands, 8 bytes per star (int16 x,y,z ecliptic light-years x band scale,
uint8 mag x10, uint8 ci x100+50 with 255 = unknown) and base64-coded. The near band
keeps the original x8 scale (+/-4,095 ly); the far band uses x2 (to 16,383 ly, where
half a light-year of quantization is invisible). The page lazy-loads the file after
first paint purely to fill the sky with real stars.
"""

import base64
import collections
import csv
import gzip
import heapq
import json
import math
import os
import re
import struct
import subprocess
import sys
import time
import urllib.request

CACHE = os.path.join(os.environ.get("LOCALAPPDATA", "/tmp"), "Temp", "voyagedata")
# The env var already points at ...\AppData\Local; the Temp segment lives under it.
if os.name == "nt":
    CACHE = os.path.join(os.environ["LOCALAPPDATA"], "Temp", "voyagedata")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "js", "voyage-data.js")
OUT_BG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "js", "voyage-bg.js")

# ---------------------------------------------------------------------------
# Tier sizes. Each of these is a single knob; the perf gate in the wave-5 plan
# can cap NAV_CAP at ~6,000 without touching anything else in this file.
# ---------------------------------------------------------------------------
NAV_CAP = 10000            # navigable (clickable) stars
NAV_MAX_LY = 16000.0       # hard cut: AT-HYG's 1/parallax distances are honest to
                           # ~5 kpc and its tail past ~10 kpc is noise (LMC members
                           # listed at twice the LMC's distance). Never ship the tail.
NAV_LUM_ABSMAG = -4.0      # the luminous distant tier: blue supergiants and W-R stars
NAV_LUM_MIN_LY = 3262.0    # 1 kpc

BG_NEAR_CAP = 60000
BG_NEAR_SCALE = 8          # int16 = light-years * 8 -> +/-4,095 ly reach
BG_NEAR_MAX_LY = 4000.0
BG_FAR_CAP = 39999
BG_FAR_SCALE = 2           # int16 = light-years * 2 -> +/-16,383 ly reach
BG_FAR_MAX_LY = 16000.0
# Every band's record count is trimmed to a multiple of 3 so its payload is a
# multiple of 3 bytes and its base64 needs no '=' padding. The page's own base64
# decoder strips padding characters BEFORE it counts groups, so a padded string
# comes back three bytes short and the whole band is rejected. 60,000 records
# happened to be padding-free, which is why nothing has ever hit this.
BG_BLOCK = 3

FAR_CEPHEID_TARGET = 250   # curated, spread across the far disc
FAR_CEPHEID_MIN_PC = 3000.0
FAR_HARD_CUT_PC = 25000.0  # the misclassification tail reaches 180,000 pc
FAR_CEPHEID_MAX_RELERR = 0.08
FAR_MASER_MIN_PC = 3000.0
FAR_MASER_MAX_RELERR = 0.20   # the authors' own cut

# ---------------------------------------------------------------------------
# Downloads. Codeberg serves these through Git LFS: the /raw/ endpoint returns a
# 134-byte POINTER file with HTTP 200, /media/ returns the real bytes. The size
# floor below is what makes a pointer impossible to parse as a catalog.
# ---------------------------------------------------------------------------
ATHYG_URLS = [
    ("https://codeberg.org/astronexus/athyg/media/branch/main/data/athyg_40.csv.gz", "v4.0"),
]
ATHYG_MIN_BYTES = 50 << 20   # the real file is ~199.7 MB
# HYG v4.x is kept ONLY as the colour-index fallback source (see COLOUR INDEX
# below). AT-HYG re-sources photometry from Tycho and leaves `ci` empty wherever
# Tycho has VT but no BT, which is exactly the very bright stars -- Sirius, Vega,
# Capella, Arcturus and Procyon all ship with an empty ci in AT-HYG v4.0 while
# carrying a measured Johnson B-V in HYG, the catalog AT-HYG is built from. Every
# AT-HYG row keeps its HYG row number in the `hyg` column, so the recovery is an
# id join, not a re-derivation.
HYG_URLS = [
    # Codeberg CURRENT is Git-LFS: the /media/ endpoint serves the real bytes
    # (the /raw/ endpoint returns a 133-byte LFS pointer with HTTP 200 -- trap).
    ("https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz", "v4.4"),
    # Frozen GitHub mirror, verified reachable 2026-07.
    ("https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv", "v4.1"),
]
TAP = ("https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query="
       "select+pl_name,hostname,ra,dec,sy_dist,sy_vmag,pl_orbper,pl_orbsmax,pl_rade,"
       "pl_bmasse,pl_eqt,disc_year,discoverymethod,st_spectype,st_teff,st_lum,"
       "sy_snum,sy_pnum+from+pscomppars&format=csv")
SKOWRON_URL = ("https://content.cld.iop.org/journals/0067-0049/278/2/57/revision1/"
               "apjsadc3f3t1_mrt.txt")
REID_URL = ("https://content.cld.iop.org/journals/0004-637X/885/2/131/revision1/"
            "apjab4a11t1_mrt.txt")
BV_URL = "https://people.smp.uq.edu.au/HolgerBaumgardt/globular/combined_table.txt"

# Distant-but-famous systems kept regardless of distance (everything within 20.5 pc
# is kept automatically). Spellings verified against the live archive 2026-07.
FAMOUS = [
    "Kepler-452", "Kepler-186", "Kepler-22", "Kepler-16", "KOI-351", "Kepler-62",
    "Kepler-11", "Kepler-444", "Kepler-7", "HD 209458", "WASP-12", "K2-18",
    "TOI-700", "KELT-9", "TrES-2", "CoRoT-7", "PSR B1257+12",
]
# The archive files the eight-planet Kepler-90 system under its KOI designation.
RENAME_HOST = {"KOI-351": "Kepler-90"}

LY_PER_PC = 3.261563777
OBLIQ = math.radians(23.43928)  # J2000 mean obliquity
# J2000 galactic frame (the Skowron catalog is in galactic coordinates).
GAL_RA_NGP = math.radians(192.85948)
GAL_DEC_NGP = math.radians(27.12825)
GAL_L_NCP = math.radians(122.93192)
GREEK = {
    "Alp": "α", "Bet": "β", "Gam": "γ", "Del": "δ",
    "Eps": "ε", "Zet": "ζ", "Eta": "η", "The": "θ",
    "Iot": "ι", "Kap": "κ", "Lam": "λ", "Mu": "μ",
    "Nu": "ν", "Xi": "ξ", "Omi": "ο", "Pi": "π",
    "Rho": "ρ", "Sig": "σ", "Tau": "τ", "Ups": "υ",
    "Phi": "φ", "Chi": "χ", "Psi": "ψ", "Ome": "ω",
}
SUPER = {"1": "¹", "2": "²", "3": "³"}


# ---------------------------------------------------------------------------
# fetching
# ---------------------------------------------------------------------------
def fetch(url, dest, timeout=600):
    """urllib first, curl second.

    Some hosts (CDS/VizieR in particular) fail this machine's Python with
    SSL: CERTIFICATE_VERIFY_FAILED because the Windows trust store lacks the
    intermediate CA. curl ships its own CA bundle and works. Verification is
    never disabled.
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "voyage-data/2.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
        return
    except Exception as e:  # noqa: BLE001 - fall through to curl
        print("  urllib failed (" + str(e) + "), retrying with curl", flush=True)
    subprocess.run(["curl", "-sSL", "--retry", "2", "--max-time", str(timeout),
                    "-o", dest, url], check=True)


def download_if_missing(url, dest, min_bytes, label, fresh=False):
    if not fresh and os.path.exists(dest) and os.path.getsize(dest) >= min_bytes:
        return dest
    print("downloading " + label + ":", url, flush=True)
    tmp = dest + ".part"
    fetch(url, tmp)
    size = os.path.getsize(tmp)
    if size < min_bytes:
        os.remove(tmp)
        raise SystemExit(label + " download is only " + str(size) + " bytes; expected at "
                         "least " + str(min_bytes) + " (an LFS pointer or a truncated file)")
    os.replace(tmp, dest)
    return dest


def athyg_header_ok(path):
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
        head = f.readline()
    return head.lstrip('"').startswith("id") and "dist_src" in head and "pmra" in head


def hyg_header_ok(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        head = f.readline()
    return '"id"' in head or head.lstrip('"').startswith("id")


def ensure_hyg(fresh):
    """The HYG colour-index fallback source. Never fatal: if it cannot be
    fetched the build continues on AT-HYG's own ci plus the spectral-type
    estimate, and the per-source counts printed at the end say so."""
    hyg = os.path.join(CACHE, "hyg.csv")
    ver_path = os.path.join(CACHE, "hyg.version")
    if fresh or not os.path.exists(hyg) or os.path.getsize(hyg) < 1 << 20 \
            or not hyg_header_ok(hyg):
        for url, ver in HYG_URLS:
            try:
                print("downloading HYG (colour-index fallback):", url, flush=True)
                raw = os.path.join(CACHE, "hyg.download")
                fetch(url, raw)
                if url.endswith(".gz"):
                    with gzip.open(raw, "rb") as g, open(hyg, "wb") as out:
                        while True:
                            chunk = g.read(1 << 20)
                            if not chunk:
                                break
                            out.write(chunk)
                else:
                    os.replace(raw, hyg)
                # guards both truncation and the LFS-pointer-with-200 trap
                if os.path.getsize(hyg) > 1 << 20 and hyg_header_ok(hyg):
                    with open(ver_path, "w") as vf:
                        vf.write(ver)
                    break
                print("  rejected (bad size or header)", flush=True)
            except Exception as e:  # noqa: BLE001 - try the next mirror
                print("  failed:", e, flush=True)
        else:
            print("  WARNING: no HYG mirror reachable; colour indices AT-HYG "
                  "drops cannot be recovered", flush=True)
            return None, None
    version = "v4.x"
    if os.path.exists(ver_path):
        with open(ver_path) as vf:
            version = vf.read().strip() or "v4.x"
    return hyg, version


def load_hyg_ci(path):
    """HYG row id -> measured Johnson B-V. AT-HYG's `hyg` column is that id."""
    if not path:
        return {}
    out = {}
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        rd = csv.DictReader(f)
        assert "id" in rd.fieldnames and "ci" in rd.fieldnames, \
            "HYG is missing id/ci; the colour fallback would be silently empty"
        for row in rd:
            c = ffloat(row["ci"])
            if c is not None and -0.5 <= c <= 3.0:
                out[row["id"].strip()] = c
    return out


def ensure_data(fresh):
    os.makedirs(CACHE, exist_ok=True)
    athyg = os.path.join(CACHE, "athyg_40.csv.gz")
    ver_path = os.path.join(CACHE, "athyg.version")
    if fresh or not os.path.exists(athyg) or os.path.getsize(athyg) < ATHYG_MIN_BYTES \
            or not athyg_header_ok(athyg):
        for url, ver in ATHYG_URLS:
            try:
                download_if_missing(url, athyg, ATHYG_MIN_BYTES, "AT-HYG", fresh=True)
                # guards truncation AND the LFS-pointer-with-HTTP-200 trap
                if athyg_header_ok(athyg):
                    with open(ver_path, "w") as vf:
                        vf.write(ver)
                    break
                print("  rejected (bad header)", flush=True)
            except Exception as e:  # noqa: BLE001 - try the next mirror
                print("  failed:", e, flush=True)
        else:
            raise SystemExit("could not download the AT-HYG catalog from any mirror")
    version = "v4.0"
    if os.path.exists(ver_path):
        with open(ver_path) as vf:
            version = vf.read().strip() or "v4.0"

    exo = os.path.join(CACHE, "exo.csv")
    if fresh or not os.path.exists(exo) or os.path.getsize(exo) < 1 << 18:
        print("downloading NASA Exoplanet Archive (pscomppars)...", flush=True)
        fetch(TAP, exo)

    sk = download_if_missing(SKOWRON_URL, os.path.join(CACHE, "skowron2024.txt"),
                             400 << 10, "Skowron+2024 Cepheids", fresh)
    rd = download_if_missing(REID_URL, os.path.join(CACHE, "reid2019.txt"),
                             20 << 10, "Reid+2019 BeSSeL masers", fresh)
    bv = download_if_missing(BV_URL, os.path.join(CACHE, "baumgardt.txt"),
                             20 << 10, "Baumgardt & Vasiliev 2021 clusters", fresh)
    hyg, hyg_version = ensure_hyg(fresh)
    return athyg, exo, version, sk, rd, bv, hyg, hyg_version


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def ffloat(s):
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def unit_from_radec(ra_deg, dec_deg):
    ra = math.radians(ra_deg)
    dec = math.radians(dec_deg)
    return (math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec))


def radec_from_galactic(l_deg, b_deg):
    """J2000 galactic (l, b) in degrees -> (ra, dec) in degrees."""
    l = math.radians(l_deg)
    b = math.radians(b_deg)
    sb, cb = math.sin(b), math.cos(b)
    dl = GAL_L_NCP - l
    sdl, cdl = math.sin(dl), math.cos(dl)
    dec = math.asin(math.sin(GAL_DEC_NGP) * sb + math.cos(GAL_DEC_NGP) * cb * cdl)
    ra = GAL_RA_NGP + math.atan2(cb * sdl,
                                 math.cos(GAL_DEC_NGP) * sb - math.sin(GAL_DEC_NGP) * cb * cdl)
    return (math.degrees(ra) % 360.0, math.degrees(dec))


def to_ecliptic(v):
    x, y, z = v
    return (x, math.cos(OBLIQ) * y + math.sin(OBLIQ) * z,
            -math.sin(OBLIQ) * y + math.cos(OBLIQ) * z)


def rel_round(v):
    """Keep about one part in 10,000. Three decimals on a 12,000 ly coordinate is
    a millimetre-scale lie that costs 60 KB across the file."""
    a = abs(v)
    if a < 10:
        return round(v, 3)
    if a < 100:
        return round(v, 2)
    if a < 1000:
        return round(v, 1)
    return round(v)


def ballesteros_ci_from_teff(teff):
    """Invert T = 4600*(1/(0.92 ci + 1.7) + 1/(0.92 ci + 0.62)) by bisection."""
    lo, hi = -0.4, 2.6
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        t = 4600.0 * (1.0 / (0.92 * mid + 1.7) + 1.0 / (0.92 * mid + 0.62))
        if t > teff:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def spect_letter(spectype, teff):
    if spectype:
        # scan for the first CLASS letter: 'sdM4' (subdwarf prefix) must yield
        # M, not s; white dwarfs 'DA...' yield D
        for c in spectype.strip():
            if c in "OBAFGKMDW":
                return c
    if teff is not None:
        for lim, c in ((30000, "O"), (10000, "B"), (7500, "A"), (6000, "F"),
                       (5200, "G"), (3700, "K")):
            if teff >= lim:
                return c
        return "M"
    return ""


# matched case-insensitively and returned canonically: AT-HYG's Tycho-sourced
# spect strings write "M2IA" and "M1.5 IAB" where HYG wrote "M2Iab".
LUM_CLASSES = (("IA0", "Ia0"), ("IAB", "Iab"), ("IA", "Ia"), ("IB", "Ib"),
               ("III", "III"), ("II", "II"), ("IV", "IV"),
               ("VII", "VII"), ("VI", "VI"), ("V", "V"), ("I", "I"))


def lum_class(spect):
    """The Roman-numeral luminosity class out of an AT-HYG spect string, or None.

    'G2 V' -> 'V', 'K0IIIvar' -> 'III', 'M2IA' -> 'Ia', 'F7:Ib-IIv SB' -> 'Ib',
    'A0m...' / 'DA3' -> None. Never guessed: absent means absent.
    """
    if not spect:
        return None
    s = spect.strip()
    up = s.upper()
    # the neighbour tests read the ORIGINAL string so a lowercase peculiarity
    # code ('K0IIIvar') cannot masquerade as another numeral digit
    for i, ch in enumerate(up):
        if ch not in "IV":
            continue
        if i and s[i - 1] in "IVX":
            continue  # mid-numeral, not the start of the token
        for token, canon in LUM_CLASSES:
            if up.startswith(token, i):
                nxt = s[i + len(token):i + len(token) + 1]
                if nxt not in ("I", "V", "X"):
                    return canon
    return None


# ---------------------------------------------------------------------------
# Colour index from a published MK spectral type -- priority 3 of the COLOUR
# INDEX rule in the module docstring, used only when neither AT-HYG nor HYG has
# a measured B-V. Intrinsic (B-V) against subtype, interpolated inside a class
# and never extrapolated past the ends of its own sequence.
#   V   -- Pecaut & Mamajek 2013, "Intrinsic colors of dwarfs" (the online
#          table maintained at pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK).
#   III -- Johnson 1966 giant sequence.
#   I   -- Johnson 1966 supergiant sequence.
# Key = (class letter, subtype 0-9.5). II is read as III and IV as V, which is
# where those sequences actually sit to within about 0.03 mag.
# ---------------------------------------------------------------------------
SPECT_BV = {
    "V": {
        "O": ((3, -0.33), (5, -0.33), (7, -0.32), (9, -0.31)),
        "B": ((0, -0.30), (1, -0.26), (2, -0.24), (3, -0.20), (5, -0.16),
              (7, -0.13), (8, -0.11), (9, -0.07)),
        "A": ((0, -0.01), (1, 0.02), (2, 0.05), (3, 0.08), (5, 0.15),
              (7, 0.20), (9, 0.25)),
        "F": ((0, 0.29), (2, 0.35), (3, 0.39), (5, 0.44), (6, 0.48), (8, 0.53)),
        "G": ((0, 0.59), (2, 0.65), (5, 0.69), (8, 0.74)),
        "K": ((0, 0.82), (1, 0.86), (2, 0.92), (3, 0.98), (4, 1.05),
              (5, 1.15), (7, 1.33)),
        "M": ((0, 1.42), (1, 1.48), (2, 1.50), (3, 1.53), (4, 1.65),
              (5, 1.83), (6, 2.00), (7, 2.10), (8, 2.20), (9, 2.30)),
    },
    "III": {
        "B": ((0, -0.29), (5, -0.11), (9, -0.02)),
        "A": ((0, 0.00), (5, 0.10)),
        "F": ((0, 0.20), (5, 0.35)),
        "G": ((0, 0.80), (5, 0.89), (8, 0.95)),
        "K": ((0, 1.00), (2, 1.16), (3, 1.27), (5, 1.50)),
        "M": ((0, 1.56), (2, 1.60), (5, 1.70)),
    },
    "I": {
        "O": ((9, -0.27),),
        "B": ((0, -0.23), (5, -0.10), (9, -0.03)),
        "A": ((0, -0.01), (5, 0.09)),
        "F": ((0, 0.17), (5, 0.32)),
        "G": ((0, 0.76), (5, 1.02), (8, 1.14)),
        "K": ((0, 1.25), (2, 1.36), (5, 1.60)),
        "M": ((0, 1.67), (2, 1.71), (5, 1.80)),
    },
}
# White dwarfs: the DA/DB sequence spans roughly -0.3 to +0.6 in B-V with no
# subtype-to-colour law this pipeline can honestly apply, EXCEPT that the MK
# subtype of a white dwarf IS a temperature index (D<x><n> where n = 50400/Teff).
SPECT_RE = re.compile(r"([OBAFGKM])\s*(\d(?:\.\d)?)?")
WD_RE = re.compile(r"^D[ABCOQZXVH]*\s*(\d(?:\.\d)?)")


def interp_bv(seq, sub):
    lo = seq[0]
    if sub <= lo[0]:
        return lo[1]
    for i in range(1, len(seq)):
        hi = seq[i]
        if sub <= hi[0]:
            f = (sub - lo[0]) / float(hi[0] - lo[0])
            return lo[1] + f * (hi[1] - lo[1])
        lo = hi
    return seq[-1][1]


def spect_ci(spect):
    """Estimated B-V from a published MK spectral type, or None.

    Returns None for anything without a class letter (so a blank or a bare
    'comp' string never turns into a colour), and for a white dwarf without a
    temperature subtype.
    """
    if not spect:
        return None
    s = spect.strip()
    if not s:
        return None
    up0 = s.upper()
    wd = WD_RE.match(up0)
    if not wd and up0.startswith("D") and up0[1:2] in ("A", "B", "C", "O", "Q",
                                                       "Z", "X", "V", "H"):
        # a white dwarf with no temperature subtype: the DA sequence spans
        # -0.3 to +0.6 and the letter alone does not pick a point on it. The
        # main-sequence table below must never be allowed to answer for it.
        return None
    if wd:
        # D<x><n>: n is 50400 / Teff by definition of the MK white-dwarf type
        n = ffloat(wd.group(1))
        if n is None or n <= 0:
            return None
        teff = 50400.0 / n
        if not (2000.0 <= teff <= 120000.0):
            return None
        return ballesteros_ci_from_teff(min(teff, 40000.0))
    m = SPECT_RE.search(s.upper())
    if not m:
        return None
    cls = m.group(1)
    sub = ffloat(m.group(2))
    lc = lum_class(s)
    if lc in ("Ia0", "Ia", "Iab", "Ib", "I"):
        seq = SPECT_BV["I"]
    elif lc in ("II", "III"):
        seq = SPECT_BV["III"]
    else:
        # V, IV, VI, VII and "no class stated" all read as the dwarf sequence:
        # it is where the overwhelming majority of unclassed stars sit, and the
        # giant sequence differs by less than 0.1 mag before type G.
        seq = SPECT_BV["V"]
    row = seq.get(cls)
    if row is None:
        row = SPECT_BV["V"].get(cls)
    if row is None:
        return None
    if sub is None:
        sub = 5.0        # the middle of the class, the convention for a bare 'A'
    return interp_bv(row, max(0.0, min(9.5, sub)))


def display_name(row):
    if row["proper"]:
        return row["proper"]
    bayer, flam, con = row.get("bayer", ""), row.get("flam", ""), row.get("con", "")
    if bayer and con:
        g = GREEK.get(bayer[:3])
        if g:
            sup = SUPER.get(bayer[3:4], "") if len(bayer) > 3 else ""
            return g + sup + " " + con
    if flam and con:
        return flam + " " + con
    if row.get("hip"):
        return "HIP " + row["hip"]
    if row.get("hd"):
        return "HD " + row["hd"]
    return "Star " + row["id"]


def mrt_data_lines(path):
    """Machine-readable-table rows: everything after the LAST all-dashes rule."""
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.read().split("\n")
    last = -1
    for i, l in enumerate(lines):
        if re.match(r"^-{10,}\s*$", l):
            last = i
    return [l for l in lines[last + 1:] if l.strip()]


# ---------------------------------------------------------------------------
# far tier (SD.far): named objects out across the galaxy, FLOAT records.
# The packed background format tops out at +/-16,383 ly; the hero maser sits at
# 66,562 ly and NGC 2419 at 288,552, so these cannot live there.
# ---------------------------------------------------------------------------
def far_record(name, ra_deg, dec_deg, d_ly, cls, note, approx=False):
    u = unit_from_radec(ra_deg, dec_deg)
    e = to_ecliptic((u[0] * d_ly, u[1] * d_ly, u[2] * d_ly))
    r = {"name": name, "x": round(e[0]), "y": round(e[1]), "z": round(e[2]),
         "dLy": round(d_ly), "cls": cls, "note": note}
    if approx:
        # renders as "about 200,000 light-years" (one significant figure): these
        # carry a depth or a published range, and three sig figs would fake precision
        r["approx"] = 1
    return r


CEPH_RANK = {"GCVS": 0, "OGLE-IV": 1, "OGLE-III": 1, "OGLE-II": 1}


def cepheid_name(survey, sid):
    if survey == "GCVS":
        return sid.replace("_", " ").strip()
    if survey.startswith("OGLE"):
        return sid.strip()
    return (survey + " " + sid).strip()


def build_cepheids(path):
    cands = []
    for l in mrt_data_lines(path):
        survey = l[0:11].strip()
        rank = CEPH_RANK.get(survey)
        if rank is None:
            # ZTF/Gaia rows carry only a bare source id or a coordinate string;
            # this tier is named destinations, so they are skipped rather than
            # relabelled with a designation nobody minted.
            continue
        sid = l[12:31].strip()
        glon = ffloat(l[52:62])
        glat = ffloat(l[63:73])
        d = ffloat(l[188:194])
        ed = ffloat(l[195:199])
        if glon is None or glat is None or d is None or ed is None:
            continue
        if not (FAR_CEPHEID_MIN_PC <= d <= FAR_HARD_CUT_PC):
            continue
        rel = ed / d
        if rel > FAR_CEPHEID_MAX_RELERR:
            continue
        cands.append((rank, rel, cepheid_name(survey, sid), glon, glat, d))
    # even spread: 24 longitude bins x 5 distance bins, round-robin so no corner
    # of the disc gets all of them
    bins = collections.defaultdict(list)
    for c in cands:
        key = (int(c[3] // 15.0), min(4, int((c[5] - FAR_CEPHEID_MIN_PC) / 4400.0)))
        bins[key].append(c)
    for k in bins:
        bins[k].sort(key=lambda c: (c[0], c[1], c[2]))
    order = sorted(bins.keys())
    out, depth = [], 0
    while len(out) < FAR_CEPHEID_TARGET:
        added = False
        for k in order:
            if depth < len(bins[k]):
                out.append(bins[k][depth])
                added = True
                if len(out) >= FAR_CEPHEID_TARGET:
                    break
        if not added:
            break
        depth += 1
    recs = []
    for rank, rel, name, glon, glat, d in sorted(out, key=lambda c: c[2]):
        ra, dec = radec_from_galactic(glon, glat)
        pct = max(1, int(round(rel * 100)))
        recs.append(far_record(name, ra, dec, d * LY_PER_PC, "cepheid",
                               "The distance is good to about " + str(pct) + " percent."))
    return recs, len(cands)


def build_masers(path):
    recs = []
    for l in mrt_data_lines(path):
        name = l[0:13].strip()
        plx = ffloat(l[62:67])
        eplx = ffloat(l[68:73])
        if not name or plx is None or eplx is None or plx <= 0:
            continue
        rel = eplx / plx
        if rel >= FAR_MASER_MAX_RELERR:
            continue
        d_pc = 1000.0 / plx
        if d_pc < FAR_MASER_MIN_PC or d_pc > FAR_HARD_CUT_PC:
            continue
        rah, ram, ras = ffloat(l[31:33]), ffloat(l[34:36]), ffloat(l[37:44])
        ded, dem, des = ffloat(l[47:49]), ffloat(l[50:52]), ffloat(l[53:59])
        if None in (rah, ram, ras, ded, dem, des):
            continue
        ra = (rah + ram / 60.0 + ras / 3600.0) * 15.0
        dec = ded + dem / 60.0 + des / 3600.0
        if l[46:47] == "-":
            dec = -dec
        alias = l[15:30].strip()
        pct = max(1, int(round(rel * 100)))
        note = ("The distance is a direct parallax, good to about " + str(pct) + " percent.")
        if alias:
            note = "Also catalogued as " + alias + ". " + note
        recs.append(far_record(name, ra, dec, d_pc * LY_PER_PC, "maser", note))
    recs.sort(key=lambda r: r["name"])
    return recs


# name -> (Baumgardt row key, SIMBAD J2000 RA/Dec in degrees, extra note, approx)
GLOBULARS = [
    ("47 Tucanae", "NGC_104", 6.022329, -72.081444, None, False),
    ("Omega Centauri", "NGC_5139", 201.697000, -47.479472, None, False),
    ("M4", "NGC_6121", 245.896750, -26.525750, None, False),
    ("M13", "NGC_6205", 250.423475, 36.461319, None, False),
    ("M22", "NGC_6656", 279.099750, -23.904750, None, False),
    ("M15", "NGC_7078", 322.493042, 12.167000, None, False),
    ("NGC 2419", "NGC_2419", 114.535458, 38.881917,
     " Published values run from about 269,000 to 300,000 light-years.", True),
]


def build_globulars(path):
    kpc = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.split()
            if len(parts) < 5:
                continue
            v = ffloat(parts[3])
            if v is not None:
                kpc[parts[0]] = v
    recs = []
    for name, key, ra, dec, extra, approx in GLOBULARS:
        assert key in kpc, "Baumgardt & Vasiliev table is missing " + key
        note = "Distance from Baumgardt and Vasiliev 2021." + (extra or "")
        recs.append(far_record(name, ra, dec, kpc[key] * 1000.0 * LY_PER_PC,
                               "globular", note, approx))
    return recs, kpc


def build_marquee():
    return [
        far_record("Sagittarius A*", 266.416817, -29.007825, 8275.0 * LY_PER_PC, "bh",
                   "Distance from the GRAVITY Collaboration 2021, measured by tracking "
                   "stars in orbit around it."),
        far_record("Large Magellanic Cloud", 80.894167, -69.756111,
                   49590.0 * LY_PER_PC, "galaxy",
                   "Distance from Pietrzynski and colleagues 2019, measured with "
                   "eclipsing binary stars."),
        far_record("Small Magellanic Cloud", 13.158333, -72.800278,
                   62440.0 * LY_PER_PC, "galaxy",
                   "Distance from Graczyk and colleagues 2020. It is roughly 20,000 "
                   "light-years deep along our line of sight, so a single distance is "
                   "a convenience.", True),
    ]


# ---------------------------------------------------------------------------
def main():
    fresh = "--fresh" in sys.argv
    (athyg_path, exo_path, athyg_version, sk_path, rd_path, bv_path,
     hyg_path, hyg_version) = ensure_data(fresh)
    hyg_ci = load_hyg_ci(hyg_path)
    print("HYG colour-index fallback:", len(hyg_ci), "measured B-V values",
          ("from HYG " + hyg_version) if hyg_path else "(source unavailable)",
          flush=True)

    # ---------------- exoplanets (first: the host positions steer the AT-HYG pass) ----
    hosts = {}  # hostname -> {host fields, planets: []}
    n_exo_rows = 0
    with open(exo_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            n_exo_rows += 1
            dist_pc = ffloat(row["sy_dist"])
            host = row["hostname"].strip()
            if dist_pc is None or not host:
                continue
            if dist_pc > 20.5 and host not in FAMOUS:
                continue
            host = RENAME_HOST.get(host, host)
            ra = ffloat(row["ra"])
            dec = ffloat(row["dec"])
            if ra is None or dec is None:
                continue
            h = hosts.setdefault(host, {
                "ra_deg": ra, "dec": dec, "dist_ly": dist_pc * LY_PER_PC,
                "vmag": None, "teff": None, "loglum": None, "spectype": "",
                "planets": [],
            })
            if h["vmag"] is None:
                h["vmag"] = ffloat(row["sy_vmag"])
            if h["teff"] is None:
                h["teff"] = ffloat(row["st_teff"])
            if h["loglum"] is None:
                h["loglum"] = ffloat(row["st_lum"])  # log10(L/Lsun)
            if not h["spectype"]:
                h["spectype"] = (row["st_spectype"] or "").strip()
            try:
                year = int(row["disc_year"])
            except (TypeError, ValueError):
                year = None
            pl_name = row["pl_name"].strip()
            for old, new in RENAME_HOST.items():
                if pl_name.startswith(old + " "):
                    pl_name = new + pl_name[len(old):]
            h["planets"].append({
                "name": pl_name,
                "per": ffloat(row["pl_orbper"]),
                "a": ffloat(row["pl_orbsmax"]),
                "rade": ffloat(row["pl_rade"]),
                "masse": ffloat(row["pl_bmasse"]),
                "eqt": ffloat(row["pl_eqt"]),
                "year": year,
                "method": (row["discoverymethod"] or "").strip(),
            })
    print("exoplanet rows:", n_exo_rows, "| kept hosts:", len(hosts),
          "| kept planets:", sum(len(h["planets"]) for h in hosts.values()), flush=True)
    missing_famous = [n for n in FAMOUS if RENAME_HOST.get(n, n) not in hosts]
    if missing_famous:
        print("WARNING: famous hosts not found in archive:", missing_famous, flush=True)

    # ---------------- AT-HYG: ONE streaming pass -------------------------------
    # 2.56 M rows. Nothing here holds the whole catalog: the navigable candidate
    # pool is filtered on the way past, and the two background bands are bounded
    # heaps that keep only the brightest N seen so far.
    t0 = time.time()
    MERGE_MAX_MAG = 9.0     # deep enough for the KELT-9 class of host merge
    MERGE_MAX_LY = 5000.0
    pool = []               # navigable candidates + the host-merge pool
    heap_near, heap_far = [], []
    # room for the navigable tier to be subtracted out again after selection
    near_room = BG_NEAR_CAP + NAV_CAP + 4000
    far_room = BG_FAR_CAP + NAV_CAP + 4000
    dsrc = collections.Counter()
    cisrc = collections.Counter()   # COLOUR INDEX rule, per source, all tiers
    seq = 0
    n_rows = 0
    with gzip.open(athyg_path, "rt", encoding="utf-8", newline="") as f:
        rd = csv.reader(f)
        hdr = next(rd)
        IX = {k: i for i, k in enumerate(hdr)}
        for col in ("id", "hyg", "hip", "hd", "proper", "bayer", "flam", "con", "ra",
                    "dec", "dist", "mag", "absmag", "ci", "spect", "dist_src"):
            assert col in IX, "AT-HYG is missing the column " + col
        iId, iHyg, iHip, iHd = IX["id"], IX["hyg"], IX["hip"], IX["hd"]
        iProp, iBay, iFlam, iCon = IX["proper"], IX["bayer"], IX["flam"], IX["con"]
        iRa, iDec, iDist, iMag = IX["ra"], IX["dec"], IX["dist"], IX["mag"]
        iAbs, iCi, iSp, iDs = IX["absmag"], IX["ci"], IX["spect"], IX["dist_src"]

        def colour_index(row, spect):
            """The three-source B-V rule from the module docstring. Returns
            (ci or None, source tag)."""
            c = ffloat(row[iCi])
            if c is not None:
                return c, "athyg"
            key = row[iHyg].strip()
            if key:
                c = hyg_ci.get(key)
                if c is not None:
                    return c, "hyg"
            c = spect_ci(spect)
            if c is not None:
                return c, "spect"
            return None, "none"

        for row in rd:
            n_rows += 1
            dist_pc = ffloat(row[iDist])
            # dist >= 99999 is AT-HYG's "no usable parallax" sentinel (it lists
            # Mu Sagittarii, a ~3,000 ly star, at 326,000 ly). Load-bearing guard.
            if dist_pc is None or dist_pc <= 0.001 or dist_pc >= 99999:
                continue
            mag = ffloat(row[iMag])
            ra_h = ffloat(row[iRa])
            dec = ffloat(row[iDec])
            if mag is None or ra_h is None or dec is None:
                continue
            proper = row[iProp].strip()
            if proper == "Sol":
                continue  # the Sun is the origin, not a destination
            dist_ly = dist_pc * LY_PER_PC
            if dist_ly > NAV_MAX_LY and dist_ly > BG_FAR_MAX_LY:
                continue
            absmag = ffloat(row[iAbs])
            dsrc[row[iDs]] += 1
            seq += 1
            luminous = (absmag is not None and absmag <= NAV_LUM_ABSMAG
                        and NAV_LUM_MIN_LY <= dist_ly <= NAV_MAX_LY)
            spect = row[iSp].strip()
            ci, ci_src = colour_index(row, spect)
            cisrc[ci_src] += 1
            if (mag <= 7.0 or proper or luminous
                    or (mag <= MERGE_MAX_MAG and dist_ly <= MERGE_MAX_LY)):
                pool.append({
                    "id": row[iId], "hip": row[iHip], "hd": row[iHd],
                    "proper": proper, "bayer": row[iBay], "flam": row[iFlam],
                    "con": row[iCon], "ra_deg": ra_h * 15.0, "dec": dec,
                    "dist_ly": dist_ly, "mag": mag, "absmag": absmag,
                    "spect": spect, "ci": ci, "ci_src": ci_src,
                    "luminous": luminous,
                })
            # background bands: bounded max-heaps on apparent magnitude
            rec = (-mag, seq, row[iId], ra_h * 15.0, dec, dist_ly, ci)
            if dist_ly <= BG_NEAR_MAX_LY:
                if len(heap_near) < near_room:
                    heapq.heappush(heap_near, rec)
                elif rec[0] > heap_near[0][0]:
                    heapq.heapreplace(heap_near, rec)
            elif dist_ly <= BG_FAR_MAX_LY:
                if len(heap_far) < far_room:
                    heapq.heappush(heap_far, rec)
                elif rec[0] > heap_far[0][0]:
                    heapq.heapreplace(heap_far, rec)
    print("AT-HYG rows:", n_rows, "| candidate pool:", len(pool),
          "| bg near/far pools:", len(heap_near), "/", len(heap_far),
          "| %.0fs" % (time.time() - t0), flush=True)
    print("colour index over every in-range row: %d from AT-HYG, %d recovered from "
          "HYG, %d estimated from a spectral type, %d left null"
          % (cisrc["athyg"], cisrc["hyg"], cisrc["spect"], cisrc["none"]), flush=True)
    assert n_rows > 2000000, "AT-HYG row count looks wrong: " + str(n_rows)

    for s in pool:
        s["u"] = unit_from_radec(s["ra_deg"], s["dec"])

    # ---------------- merge hosts onto AT-HYG ----------------
    # 0.1 deg: wide enough that catalog-epoch drift (e.g. a Gaia refresh moving
    # high-proper-motion stars like Barnard's) cannot split a real match; the
    # 15% distance gate is what prevents false merges at this sky density.
    # Declination bucketing keeps this off the O(hosts x rows) path.
    COS_LIM = math.cos(math.radians(0.1))
    dec_bucket = collections.defaultdict(list)
    for s in pool:
        dec_bucket[int(math.floor(s["dec"] * 5.0))].append(s)
    for name, h in hosts.items():
        hu = unit_from_radec(h["ra_deg"], h["dec"])
        b0 = int(math.floor(h["dec"] * 5.0))
        best, bestdot = None, COS_LIM
        for b in (b0 - 1, b0, b0 + 1):
            for s in dec_bucket.get(b, ()):
                d = s["u"][0] * hu[0] + s["u"][1] * hu[1] + s["u"][2] * hu[2]
                if d > bestdot:
                    rel = abs(s["dist_ly"] - h["dist_ly"]) / max(h["dist_ly"], 1e-9)
                    if rel < 0.15:
                        best, bestdot = s, d
        h["hygstar"] = best
        if best is not None:
            best["host_of"] = name

    for probe in ("Proxima Cen", "tau Cet", "eps Eri", "Barnard's star"):
        if probe in hosts:
            assert hosts[probe]["hygstar"] is not None, probe + " failed to merge onto AT-HYG"
    if "TRAPPIST-1" in hosts:
        assert hosts["TRAPPIST-1"]["hygstar"] is None, "TRAPPIST-1 unexpectedly merged"

    # ---------------- select the navigable tier ----------------
    # mandatory: named stars, exoplanet hosts, and the luminous distant tier
    # (absmag <= -4 between 1 and 5 kpc: the blue supergiants and Wolf-Rayet
    # stars, which is the only honest way this catalog reaches past 3,000 ly).
    # Then the naked-eye set, then brightest-first up to the cap.
    sel, taken = [], set()

    def take(s):
        if s["id"] in taken or s["dist_ly"] > NAV_MAX_LY:
            return
        taken.add(s["id"])
        sel.append(s)

    for s in pool:
        if s["proper"] or "host_of" in s or s["luminous"]:
            take(s)
    n_mandatory = len(sel)
    rest = sorted((s for s in pool if s["id"] not in taken), key=lambda s: (s["mag"], s["id"]))
    fill_limit = 0.0
    for s in rest:
        if len(sel) >= NAV_CAP:
            break
        before = len(sel)
        take(s)
        if len(sel) > before:
            fill_limit = s["mag"]
    n_lum = sum(1 for s in sel if s["luminous"])
    print("navigable: %d stars (%d mandatory, %d luminous-distant; the brightness fill "
          "reaches mag %.2f)" % (len(sel), n_mandatory, n_lum, fill_limit), flush=True)

    # display names + collision suffixes (alpha Cen A/B share a Bayer designation)
    for s in sel:
        s["name"] = display_name(s)
    groups = {}
    for s in sel:
        groups.setdefault(s["name"], []).append(s)
    for name, g in groups.items():
        if len(g) > 1:
            g.sort(key=lambda s: (s["mag"], s["id"]))
            for i, s in enumerate(g):
                s["name"] = name + " " + chr(65 + i)  # " A", " B", ...

    stars = {"name": [], "x": [], "y": [], "z": [], "mag": [], "absmag": [],
             "ci": [], "sp": [], "lc": [], "hip": [], "teff": [], "lum": []}
    index_of = {}

    def push_star(name, ra_deg, dec, dist_ly, mag, absmag, ci, sp, lc, hip,
                  teff=None, lum=None):
        u = unit_from_radec(ra_deg, dec)
        e = to_ecliptic((u[0] * dist_ly, u[1] * dist_ly, u[2] * dist_ly))
        stars["name"].append(name)
        stars["x"].append(rel_round(e[0]))
        stars["y"].append(rel_round(e[1]))
        stars["z"].append(rel_round(e[2]))
        stars["mag"].append(round(mag, 2) if mag is not None else 99)
        stars["absmag"].append(round(absmag, 2) if absmag is not None else None)
        stars["ci"].append(round(ci, 3) if ci is not None else None)
        stars["sp"].append(sp)
        stars["lc"].append(lc)
        stars["hip"].append(int(hip) if hip else 0)
        # archive-measured host physicals (accurate where it matters: the HZ
        # chips and the size line only ever apply to planet hosts)
        stars["teff"].append(int(round(teff)) if teff else None)
        stars["lum"].append(round(lum, 5) if lum is not None else None)
        return len(stars["name"]) - 1

    def host_phys(h):
        lum = None
        if h["loglum"] is not None and -8 < h["loglum"] < 8:
            lum = 10.0 ** h["loglum"]
        return h["teff"], lum

    sel.sort(key=lambda s: (s["mag"], s["id"]))
    ci_used = collections.Counter()
    for s in sel:
        ci_used[s["ci_src"]] += 1
        teff, lum = (None, None)
        if "host_of" in s:
            teff, lum = host_phys(hosts[s["host_of"]])
        idx = push_star(s["name"], s["ra_deg"], s["dec"], s["dist_ly"], s["mag"],
                        s["absmag"], s["ci"], spect_letter(s["spect"], None),
                        lum_class(s["spect"]), s["hip"], teff, lum)
        index_of[s["id"]] = idx

    appended, host_idx = 0, {}
    for name, h in sorted(hosts.items()):
        if h["hygstar"] is not None:
            continue
        dist_pc = h["dist_ly"] / LY_PER_PC
        absmag = None
        if h["vmag"] is not None:
            absmag = h["vmag"] - 5.0 * math.log10(max(dist_pc, 0.001) / 10.0)
        ci = ballesteros_ci_from_teff(h["teff"]) if h["teff"] else None
        teff, lum = host_phys(h)
        host_idx[name] = push_star(
            name, h["ra_deg"], h["dec"], h["dist_ly"], h["vmag"], absmag, ci,
            spect_letter(h["spectype"], h["teff"]), lum_class(h["spectype"]), 0,
            teff, lum)
        appended += 1
        ci_used["teff" if ci is not None else "none"] += 1
    print("stars:", len(stars["name"]), f"({appended} appended exoplanet hosts)", flush=True)
    print("navigable colour index by source:",
          ", ".join(k + " " + str(v) for k, v in ci_used.most_common()), flush=True)

    # ---------------- planets ----------------
    def star_index_for(hostname):
        h = hosts[hostname]
        if h["hygstar"] is not None:
            return index_of[h["hygstar"]["id"]]
        # never .index(): a catalog star could carry the same display name and
        # would silently steal the planets
        return host_idx[hostname]

    planets = {"host": [], "name": [], "per": [], "a": [], "rade": [], "masse": [],
               "eqt": [], "year": [], "method": []}
    rows = []
    for name, h in hosts.items():
        si = star_index_for(name)
        for p in h["planets"]:
            rows.append((si, p["a"] if p["a"] is not None else 1e9, p))
    rows.sort(key=lambda r: (r[0], r[1]))
    for si, _, p in rows:
        planets["host"].append(si)
        planets["name"].append(p["name"])
        planets["per"].append(round(p["per"], 3) if p["per"] is not None else None)
        planets["a"].append(round(p["a"], 4) if p["a"] is not None else None)
        planets["rade"].append(round(p["rade"], 2) if p["rade"] is not None else None)
        planets["masse"].append(round(p["masse"], 2) if p["masse"] is not None else None)
        planets["eqt"].append(int(p["eqt"]) if p["eqt"] is not None else None)
        planets["year"].append(p["year"])
        planets["method"].append(p["method"])

    # ---------------- the far tier ----------------
    cepheids, n_ceph_cand = build_cepheids(sk_path)
    masers = build_masers(rd_path)
    globulars, bv_kpc = build_globulars(bv_path)
    far = cepheids + masers + globulars + build_marquee()
    far.sort(key=lambda r: r["dLy"])
    print("far tier: %d objects (%d Cepheids of %d candidates, %d masers, %d globulars,"
          " %d marquee)" % (len(far), len(cepheids), n_ceph_cand, len(masers),
                            len(globulars), 3), flush=True)

    # ---------------- self-checks (hard asserts) ----------------
    def find(name):
        return stars["name"].index(name)

    def dist_of(i):
        return math.sqrt(stars["x"][i] ** 2 + stars["y"][i] ** 2 + stars["z"][i] ** 2)

    def ang(i, j):
        di, dj = dist_of(i), dist_of(j)
        dot = (stars["x"][i] * stars["x"][j] + stars["y"][i] * stars["y"][j] +
               stars["z"][i] * stars["z"][j]) / (di * dj)
        return math.degrees(math.acos(max(-1.0, min(1.0, dot))))

    n = len(stars["name"])
    assert 9000 <= n <= 11500, f"star count {n} outside the sanity band"
    assert abs(dist_of(find("Sirius")) - 8.6) < 0.15, "Sirius distance"
    assert abs(dist_of(find("Proxima Centauri")) - 4.25) < 0.06, "Proxima distance"
    assert abs(dist_of(find("Vega")) - 25.0) < 0.4, "Vega distance"
    find("Polaris")
    assert abs(ang(find("Dubhe"), find("Merak")) - 5.37) < 0.4, "Dubhe-Merak angle"
    assert abs(ang(find("Betelgeuse"), find("Rigel")) - 18.6) < 0.6, "Betelgeuse-Rigel angle"
    ri = find("Regulus")
    beta = math.degrees(math.asin(stars["z"][ri] / dist_of(ri)))
    assert abs(beta) < 1.5, f"Regulus ecliptic latitude {beta:.2f} (frame rotation bug?)"
    t1 = find("TRAPPIST-1")
    assert planets["host"].count(t1) == 7, "TRAPPIST-1 planet count"
    for k in ("x", "y", "z", "mag"):
        assert all(v is not None and math.isfinite(v) for v in stars[k]), k + " has bad values"
    assert all(0 <= h < n for h in planets["host"]), "planet host index out of range"
    assert max(dist_of(i) for i in range(n)) <= NAV_MAX_LY + 1, "a star escaped the 16,000 ly cut"
    assert len(set(stars["name"])) == n, "duplicate star names"
    # archive physicals present + sane for the marquee HZ hosts (the page's
    # habitable-zone math uses these directly)
    toi = find("TOI-700")
    assert stars["lum"][toi] is not None and 0.010 <= stars["lum"][toi] <= 0.025, \
        "TOI-700 luminosity"
    assert stars["teff"][toi] and 3300 <= stars["teff"][toi] <= 3650, "TOI-700 teff"
    bar = find("Barnard's Star") if "Barnard's Star" in stars["name"] else \
        find("Barnard's star")
    assert stars["sp"][bar] == "M", "Barnard spect letter (sdM4 prefix parsing)"
    assert stars["lc"][find("Vega")] == "V", "Vega luminosity class"
    assert stars["lc"][find("Betelgeuse")] in ("Ia", "Iab", "Ib", "I"), \
        "Betelgeuse luminosity class: " + str(stars["lc"][find("Betelgeuse")])
    n_lc = sum(1 for v in stars["lc"] if v)
    assert n_lc > n * 0.2, "luminosity classes look unparsed (%d of %d)" % (n_lc, n)

    # ---- COLOUR INDEX (the wave-5 regression: AT-HYG v4.0 ships a blank ci for
    # the brightest stars in the sky, which cost their cards a temperature and a
    # width and left the GL star surface unable to render them at all) ----
    def teff_of(i):
        c = stars["ci"][i]
        if c is None:
            return None
        return 4600.0 * (1.0 / (0.92 * c + 1.7) + 1.0 / (0.92 * c + 0.62))

    # mirrors voyage-astro.js bcFromTeff / lumBol / starRadiusSun so the Vega
    # bar below is the SAME arithmetic the page and t8-stars.js run
    BC_KNOTS = ((2600, -4.0), (3000, -3.9), (3500, -3.7), (4000, -1.2),
                (5000, 0.0), (7000, 0.0), (8000, -0.1), (15000, -1.0), (30000, -3.0))

    def bc_teff(T):
        if not T > BC_KNOTS[0][0]:
            return BC_KNOTS[0][1]
        if T >= BC_KNOTS[-1][0]:
            return BC_KNOTS[-1][1]
        for i in range(1, len(BC_KNOTS)):
            if T <= BC_KNOTS[i][0]:
                f = (T - BC_KNOTS[i - 1][0]) / float(BC_KNOTS[i][0] - BC_KNOTS[i - 1][0])
                return BC_KNOTS[i - 1][1] + f * (BC_KNOTS[i][1] - BC_KNOTS[i - 1][1])
        return BC_KNOTS[-1][1]

    NAKED_EYE_CI = [
        "Sirius", "Vega", "Rigil Kentaurus", "Arcturus", "Capella", "Procyon",
        "Hadar", "Capella B", "Toliman", "Castor", "Alsephina", "Dubhe",
        "Alhena", "Avior", "Mintaka", "Castor B", "Sabik B",
    ]

    def find_ci_star(nm):
        # collision suffixes: AT-HYG lists two rows called "Sabik B", so the
        # brighter one ships as "Sabik B A"
        if nm in stars["name"]:
            return stars["name"].index(nm)
        return find(nm + " A")

    for nm in NAKED_EYE_CI:
        i = find_ci_star(nm)
        c = stars["ci"][i]
        assert c is not None and math.isfinite(c) and -0.5 <= c <= 3.0, \
            nm + " has no colour index (" + repr(c) + "). AT-HYG ships these " \
            "blank; if the HYG fallback source did not load, that is the cause."
        t = teff_of(i)
        assert 1500.0 <= t <= 45000.0, nm + " temperature %.0f K is not sane" % t
    # Sirius is an A0/A1 star: 9,940 K on this catalog's own B-V
    tsir = teff_of(find("Sirius"))
    assert 9500.0 <= tsir <= 10500.0, "Sirius teff %.0f K" % tsir
    # Vega: A0 V, absmag 0.58, so sqrt(L) * (5772/T)^2 must land near 2.4 Rsun
    ivg = find("Vega")
    tvg = teff_of(ivg)
    lvg = 10.0 ** (0.4 * (4.74 - (stars["absmag"][ivg] + bc_teff(tvg))))
    rvg = math.sqrt(lvg) * (5772.0 / tvg) ** 2
    assert 2.0 <= rvg <= 3.0, "Vega radius %.2f Rsun (T=%.0f L=%.1f)" % (rvg, tvg, lvg)

    n_ci_null = sum(1 for v in stars["ci"] if v is None)
    print("navigable colour index: %d of %d stars carry one; %d have no measured "
          "colour, no HYG cross-reference and no spectral type"
          % (n - n_ci_null, n, n_ci_null), flush=True)
    if n_ci_null:
        print("  still colourless: " + ", ".join(
            stars["name"][i] for i in range(n) if stars["ci"][i] is None), flush=True)
    # the regression bar: the pre-swap HYG build shipped 30 colourless stars out
    # of 5,240, all of them unphotometered components of bright multiples.
    assert n_ci_null <= 40, "too many colourless stars: " + str(n_ci_null)

    # the galactic frame the Cepheid catalog is quoted in
    gra, gdec = radec_from_galactic(0.0, 0.0)
    assert abs(gra - 266.405) < 0.02 and abs(gdec + 28.936) < 0.02, \
        "galactic to equatorial frame is wrong: %.3f %.3f" % (gra, gdec)

    def far_by(name):
        for r in far:
            if r["name"] == name:
                return r
        raise AssertionError("far tier is missing " + name)

    hero = far_by("G007.47+00.05")
    assert 66000 <= hero["dLy"] <= 67200, "BeSSeL hero distance " + str(hero["dLy"])
    assert abs(far_by("Sagittarius A*")["dLy"] - 26990) < 60, "Sgr A* distance"
    assert abs(far_by("Large Magellanic Cloud")["dLy"] - 161741) < 400, "LMC distance"
    assert abs(far_by("Small Magellanic Cloud")["dLy"] - 203652) < 600, "SMC distance"
    assert abs(far_by("NGC 2419")["dLy"] - 288552) < 800, "NGC 2419 distance"
    assert abs(far_by("47 Tucanae")["dLy"] - 14742) < 60, "47 Tuc distance"
    assert abs(far_by("M4")["dLy"] - 6034) < 40, "M4 distance"
    assert max(r["dLy"] for r in far if r["cls"] == "cepheid") <= FAR_HARD_CUT_PC * LY_PER_PC, \
        "a Cepheid escaped the 25 kpc hard cut"
    assert len(cepheids) >= 200 and len(masers) >= 40, "far tier is too thin"
    assert len(set(r["name"] for r in far)) == len(far), "duplicate far-tier names"
    for r in far:
        assert all(math.isfinite(r[k]) for k in ("x", "y", "z", "dLy")), r["name"]
        assert r["cls"] in ("cepheid", "maser", "bh", "globular", "galaxy"), r["cls"]
        assert abs(math.sqrt(r["x"] ** 2 + r["y"] ** 2 + r["z"] ** 2) - r["dLy"]) < 2.0, \
            "far position does not match dLy: " + r["name"]
    # the far tier must not restate a navigable star
    nav_names = set(stars["name"])
    assert not (nav_names & set(r["name"] for r in far)), "far tier collides with a star name"
    print("self-checks passed:", n, "stars,", len(planets["name"]), "planets,",
          len(far), "far objects", flush=True)

    # ---------------- write voyage-data.js ----------------
    generated = time.strftime("%Y-%m-%d")
    data = {
        "meta": {
            "generated": generated,
            "hyg": athyg_version, "starCount": n, "planetCount": len(planets["name"]),
            "farCount": len(far), "maxLy": int(NAV_MAX_LY),
            "distSrc": dict(dsrc.most_common()),
        },
        "stars": stars,
        "planets": planets,
        "far": far,
    }
    js = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    header = (
        "/* voyage-data.js -- GENERATED by make_voyage_data.py, do not edit by hand.\n"
        "   Star data: MODIFIED from the AT-HYG (Augmented Tycho-HYG) database "
        + athyg_version + ",\n"
        "   (c) David Nash, astronexus.com, licensed CC BY-SA 4.0\n"
        "   (https://creativecommons.org/licenses/by-sa/4.0/). Modifications: filtered\n"
        "   to the naked-eye set plus every proper-named star, every exoplanet host and\n"
        "   the luminous stars between 1 and 5 kpc, hard-cut at " + str(int(NAV_MAX_LY)) + " light-years,\n"
        "   merged with NASA host physicals, and converted to ecliptic J2000 xyz\n"
        "   light-years. The star arrays in this file are that modified subset and\n"
        "   carry the same CC BY-SA 4.0 license. Distances are 1/parallax as published\n"
        "   (mostly Gaia DR3; dist_src mix " + ", ".join(k + " " + str(v) for k, v in dsrc.most_common(3)) + "),\n"
        "   which runs 5 to 15 percent long past a few thousand light-years.\n"
        "   Colour index (ci, Johnson B-V), three sources in priority order:\n"
        "     " + str(ci_used["athyg"]) + " from AT-HYG's own ci column;\n"
        "     " + str(ci_used["hyg"]) + " recovered from HYG " + str(hyg_version or "-") +
        " (same author, same license, joined on\n"
        "       AT-HYG's own hyg cross-reference id) because AT-HYG leaves ci blank\n"
        "       wherever Tycho has VT but no BT, which is the brightest stars in the\n"
        "       sky including Sirius, Vega, Capella, Arcturus and Procyon;\n"
        "     " + str(ci_used["spect"]) + " ESTIMATED from a published MK spectral type through the standard\n"
        "       intrinsic-colour sequences (Pecaut & Mamajek 2013 for dwarfs, Johnson\n"
        "       1966 for giants and supergiants), used only where no catalog carries a\n"
        "       measured colour;\n"
        "     " + str(ci_used["teff"]) + " derived from the NASA archive's measured st_teff (exoplanet hosts\n"
        "       that are not in AT-HYG at all);\n"
        "     " + str(ci_used["none"]) + " left null: unphotometered components of bright multiples with no\n"
        "       spectral type either. Nothing is invented for those.\n"
        "   Exoplanet data: NASA Exoplanet Archive (pscomppars), snapshot " + generated + ".\n"
        "   Far tier (VOYAGE_DATA.far), named objects across the galaxy, one record per\n"
        "   object as {name, x, y, z, dLy, cls, note} with an optional approx:1 flag\n"
        "   meaning the distance carries a depth or a published range and must be shown\n"
        "   to one significant figure. Sources, none NonCommercial:\n"
        "     cls 'cepheid'  Skowron et al. 2024, ApJS 278, 57 (mid-infrared Cepheids)\n"
        "     cls 'maser'    Reid et al. 2019, ApJ 885, 131 (BeSSeL VLBI parallaxes)\n"
        "     cls 'globular' Baumgardt & Vasiliev 2021, MNRAS 505, 5957\n"
        "     cls 'bh'       GRAVITY Collaboration 2021, A&A 647, A59 (Sagittarius A*)\n"
        "     cls 'galaxy'   Pietrzynski et al. 2019, Nature 567, 200 (LMC);\n"
        "                    Graczyk et al. 2020, ApJ 904, 13 (SMC)\n"
        "   This research has made use of the SIMBAD database, CDS, Strasbourg\n"
        "   Astronomical Observatory, France (Wenger et al. 2000, A&AS 143, 9), for the\n"
        "   marquee coordinates. */\n"
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("(typeof self !== 'undefined' ? self : globalThis).VOYAGE_DATA = ")
        f.write(js)
        f.write(";\n")
    print("wrote", OUT, f"({os.path.getsize(OUT)/1024:.0f} KB)", flush=True)

    # ---------------- background tier (voyage-bg.js), TWO packed bands ----------
    picked_ids = set(index_of.keys())

    def pack_band(heap, cap, scale, max_ly):
        rows = sorted(heap, key=lambda r: (-r[0], r[1]))   # brightest first
        buf = bytearray()
        kept = 0
        lim = 32767
        for negmag, _seq, sid, ra_deg, dec, dist_ly, ci in rows:
            if kept >= cap:
                break
            if sid in picked_ids or dist_ly > max_ly:
                continue
            u = unit_from_radec(ra_deg, dec)
            e = to_ecliptic((u[0] * dist_ly, u[1] * dist_ly, u[2] * dist_ly))
            xi = int(round(e[0] * scale))
            yi = int(round(e[1] * scale))
            zi = int(round(e[2] * scale))
            if max(abs(xi), abs(yi), abs(zi)) > lim:
                continue
            m10 = max(0, min(255, int(round((-negmag) * 10))))
            c100 = 255 if ci is None else max(0, min(254, int(round(ci * 100)) + 50))
            buf += struct.pack("<hhhBB", xi, yi, zi, m10, c100)
            kept += 1
        kept -= kept % BG_BLOCK      # keep the base64 payload padding-free
        return kept, bytes(buf[:kept * 8])

    n_near, buf_near = pack_band(heap_near, BG_NEAR_CAP, BG_NEAR_SCALE, BG_NEAR_MAX_LY)
    n_far, buf_far = pack_band(heap_far, BG_FAR_CAP, BG_FAR_SCALE, BG_FAR_MAX_LY)
    assert n_near == BG_NEAR_CAP, "near background band came up short: " + str(n_near)
    assert n_far > 20000, "far background band came up short: " + str(n_far)
    for kept, buf in ((n_near, buf_near), (n_far, buf_far)):
        assert len(buf) % 3 == 0, "band payload is not padding-free: " + str(len(buf))
    # round-trip check on the first record of each band
    for kept, buf, scale in ((n_near, buf_near, BG_NEAR_SCALE), (n_far, buf_far, BG_FAR_SCALE)):
        x0, y0, z0, m0, c0 = struct.unpack_from("<hhhBB", buf, 0)
        assert abs(x0 / scale) <= 32767.0 / scale and 0 <= m0 <= 255
        assert len(buf) == kept * 8
    # 255 is the packed format's "no colour" sentinel; report the residue the
    # same way the navigable tier does
    bg_null = [sum(1 for i in range(kept) if buf[i * 8 + 7] == 255)
               for kept, buf in ((n_near, buf_near), (n_far, buf_far))]
    print("background colour index: %d of %d near-band stars and %d of %d far-band "
          "stars have no colour from any source"
          % (bg_null[0], n_near, bg_null[1], n_far), flush=True)
    bands = [
        {"n": n_near, "scale": BG_NEAR_SCALE,
         "b64": base64.b64encode(buf_near).decode("ascii")},
        {"n": n_far, "scale": BG_FAR_SCALE,
         "b64": base64.b64encode(buf_far).decode("ascii")},
    ]
    total = n_near + n_far
    bg_header = (
        "/* voyage-bg.js -- GENERATED by make_voyage_data.py, do not edit by hand.\n"
        "   A background tier of " + str(total) + " real stars (drawn, not clickable),\n"
        "   MODIFIED from the AT-HYG (Augmented Tycho-HYG) database " + athyg_version + ",\n"
        "   (c) David Nash, astronexus.com, licensed CC BY-SA 4.0\n"
        "   (https://creativecommons.org/licenses/by-sa/4.0/); this modified subset\n"
        "   (brightest-first, positions converted to ecliptic J2000 and quantized)\n"
        "   carries the same license. HYG is the near half of the same project.\n"
        "   TWO bands, each 8 bytes per star, little-endian, brightest first:\n"
        "   int16 x,y,z (ecliptic J2000 light-years x the band's own scale),\n"
        "   uint8 mag x10, uint8 ci x100+50 (255 = unknown). Colour indices follow\n"
        "   the same three-source rule as voyage-data.js: AT-HYG's ci, else HYG "
        + str(hyg_version or "-") + "'s\n"
        "   ci joined on the hyg cross-reference id, else an estimate from the\n"
        "   published MK spectral type, else the 255 sentinel.\n"
        "   band 0: " + str(n_near) + " stars, scale " + str(BG_NEAR_SCALE) +
        " (reach +/-4,095 ly, step 0.125 ly)\n"
        "   band 1: " + str(n_far) + " stars, scale " + str(BG_FAR_SCALE) +
        " (reach +/-16,383 ly, step 0.5 ly)\n"
        "   Each band is brightest-first on its own; a consumer that needs one\n"
        "   globally sorted list merge-sorts the two on magnitude. */\n"
    )
    with open(OUT_BG, "w", encoding="utf-8") as f:
        f.write(bg_header)
        f.write("(typeof self !== 'undefined' ? self : globalThis).VOYAGE_BG = ")
        f.write(json.dumps({"bands": bands, "n": total}, separators=(",", ":")))
        f.write(";\n")
    print("wrote", OUT_BG,
          f"({os.path.getsize(OUT_BG)/1024:.0f} KB, {total} background stars:"
          f" {n_near} near + {n_far} far)", flush=True)


if __name__ == "__main__":
    main()
