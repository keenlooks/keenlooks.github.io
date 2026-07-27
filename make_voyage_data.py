#!/usr/bin/env python3
"""
make_voyage_data.py -- builds assets/js/voyage-data.js for /voyage/ (Mission to Anywhere).

Sources (downloaded once into %LOCALAPPDATA%/Temp/voyagedata/, --fresh re-downloads):
  * HYG stellar database v4.x -- (c) David Nash, astronexus.com, CC BY-SA 4.0.
    The generated star arrays are a derivative work and inherit that license;
    the header written into voyage-data.js carries the attribution.
  * NASA Exoplanet Archive, Planetary Systems Composite Parameters (pscomppars),
    via the TAP sync endpoint.

Output: assets/js/voyage-data.js -- a window/worker/node-safe global VOYAGE_DATA with
flat parallel arrays: ~5-6k stars (naked-eye set + all proper-named + exoplanet hosts)
positioned in ECLIPTIC J2000 xyz light-years, plus every known planet within ~20 pc
and a short list of famous distant systems.

Run:  python -u make_voyage_data.py [--fresh]
The script hard-asserts a battery of astronomy anchors (Sirius/Proxima/Vega distances,
Big Dipper angular separations, Regulus on the ecliptic, TRAPPIST-1's seven planets)
and refuses to write the file if any fail.

It also writes assets/js/voyage-bg.js: a NON-interactive background tier of the
60,000 brightest remaining HYG stars, packed 8 bytes per star (int16 x,y,z ecliptic
light-years x8, uint8 mag x10, uint8 ci x100+50 with 255 = unknown) and base64-coded.
The page lazy-loads it after first paint purely to fill the sky with real stars.
"""

import csv
import json
import math
import os
import sys
import time
import urllib.request

CACHE = os.path.join(os.environ.get("LOCALAPPDATA", "/tmp"), "Temp", "voyagedata")
# The env var already points at ...\AppData\Local; the Temp segment lives under it.
if os.name == "nt":
    CACHE = os.path.join(os.environ["LOCALAPPDATA"], "Temp", "voyagedata")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "js", "voyage-data.js")
OUT_BG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "js", "voyage-bg.js")
BG_CAP = 60000
BG_SCALE = 8          # int16 = light-years * 8 -> +/-4095 ly reach

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
GREEK = {
    "Alp": "α", "Bet": "β", "Gam": "γ", "Del": "δ",
    "Eps": "ε", "Zet": "ζ", "Eta": "η", "The": "θ",
    "Iot": "ι", "Kap": "κ", "Lam": "λ", "Mu": "μ",
    "Nu": "ν", "Xi": "ξ", "Omi": "ο", "Pi": "π",
    "Rho": "ρ", "Sig": "σ", "Tau": "τ", "Ups": "υ",
    "Phi": "φ", "Chi": "χ", "Psi": "ψ", "Ome": "ω",
}
SUPER = {"1": "¹", "2": "²", "3": "³"}


def fetch(url, dest, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "voyage-data/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)


def hyg_header_ok(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        head = f.readline()
    return head.lstrip('"').startswith("id") and "hip" in head


def ensure_data(fresh):
    os.makedirs(CACHE, exist_ok=True)
    hyg = os.path.join(CACHE, "hyg.csv")
    ver_path = os.path.join(CACHE, "hyg.version")
    exo = os.path.join(CACHE, "exo.csv")
    if fresh or not os.path.exists(hyg) or os.path.getsize(hyg) < 1 << 20 \
            or not hyg_header_ok(hyg):
        for url, ver in HYG_URLS:
            try:
                print("downloading HYG:", url, flush=True)
                raw = os.path.join(CACHE, "hyg.download")
                fetch(url, raw)
                if url.endswith(".gz"):
                    import gzip
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
            raise SystemExit("could not download the HYG catalog from any mirror")
    hyg_version = "v4.x"
    if os.path.exists(ver_path):
        with open(ver_path) as vf:
            hyg_version = vf.read().strip() or "v4.x"
    if fresh or not os.path.exists(exo) or os.path.getsize(exo) < 1 << 18:
        print("downloading NASA Exoplanet Archive (pscomppars)...", flush=True)
        fetch(TAP, exo)
    return hyg, exo, hyg_version


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


def to_ecliptic(v):
    x, y, z = v
    return (x, math.cos(OBLIQ) * y + math.sin(OBLIQ) * z,
            -math.sin(OBLIQ) * y + math.cos(OBLIQ) * z)


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


def main():
    fresh = "--fresh" in sys.argv
    hyg_path, exo_path, hyg_version = ensure_data(fresh)

    # ---------------- HYG ----------------
    hyg = []
    with open(hyg_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["id"] == "0":
                continue  # the Sun is the origin, not a destination
            dist_pc = ffloat(row["dist"])
            mag = ffloat(row["mag"])
            ra_h = ffloat(row["ra"])
            dec = ffloat(row["dec"])
            if dist_pc is None or dist_pc <= 0 or dist_pc >= 99999:
                continue
            if mag is None or ra_h is None or dec is None:
                continue
            hyg.append({
                "id": row["id"], "hip": row["hip"], "hd": row["hd"],
                "proper": row["proper"].strip(), "bayer": row["bayer"],
                "flam": row["flam"], "con": row["con"], "comp": row["comp"],
                "ra_deg": ra_h * 15.0, "dec": dec, "dist_ly": dist_pc * LY_PER_PC,
                "mag": mag, "absmag": ffloat(row["absmag"]),
                "spect": row["spect"].strip(), "ci": ffloat(row["ci"]),
                "u": unit_from_radec(ra_h * 15.0, dec),
            })
    print("HYG usable rows:", len(hyg), flush=True)

    # ---------------- exoplanets ----------------
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

    # ---------------- merge hosts onto HYG ----------------
    # 0.1 deg: wide enough that catalog-epoch drift (e.g. a Gaia refresh moving
    # high-proper-motion stars like Barnard's) cannot split a real match; the
    # 15% distance gate is what prevents false merges at this sky density.
    COS_LIM = math.cos(math.radians(0.1))
    for name, h in hosts.items():
        hu = unit_from_radec(h["ra_deg"], h["dec"])
        best, bestdot = None, COS_LIM
        for s in hyg:
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
            assert hosts[probe]["hygstar"] is not None, probe + " failed to merge onto HYG"
    if "TRAPPIST-1" in hosts:
        assert hosts["TRAPPIST-1"]["hygstar"] is None, "TRAPPIST-1 unexpectedly merged"

    # ---------------- select stars ----------------
    sel = [s for s in hyg if s["mag"] <= 6.0 or s["proper"] or "host_of" in s]

    # display names + collision suffixes (alpha Cen A/B share a Bayer designation)
    for s in sel:
        s["name"] = display_name(s)
    groups = {}
    for s in sel:
        groups.setdefault(s["name"], []).append(s)
    for name, g in groups.items():
        if len(g) > 1:
            g.sort(key=lambda s: s["mag"])
            for i, s in enumerate(g):
                s["name"] = name + " " + chr(65 + i)  # " A", " B", ...

    stars = {"name": [], "x": [], "y": [], "z": [], "mag": [], "absmag": [],
             "ci": [], "sp": [], "hip": [], "teff": [], "lum": []}
    index_of = {}

    def push_star(name, ra_deg, dec, dist_ly, mag, absmag, ci, sp, hip,
                  teff=None, lum=None):
        u = unit_from_radec(ra_deg, dec)
        e = to_ecliptic((u[0] * dist_ly, u[1] * dist_ly, u[2] * dist_ly))
        stars["name"].append(name)
        stars["x"].append(round(e[0], 3))
        stars["y"].append(round(e[1], 3))
        stars["z"].append(round(e[2], 3))
        stars["mag"].append(round(mag, 2) if mag is not None else 99)
        stars["absmag"].append(round(absmag, 2) if absmag is not None else None)
        stars["ci"].append(round(ci, 3) if ci is not None else None)
        stars["sp"].append(sp)
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

    for s in sel:
        teff, lum = (None, None)
        if "host_of" in s:
            teff, lum = host_phys(hosts[s["host_of"]])
        idx = push_star(s["name"], s["ra_deg"], s["dec"], s["dist_ly"], s["mag"],
                        s["absmag"], s["ci"], spect_letter(s["spect"], None),
                        s["hip"], teff, lum)
        index_of[s["id"]] = idx

    appended = 0
    for name, h in sorted(hosts.items()):
        if h["hygstar"] is not None:
            continue
        dist_pc = h["dist_ly"] / LY_PER_PC
        absmag = None
        if h["vmag"] is not None:
            absmag = h["vmag"] - 5.0 * math.log10(max(dist_pc, 0.001) / 10.0)
        ci = ballesteros_ci_from_teff(h["teff"]) if h["teff"] else None
        teff, lum = host_phys(h)
        push_star(name, h["ra_deg"], h["dec"], h["dist_ly"], h["vmag"], absmag, ci,
                  spect_letter(h["spectype"], h["teff"]), 0, teff, lum)
        appended += 1
    print("stars:", len(stars["name"]), f"({appended} appended exoplanet hosts)", flush=True)

    # ---------------- planets ----------------
    def star_index_for(hostname):
        h = hosts[hostname]
        if h["hygstar"] is not None:
            return index_of[h["hygstar"]["id"]]
        return stars["name"].index(hostname)

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
    assert 4500 <= n <= 9000, f"star count {n} outside the sanity band"
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
    # archive physicals present + sane for the marquee HZ hosts (the page's
    # habitable-zone math uses these directly)
    toi = find("TOI-700")
    assert stars["lum"][toi] is not None and 0.010 <= stars["lum"][toi] <= 0.025, \
        "TOI-700 luminosity"
    assert stars["teff"][toi] and 3300 <= stars["teff"][toi] <= 3650, "TOI-700 teff"
    bar = find("Barnard's Star") if "Barnard's Star" in stars["name"] else \
        find("Barnard's star")
    assert stars["sp"][bar] == "M", "Barnard spect letter (sdM4 prefix parsing)"
    print("self-checks passed:", n, "stars,", len(planets["name"]), "planets", flush=True)

    # ---------------- write ----------------
    data = {
        "meta": {
            "generated": time.strftime("%Y-%m-%d"),
            "hyg": hyg_version, "starCount": n, "planetCount": len(planets["name"]),
        },
        "stars": stars,
        "planets": planets,
    }
    js = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    header = (
        "/* voyage-data.js -- GENERATED by make_voyage_data.py, do not edit by hand.\n"
        "   Star data: derived (filtered to the naked-eye set plus named stars and\n"
        "   exoplanet hosts, merged with NASA host data, and converted to ecliptic\n"
        "   J2000 xyz light-years) from the HYG database " + hyg_version + ",\n"
        "   (c) David Nash, astronexus.com, licensed CC BY-SA 4.0\n"
        "   (https://creativecommons.org/licenses/by-sa/4.0/). The star arrays in\n"
        "   this file are a modified subset and carry the same license.\n"
        "   Exoplanet data: NASA Exoplanet Archive (pscomppars), snapshot "
        + data["meta"]["generated"] + ". */\n"
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("(typeof self !== 'undefined' ? self : globalThis).VOYAGE_DATA = ")
        f.write(js)
        f.write(";\n")
    print("wrote", OUT, f"({os.path.getsize(OUT)/1024:.0f} KB)", flush=True)

    # ---------------- background tier (voyage-bg.js) ----------------
    import base64
    import struct
    picked_ids = set(index_of.keys())
    bg = [s for s in hyg if s["id"] not in picked_ids and s["dist_ly"] <= 4000
          and abs(s["mag"]) < 25]
    bg.sort(key=lambda s: s["mag"])
    bg = bg[:BG_CAP]
    buf = bytearray()
    kept = 0
    for s in bg:
        u = s["u"]
        e = to_ecliptic((u[0] * s["dist_ly"], u[1] * s["dist_ly"], u[2] * s["dist_ly"]))
        xi = int(round(e[0] * BG_SCALE))
        yi = int(round(e[1] * BG_SCALE))
        zi = int(round(e[2] * BG_SCALE))
        if max(abs(xi), abs(yi), abs(zi)) > 32700:
            continue
        m10 = max(0, min(255, int(round(s["mag"] * 10))))
        c100 = 255 if s["ci"] is None else max(0, min(254, int(round(s["ci"] * 100)) + 50))
        buf += struct.pack("<hhhBB", xi, yi, zi, m10, c100)
        kept += 1
    # round-trip check on the first record
    if kept:
        x0, y0, z0, m0, c0 = struct.unpack_from("<hhhBB", buf, 0)
        assert abs(x0 / BG_SCALE) <= 4095 and 0 <= m0 <= 255
    b64 = base64.b64encode(bytes(buf)).decode("ascii")
    bg_header = (
        "/* voyage-bg.js -- GENERATED by make_voyage_data.py, do not edit by hand.\n"
        "   A background tier of " + str(kept) + " real stars (drawn, not clickable),\n"
        "   derived from the HYG database " + hyg_version + ", (c) David Nash,\n"
        "   astronexus.com, licensed CC BY-SA 4.0\n"
        "   (https://creativecommons.org/licenses/by-sa/4.0/); this modified subset\n"
        "   carries the same license. 8 bytes per star, little-endian:\n"
        "   int16 x,y,z (ecliptic J2000 light-years x" + str(BG_SCALE) + "),\n"
        "   uint8 mag x10, uint8 ci x100+50 (255 = unknown). */\n"
    )
    with open(OUT_BG, "w", encoding="utf-8") as f:
        f.write(bg_header)
        f.write("(typeof self !== 'undefined' ? self : globalThis).VOYAGE_BG = ")
        f.write(json.dumps({"n": kept, "scale": BG_SCALE, "b64": b64},
                           separators=(",", ":")))
        f.write(";\n")
    print("wrote", OUT_BG,
          f"({os.path.getsize(OUT_BG)/1024:.0f} KB, {kept} background stars)", flush=True)


if __name__ == "__main__":
    main()
