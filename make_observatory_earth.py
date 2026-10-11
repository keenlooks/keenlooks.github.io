#!/usr/bin/env python
"""Generate assets/js/obs-earth-data.js for The Observatory (/observatory/).

Inputs (all fetched once by the verification round, kept as fixtures):
  1. Natural Earth 1:110m land polygons (public domain GeoJSON).
  2. NOAA NCEI World Magnetic Model WMM2025 coefficient file (WMM2025.COF).
  3. The official WMM2025 test values file (WMM2025_TestValues.txt).

Output: window.OBS_EARTH per section 3.5 of .claude/plans/plan-observatory-act1.md
(schema FROZEN): landRings(), regions, wmm, testWmm.

It also builds the bundled sky-and-surface assets of r12 and r13 (see the block
above build_textures for their sources and licences):
  images/obs/earth-day-2048.jpg    NASA GIBS Blue Marble, re-toned to the palette
  images/obs/earth-day-4096.jpg    the same, twice as wide, for the WebGL tier
  images/obs/earth-night-2048.jpg  NASA GIBS VIIRS city lights, one channel
  images/obs/stars-8k.bin          the brightest 8,000 stars of AT-HYG v4.0

Usage:
  python make_observatory_earth.py
  python make_observatory_earth.py --fetch          # re-download the Natural Earth land file
  python make_observatory_earth.py --tol 0.08       # simplification tolerance in degrees
  python make_observatory_earth.py --textures       # rebuild the Earth textures
  python make_observatory_earth.py --textures --fetch   # and re-download them from GIBS first
  python make_observatory_earth.py --stars          # rebuild the star field

Standard library only, EXCEPT --textures, which needs Pillow and numpy. No
em-dashes anywhere in this file or its output.
"""

import argparse
import base64
import json
import math
import os
import struct
import sys

NE_LAND_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
               "master/geojson/ne_110m_land.geojson")

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FIXTURES = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Local")),
    "Temp", "observatory", "fixtures")

RING_SCALE = 180          # int16 units per degree: 180 deg * 180 = 32400, inside int16
MAX_POINTS = 12000        # spec section 3.5 budget
MAX_BYTES = 120 * 1024    # definition of done

# ----------------------------------------------------------------------------
# Named regions. Ordered SPECIFIC FIRST: consumers take the FIRST box that
# contains the point. Invariant asserted below: no box precedes a box it fully
# contains, so a broad container can never shadow a specific hotspot. No box
# wraps the antimeridian, and none is wider than 60 degrees on a side, which is
# why the big oceans are several named basins rather than one entry each.
#
# This table is the ONLY source of place names in prose (spec r13 item 8 and r16
# item 5 forbid a coordinate pair in a sentence), so it has to name anywhere a
# feed can put an event: every populated landmass plus the seas the jamming
# instrument reports on. Coverage was checked by sampling the Natural Earth land
# polygons on a 2 degree grid, and nothing outside Antarctica falls through.
# What is deliberately left unnamed is empty deep ocean and ice: the Southern
# Ocean ring below about 50S outside the sectors named here, the empty stretch
# of South Pacific between 150W and the dateline below 45S, and Antarctica
# itself. Nothing reaches a reader from there. No ADS-B receiver stands in any
# of it, and the one thing that does walk through it, the terminator sweep in
# obs-autopilot, skips a point it cannot name rather than printing one. Leaving
# it unnamed is what keeps the "there is no generic fallback entry" property
# real and testable rather than a claim.
#
# Ordering is not decorative. Where a sea box would otherwise swallow the coast
# it is named after, the land box comes first (Indochina before the South China
# Sea, the Balkans before Italy, Iberia before North Africa). Where a hotspot
# matters more than the country under it, the hotspot comes first: the Baltic
# Sea keeps Stockholm, because Baltic jamming is the story that instrument is
# about.
# ----------------------------------------------------------------------------
REGIONS = [
    # ---- Hotspots, straits and small named waters ----
    ("Baltic Sea",            53.5,  66.0,   10.0,   30.0),
    ("Black Sea",             40.5,  47.5,   27.0,   42.0),
    ("Levant",                29.0,  37.5,   34.5,   42.5),
    ("Egypt",                 21.0,  32.0,   24.0,   34.4),
    ("Eastern Mediterranean", 30.0,  36.0,   21.0,   34.5),
    ("Balkans",               40.0,  47.0,   15.0,   28.5),
    ("Greece",                34.8,  41.8,   19.0,   27.0),
    ("Anatolia",              36.0,  42.5,   26.0,   41.0),
    ("Red Sea",               12.0,  28.5,   33.5,   44.0),
    ("Iraq",                  29.0,  37.5,   38.5,   46.5),
    ("Persian Gulf",          23.0,  31.0,   47.0,   58.0),
    ("Kashmir",               32.0,  37.0,   73.0,   80.0),
    ("Korean Peninsula",      33.0,  43.0,  124.0,  131.0),
    # r19l item 3: the island itself, ahead of the strait it is named after.
    # GDACS put a flood pin on Taiwan and the only name the table could
    # answer with was the water beside it, so the headline said China. The
    # strait box does not contain this one (it runs a little further south
    # and east), so specific-first ordering still holds.
    ("Taiwan",                21.8,  25.4,  119.9,  122.1),
    ("Taiwan Strait",         22.0,  26.5,  117.0,  122.0),
    ("Sea of Japan",          36.0,  48.0,  128.0,  140.5),
    ("Philippines",            4.5,  21.0,  119.5,  127.0),
    ("Malacca Strait",         0.0,   7.0,   96.0,  104.5),
    ("British Isles",         49.5,  61.0,  -11.0,    1.8),
    ("Netherlands and Belgium", 49.4, 53.6,   2.6,    7.3),
    ("North Sea",             51.0,  62.0,   -4.0,    9.0),
    ("Norwegian Sea",         62.0,  70.0,  -14.0,   20.0),
    ("Iceland",               62.5,  67.5,  -25.0,  -12.5),
    ("Barents Sea",           70.0,  80.0,   20.0,   60.0),
    ("Sea of Okhotsk",        44.0,  62.0,  137.5,  163.0),
    ("Bering Sea",            52.0,  66.0,  163.0,  180.0),
    ("Bering Strait",         58.0,  72.0, -180.0, -168.0),
    ("Central America",        6.0,  19.0,  -93.0,  -77.0),
    ("Gulf Coast",            28.5,  31.5,  -98.0,  -88.0),
    ("Gulf of Mexico",        18.0,  30.5,  -98.0,  -81.0),
    ("Caribbean",              9.0,  24.5,  -85.0,  -59.0),
    ("Japan",                 30.0,  46.0,  128.0,  146.0),
    ("Caucasus",              38.0,  45.0,   41.0,   50.0),

    # ---- Countries and sub continental regions ----
    ("Hawaii",                18.0,  23.0, -161.0, -154.0),
    ("Alaska",                51.0,  72.0, -170.0, -132.0),
    ("Pacific Northwest",     42.0,  49.5, -125.0, -116.0),
    ("US West Coast",         32.0,  49.0, -125.0, -114.0),
    ("US Southwest",          31.0,  42.0, -120.0, -106.0),
    ("Great Plains",          29.0,  49.0, -106.0,  -95.5),
    ("Rocky Mountains",       36.0,  49.0, -116.0, -104.0),
    ("US Southeast",          24.0,  37.0,  -95.0,  -75.0),
    ("Eastern Canada",        43.0,  70.0,  -83.0,  -52.0),
    ("US Northeast",          40.5,  47.5,  -80.0,  -66.5),
    ("US East Coast",         25.0,  45.0,  -82.0,  -66.0),
    ("US Midwest",            36.0,  49.0, -104.0,  -82.0),
    ("Western Canada",        48.0,  70.0, -141.0,  -81.0),
    ("Greenland",             59.0,  90.0,  -73.0,  -18.0),
    ("Canadian Arctic",       69.0,  90.0, -120.0,  -60.0),
    ("Mexico",                14.0,  33.0, -118.0,  -86.0),
    ("Venezuela and Guyana",   0.0,  12.0,  -73.0,  -51.0),
    ("Southern Cone",        -58.0, -20.0,  -92.0,  -52.0),
    ("Andes",                -40.0,  12.0,  -81.0,  -67.0),
    ("Brazil",               -34.0,   6.0,  -74.0,  -34.0),
    ("Iberia",                36.0,  44.0,   -9.8,    3.0),
    ("North Africa",          18.0,  37.0,  -18.0,   34.0),
    ("Italy",                 36.0,  47.0,    7.5,   18.6),
    ("France",                42.5,  51.0,   -5.0,    8.5),
    ("Central Europe",        45.0,  55.0,    8.0,   24.0),
    ("Western Europe",        42.0,  52.0,  -10.0,    8.0),
    ("Ukraine and Belarus",   45.0,  54.5,   22.0,   41.0),
    ("Eastern Europe",        45.0,  60.0,   24.0,   45.0),
    ("Western Russia",        46.0,  70.0,   30.0,   62.0),
    ("Scandinavia",           55.0,  71.0,    4.0,   32.0),
    ("West Africa",           -2.0,  16.0,  -18.0,    8.0),
    ("Sahel",                  9.0,  18.0,  -18.0,   36.0),
    ("Central Africa",        -6.0,   8.0,  -10.0,   32.0),
    ("East Africa",          -12.0,  15.0,   28.0,   52.0),
    ("Southern Africa",      -35.0,  -4.0,    8.0,   51.0),
    ("Iran",                  25.0,  40.0,   44.0,   61.5),
    ("Arabian Peninsula",     12.0,  32.0,   34.5,   60.0),
    ("Pakistan and Afghanistan", 24.0, 39.0, 60.0,   75.0),
    ("Sri Lanka",              5.7,  10.0,   79.4,   82.2),
    ("India",                  6.0,  31.0,   68.0,   90.0),
    ("Bangladesh and Myanmar", 15.0, 27.0,   88.0,   98.0),
    ("China west",            24.0,  45.0,   78.0,  105.0),
    ("Indochina",              8.0,  25.0,   92.0,  108.0),
    ("China east",            20.0,  45.0,  105.0,  125.0),
    ("South China Sea",        5.0,  23.0,  105.0,  121.0),
    ("Mongolia",              41.0,  51.5,   87.0,  120.0),
    ("Central Asia",          36.0,  50.0,   46.0,   87.0),
    ("Siberia",               50.0,  73.0,   60.0,  120.0),
    ("Russian Far East",      42.0,  72.0,  120.0,  180.0),
    ("Indonesia",            -11.0,   6.0,  104.0,  141.0),
    ("New Guinea",           -11.0,   0.0,  131.0,  151.0),
    ("Southeast Asia",       -10.0,  23.0,   95.0,  127.0),
    ("Australia west",       -50.0, -10.0,  110.0,  139.0),
    ("Australia east",       -44.0, -10.0,  138.0,  155.0),
    ("New Zealand",          -48.0, -33.0,  166.0,  179.0),

    # ---- Broad seas and ocean basins ----
    ("Western Mediterranean", 36.0,  44.5,   -6.0,   12.0),
    ("Central Mediterranean", 30.0,  41.0,   12.0,   21.0),
    ("Arabian Sea",            5.0,  25.0,   52.0,   75.0),
    ("Bay of Bengal",          5.0,  22.0,   80.0,   95.0),
    ("Coral Sea",            -30.0,  -5.0,  145.0,  170.0),
    ("Tasman Sea",           -50.0, -28.0,  139.0,  179.0),
    ("Southwest Pacific",    -62.0,  -5.0,  139.0,  180.0),
    ("North Atlantic",        22.0,  62.0,  -66.0,   -9.0),
    ("Central Atlantic",      -5.0,  25.0,  -60.0,  -10.0),
    ("South Atlantic",       -62.0,  -5.0,  -52.0,    8.0),
    ("North Pacific",         20.0,  55.0,  146.0,  180.0),
    ("Northeast Pacific",     30.0,  58.0, -180.0, -125.0),
    ("South Pacific",        -62.0,  -5.0, -150.0,  -90.0),
    ("Central Pacific",      -25.0,  35.0, -180.0, -140.0),
    ("Eastern Pacific",      -28.0,  32.0, -140.0,  -80.0),
    ("Western Pacific",       -5.0,  33.0,  125.0,  180.0),
    ("Indian Ocean",         -55.0,   5.0,   50.0,  110.0),
    ("Southern Ocean",       -62.0, -34.0,    5.0,   65.0),
    ("Arctic Ocean",          76.0,  90.0,  -20.0,   40.0),
    ("Greenland Sea",         68.0,  80.0,  -20.0,   20.0),
    ("Chukchi Sea",           66.0,  90.0, -180.0, -156.0),
    ("Beaufort Sea",          70.0,  90.0, -160.0, -120.0),
    ("Kara Sea",              70.0,  90.0,   40.0,  100.0),
    ("Laptev Sea",            70.0,  90.0,  100.0,  145.0),
    ("East Siberian Sea",     71.0,  90.0,  145.0,  180.0),
]

# Sanity probes: (lat, lon, expected first hit). Mirrored by t-earthdata.
REGION_PROBES = [
    (57.5, 19.5, "Baltic Sea"),
    (43.5, 34.0, "Black Sea"),
    (33.5, 36.0, "Levant"),
    (30.0, 31.2, "Egypt"),
    (34.0, 28.0, "Eastern Mediterranean"),
    (44.8, 20.5, "Balkans"),
    (37.98, 23.7, "Greece"),
    (39.0, 33.0, "Anatolia"),
    (20.0, 38.0, "Red Sea"),
    (33.3, 44.4, "Iraq"),
    (27.0, 52.0, "Persian Gulf"),
    (34.5, 76.0, "Kashmir"),
    (37.5, 127.0, "Korean Peninsula"),
    (23.7, 120.9, "Taiwan"),
    (24.0, 119.5, "Taiwan Strait"),
    (40.0, 135.0, "Sea of Japan"),
    (14.6, 121.0, "Philippines"),
    (1.35, 103.8, "Malacca Strait"),
    (51.5, -0.1, "British Isles"),
    (52.4, 4.9, "Netherlands and Belgium"),
    (56.0, 3.0, "North Sea"),
    (66.0, 5.0, "Norwegian Sea"),
    (64.1, -21.9, "Iceland"),
    (75.0, 40.0, "Barents Sea"),
    (50.0, 145.0, "Sea of Okhotsk"),
    (58.0, 175.0, "Bering Sea"),
    (66.0, -172.0, "Bering Strait"),
    (14.6, -90.5, "Central America"),
    (29.8, -95.4, "Gulf Coast"),
    (25.0, -90.0, "Gulf of Mexico"),
    (15.0, -75.0, "Caribbean"),
    (35.5, 139.5, "Japan"),
    (42.0, 44.0, "Caucasus"),
    (21.3, -157.9, "Hawaii"),
    (61.2, -149.9, "Alaska"),
    (47.6, -122.3, "Pacific Northwest"),
    (37.7, -122.4, "US West Coast"),
    (33.4, -112.1, "US Southwest"),
    (39.7, -105.0, "Great Plains"),
    (45.8, -108.5, "Rocky Mountains"),
    (33.7, -84.4, "US Southeast"),
    (43.7, -79.4, "Eastern Canada"),
    (42.4, -71.1, "US Northeast"),
    (40.0, -74.0, "US East Coast"),
    (41.9, -87.6, "US Midwest"),
    (51.0, -114.1, "Western Canada"),
    (64.2, -51.7, "Greenland"),
    (74.7, -94.8, "Canadian Arctic"),
    (19.4, -99.1, "Mexico"),
    (6.8, -58.2, "Venezuela and Guyana"),
    (-34.6, -58.4, "Southern Cone"),
    (-12.0, -77.0, "Andes"),
    (-23.5, -46.6, "Brazil"),
    (40.4, -3.7, "Iberia"),
    (36.8, 3.1, "North Africa"),
    (41.9, 12.5, "Italy"),
    (48.8, 2.3, "France"),
    (50.0, 14.5, "Central Europe"),
    (42.2, 5.0, "Western Europe"),
    (50.4, 30.5, "Ukraine and Belarus"),
    (55.75, 37.6, "Eastern Europe"),
    (55.8, 49.1, "Western Russia"),
    (66.5, 25.7, "Scandinavia"),
    (6.5, 3.4, "West Africa"),
    (15.6, 32.5, "Sahel"),
    (-4.4, 15.3, "Central Africa"),
    (-1.3, 36.8, "East Africa"),
    (-26.2, 28.1, "Southern Africa"),
    (35.7, 51.4, "Iran"),
    (24.7, 46.7, "Arabian Peninsula"),
    (34.5, 69.2, "Pakistan and Afghanistan"),
    (6.9, 79.9, "Sri Lanka"),
    (28.6, 77.2, "India"),
    (23.8, 90.4, "Bangladesh and Myanmar"),
    (30.6, 104.1, "China west"),
    (13.7, 100.5, "Indochina"),
    (39.9, 116.4, "China east"),
    (14.0, 114.0, "South China Sea"),
    (47.9, 106.9, "Mongolia"),
    (43.2, 76.9, "Central Asia"),
    (55.0, 82.9, "Siberia"),
    (62.0, 129.7, "Russian Far East"),
    (-6.2, 106.9, "Indonesia"),
    (-9.4, 147.2, "New Guinea"),
    (7.5, 100.0, "Southeast Asia"),
    (-31.9, 115.9, "Australia west"),
    (-33.9, 151.2, "Australia east"),
    (-36.9, 174.8, "New Zealand"),
    (39.0, 5.0, "Western Mediterranean"),
    (37.2, 18.8, "Central Mediterranean"),
    (15.0, 62.0, "Arabian Sea"),
    (14.0, 91.0, "Bay of Bengal"),
    (-15.0, 160.0, "Coral Sea"),
    (-40.0, 160.0, "Tasman Sea"),
    (-18.1, 178.4, "Southwest Pacific"),
    (45.0, -35.0, "North Atlantic"),
    (10.0, -30.0, "Central Atlantic"),
    (-20.0, -20.0, "South Atlantic"),
    (35.0, 165.0, "North Pacific"),
    (45.0, -160.0, "Northeast Pacific"),
    (-17.5, -149.6, "South Pacific"),
    (10.0, -160.0, "Central Pacific"),
    (10.0, -110.0, "Eastern Pacific"),
    (13.4, 144.8, "Western Pacific"),
    (-20.0, 80.0, "Indian Ocean"),
    (-50.0, 40.0, "Southern Ocean"),
    (89.0, 10.0, "Arctic Ocean"),
    (72.0, 0.0, "Greenland Sea"),
    (75.0, -170.0, "Chukchi Sea"),
    (75.0, -140.0, "Beaufort Sea"),
    (75.0, 80.0, "Kara Sea"),
    (76.0, 120.0, "Laptev Sea"),
    (76.0, 160.0, "East Siberian Sea"),
]


def first_hit(lat, lon):
    for name, la0, la1, lo0, lo1 in REGIONS:
        if la0 <= lat <= la1 and lo0 <= lon <= lo1:
            return name
    return None


def contains(a, b):
    """True if box a fully contains box b (both are (name, la0, la1, lo0, lo1))."""
    return (a[1] <= b[1] and a[2] >= b[2] and a[3] <= b[3] and a[4] >= b[4])


def check_regions():
    names = [r[0] for r in REGIONS]
    assert len(names) == len(set(names)), "duplicate region name"
    for name, la0, la1, lo0, lo1 in REGIONS:
        assert -90.0 <= la0 < la1 <= 90.0, "bad lat box: %s" % name
        assert -180.0 <= lo0 < lo1 <= 180.0, "bad lon box: %s" % name
        # lo0 < lo1 already rules out an antimeridian wrap. The 60 degree cap is
        # what stops a "basin" box from quietly becoming a global fallback; it is
        # asserted in t-earthdata too, so keep the two in step.
        assert (la1 - la0) <= 60.0 and (lo1 - lo0) <= 60.0, (
            "box over 60 degrees on a side: %s" % name)
    # There is no generic fallback entry, and there must not be one: the
    # coordinate label is the consumer's job. A remote point in Antarctic water
    # proves it, the same point t-earthdata uses.
    assert first_hit(-70.0, -30.0) is None, "a box now claims the empty Weddell Sea"
    for i in range(len(REGIONS)):
        for j in range(i + 1, len(REGIONS)):
            assert not contains(REGIONS[i], REGIONS[j]), (
                "ordering: %s precedes the box it contains, %s"
                % (REGIONS[i][0], REGIONS[j][0]))
    for lat, lon, want in REGION_PROBES:
        got = first_hit(lat, lon)
        assert got == want, "probe %.1f,%.1f gave %r, wanted %r" % (lat, lon, got, want)


# ----------------------------------------------------------------------------
# Coastline rings
# ----------------------------------------------------------------------------

def fetch_land(path):
    import urllib.request
    sys.stderr.write("fetching %s\n" % NE_LAND_URL)
    with urllib.request.urlopen(NE_LAND_URL, timeout=60) as resp:
        raw = resp.read()
    with open(path, "wb") as fh:
        fh.write(raw)
    sys.stderr.write("wrote %s (%d bytes)\n" % (path, len(raw)))


def load_rings(path):
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    rings = []
    for feat in doc.get("features", []):
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        if gtype == "Polygon":
            polys = [geom["coordinates"]]
        elif gtype == "MultiPolygon":
            polys = geom["coordinates"]
        else:
            continue
        for poly in polys:
            for ring in poly:
                pts = [(float(p[0]), float(p[1])) for p in ring]   # lon, lat in GeoJSON
                if len(pts) >= 4:
                    rings.append(pts)
    return rings


def perp_dist(p, a, b):
    ax, ay = a
    bx, by = b
    px, py = p
    dx = bx - ax
    dy = by - ay
    if dx == 0.0 and dy == 0.0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    if t < 0.0:
        t = 0.0
    elif t > 1.0:
        t = 1.0
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def dp_simplify(pts, tol):
    """Douglas-Peucker on an open polyline."""
    n = len(pts)
    if n < 3 or tol <= 0.0:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        dmax = 0.0
        idx = -1
        for k in range(i + 1, j):
            d = perp_dist(pts[k], pts[i], pts[j])
            if d > dmax:
                dmax = d
                idx = k
        if idx >= 0 and dmax > tol:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(pts, keep) if k]


def simplify_ring(ring, tol):
    """Simplify a closed ring. Split at the point farthest from the start so the
    two anchors are never degenerate, then rejoin and re-close."""
    pts = list(ring)
    if len(pts) >= 2 and pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 3:
        return None
    a = pts[0]
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - a[0]) ** 2 + (pts[i][1] - a[1]) ** 2)
    if far == 0:
        far = len(pts) // 2
    head = dp_simplify(pts[:far + 1], tol)
    tail = dp_simplify(pts[far:] + [pts[0]], tol)
    out = head + tail[1:-1]
    if len(out) < 3:
        return None
    out.append(out[0])                      # explicit closure, identical coordinates
    return out


def quantize(rings):
    """Rings of (lon, lat) -> (counts, int16 byte string) storing lat, lon pairs."""
    counts = []
    vals = []
    for ring in rings:
        counts.append(len(ring))
        for lon, lat in ring:
            qlat = int(round(lat * RING_SCALE))
            qlon = int(round(lon * RING_SCALE))
            qlat = max(-32768, min(32767, qlat))
            qlon = max(-32768, min(32767, qlon))
            vals.append(qlat)
            vals.append(qlon)
    blob = struct.pack("<%dh" % len(vals), *vals)
    return counts, blob


# ----------------------------------------------------------------------------
# WMM
# ----------------------------------------------------------------------------

def load_wmm(path):
    epoch = None
    rows = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            s = line.strip()
            if not s or s.startswith("9999"):
                continue
            parts = s.split()
            if epoch is None:
                epoch = float(parts[0])
                continue
            if len(parts) < 6:
                continue
            n = int(parts[0])
            m = int(parts[1])
            g, h, gd, hd = (float(parts[2]), float(parts[3]), float(parts[4]), float(parts[5]))
            rows.append([n, m, g, h, gd, hd])
    n_max = max(r[0] for r in rows)
    expect = [(n, m) for n in range(1, n_max + 1) for m in range(0, n + 1)]
    got = [(r[0], r[1]) for r in rows]
    assert got == expect, "WMM coefficient rows are not the expected (n, m) enumeration"
    for r in rows:
        if r[1] == 0:
            assert r[3] == 0.0 and r[5] == 0.0, "h must be zero for m = 0"
    return epoch, n_max, rows


def load_test_values(path, want=12):
    rows = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            parts = s.split()
            if len(parts) < 5:
                continue
            rows.append([float(parts[0]), float(parts[1]), float(parts[2]),
                         float(parts[3]), float(parts[4])])
    assert len(rows) >= want, "not enough WMM test values"
    # Spread the picks across the whole table so every model year and both
    # hemispheres are represented, including the high latitude cases.
    step = len(rows) / float(want)
    picked = []
    for i in range(want):
        picked.append(rows[int(i * step)])
    return picked


# ----------------------------------------------------------------------------
# Emit
# ----------------------------------------------------------------------------

def fmt_num(x):
    if x == int(x) and abs(x) < 1e15:
        return str(int(x))
    return repr(round(x, 4))


def chunk_b64(b64, width=100):
    return ["'" + b64[i:i + width] + "'" for i in range(0, len(b64), width)]


HEADER = """/* obs-earth-data.js - GENERATED by make_observatory_earth.py. Do not edit by hand.
 *
 * Land rings: Natural Earth 1:110m land polygons, PUBLIC DOMAIN.
 *   Source: https://github.com/nvkelso/natural-earth-vector (geojson/ne_110m_land.geojson)
 *   Natural Earth vector data is in the public domain and may be used freely.
 *   Rings here are simplified (Douglas-Peucker, tolerance %(tol)s degrees), quantized to
 *   int16 at 1/%(scale)d degree, base64 packed, and decoded lazily by landRings().
 *   %(nrings)d closed rings, %(npoints)d points total.
 *
 * Geomagnetic coefficients: World Magnetic Model WMM2025 (WMM2025.COF), NOAA NCEI and the
 *   British Geological Survey, epoch %(epoch)s, degree %(nmax)d, valid through 2029-12-31.
 *   The WMM and its coefficient files are works of the United States Government prepared by
 *   officers or employees of the US Government as part of their official duties (17 USC 105,
 *   17 USC 403). They are not subject to copyright protection in the United States and are
 *   distributed without restriction.
 *   Source: https://www.ncei.noaa.gov/products/world-magnetic-model
 *
 * testWmm rows are taken verbatim from the official WMM2025_TestValues.txt shipped with the
 *   coefficient package: [decimal year, height above the WGS-84 ellipsoid in km, geodetic
 *   latitude deg, longitude deg, expected declination deg].
 *
 * regions is a hand authored table of lat/lon boxes ordered SPECIFIC FIRST. Consumers take
 *   the FIRST box that contains the point. Broad context boxes never precede a box they
 *   fully contain, so a hotspot is never shadowed by a continent sized box. There is no
 *   generic fallback entry here: formatting a plain "48N 30E" label is the consumer's job.
 *
 * Generated by: %(cmd)s
 */
"""


def build_js(counts, blob, epoch, n_max, wmm_rows, test_rows, tol, cmd):
    b64 = base64.b64encode(blob).decode("ascii")
    npoints = sum(counts)
    out = []
    out.append(HEADER % {
        "tol": tol, "scale": RING_SCALE, "nrings": len(counts), "npoints": npoints,
        "epoch": ("%.1f" % epoch), "nmax": n_max, "cmd": cmd,
    })
    out.append("(function () {")
    out.append("  'use strict';")
    out.append("  var G = (typeof window !== 'undefined') ? window")
    out.append("        : (typeof globalThis !== 'undefined') ? globalThis : this;")
    out.append("")
    out.append("  var RING_SCALE = %d;" % RING_SCALE)
    out.append("  var RING_COUNTS = [%s];" % ",".join(str(c) for c in counts))
    out.append("  var RING_B64 = [")
    parts = chunk_b64(b64)
    for i, part in enumerate(parts):
        out.append("    " + part + ("," if i < len(parts) - 1 else ""))
    out.append("  ].join('');")
    out.append("""
  var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /* Tiny base64 decoder so this file needs neither atob nor Buffer. */
  function b64ToBytes(s) {
    var map = {}, i;
    for (i = 0; i < B64C.length; i++) map[B64C.charAt(i)] = i;
    var pad = 0;
    while (pad < 2 && s.charAt(s.length - 1 - pad) === '=') pad++;
    var n = (s.length / 4) * 3 - pad;
    var out = new Uint8Array(n), p = 0;
    for (i = 0; i < s.length; i += 4) {
      var a = map[s.charAt(i)], b = map[s.charAt(i + 1)];
      var c = map[s.charAt(i + 2)], d = map[s.charAt(i + 3)];
      var v = (a << 18) | (b << 12) | ((c === undefined ? 0 : c) << 6) | (d === undefined ? 0 : d);
      if (p < n) out[p++] = (v >> 16) & 255;
      if (p < n) out[p++] = (v >> 8) & 255;
      if (p < n) out[p++] = v & 255;
    }
    return out;
  }

  var ringCache = null;

  /* Closed rings of [lat, lon, lat, lon, ...] in degrees. Cached after the first call. */
  function landRings() {
    if (ringCache) return ringCache;
    var bytes = b64ToBytes(RING_B64);
    var rings = [], p = 0, i, j;
    for (i = 0; i < RING_COUNTS.length; i++) {
      var n = RING_COUNTS[i];
      var f = new Float32Array(n * 2);
      for (j = 0; j < n; j++) {
        var la = ((bytes[p] | (bytes[p + 1] << 8)) << 16) >> 16; p += 2;
        var lo = ((bytes[p] | (bytes[p + 1] << 8)) << 16) >> 16; p += 2;
        f[j * 2] = la / RING_SCALE;
        f[j * 2 + 1] = lo / RING_SCALE;
      }
      rings.push(f);
    }
    ringCache = rings;
    return rings;
  }
""")
    out.append("  var REGIONS = [")
    for name, la0, la1, lo0, lo1 in REGIONS:
        out.append("    { name: %s, latMin: %s, latMax: %s, lonMin: %s, lonMax: %s },"
                   % (json.dumps(name), fmt_num(la0), fmt_num(la1), fmt_num(lo0), fmt_num(lo1)))
    out.append("  ];")
    out.append("")
    out.append("  var WMM_ROWS = [")
    for n, m, g, h, gd, hd in wmm_rows:
        out.append("    [%d,%d,%s,%s,%s,%s]," % (n, m, fmt_num(g), fmt_num(h),
                                                 fmt_num(gd), fmt_num(hd)))
    out.append("  ];")
    out.append("")
    out.append("  var TEST_WMM = [")
    for yf, alt, lat, lon, dec in test_rows:
        out.append("    [%s,%s,%s,%s,%s]," % (fmt_num(yf), fmt_num(alt), fmt_num(lat),
                                              fmt_num(lon), fmt_num(dec)))
    out.append("  ];")
    out.append("")
    out.append("  G.OBS_EARTH = {")
    out.append("    ver: 1,")
    out.append("    landRings: landRings,")
    out.append("    regions: REGIONS,")
    out.append("    wmm: { epoch: %s, nMax: %d, rows: WMM_ROWS }," % (("%.1f" % epoch), n_max))
    out.append("    testWmm: TEST_WMM")
    out.append("  };")
    out.append("}());")
    out.append("")
    return "\n".join(out)


# ----------------------------------------------------------------------------
# r12 zone K1: the three bundled sky-and-surface assets.
#
#   images/obs/earth-day-2048.jpg    NASA GIBS BlueMarble_ShadedRelief_Bathymetry
#   images/obs/earth-night-2048.jpg  NASA GIBS VIIRS_CityLights_2012
#   images/obs/stars-8k.bin          the brightest 8,000 stars of the AT-HYG v4.0
#                                    subset already bundled in assets/js/voyage-bg.js
#
# The two NASA layers are works of the United States Government and carry no
# copyright (NASA media usage guidelines; GIBS serves them with an open CORS
# header). They are NOT shipped as photographs: both are re-toned offline into
# the Observatory's own palette by tone_basemap() and lights_channel() below, so
# the page's claim that it draws instruments rather than a photo still holds.
# The star positions are MODIFIED from the AT-HYG (Augmented Tycho-HYG) database
# v4.0, (c) David Nash, astronexus.com, CC BY-SA 4.0; this derived subset carries
# the same licence, and the attribution travels with it in the obs-globe.js
# header, in images/obs/CREDITS.txt and in the page's help card.
# ----------------------------------------------------------------------------

GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
GIBS_DAY_LAYER = "BlueMarble_ShadedRelief_Bathymetry"
GIBS_NIGHT_LAYER = "VIIRS_CityLights_2012"
TEX_W, TEX_H = 2048, 1024
# r13 (15): the same basemap at twice the width, for the GL tier on a desktop
# sized viewport. A 2048 texel is 9.8 km at the equator and stops resolving at
# about 7,000 km of altitude; 4096 halves that and buys the dive another
# octave before obs-globe's PURE.baseFade hands the frame to the vectors.
# Quality 78 rather than the small file's 84, which is what keeps it near half
# a megabyte; the tone curve, the probes and the assertions are identical.
TEX_BIG_W, TEX_BIG_H = 4096, 2048
TEX_QUALITY, TEX_BIG_QUALITY = 84, 78

# The tone curve, tuned against ten named probes (deep Pacific, North Atlantic,
# Sahara, Amazon, Siberian taiga, Greenland, Himalaya, outback, Great Lakes,
# Congo) so that deep ocean lands on the palette's own ocean luminance and
# forest lands on its land luminance:
#
#   deep Pacific  rgb 15 19 35   luminance 19.6   palette ocean #10141c = 19.7
#   Amazon        rgb 28 34 26   luminance 31.3   palette land  #1a2027 = 31.0
#   Sahara        rgb 63 61 58   luminance 61.3
#
# desat keeps 40 percent of the source chroma, so land still reads olive and
# ocean still reads blue, but nothing on the disc is a saturated photograph.
TONE_DESAT = 0.40
TONE_GAMMA = 0.55
TONE_GAIN = 0.378
TONE_KNEE = 0.16      # shoulder starts here, in output units of 0..1
TONE_HI = 0.30        # and asymptotes here, so ice caps do not glare
TONE_TINT = (0.94, 1.00, 1.06)

# City lights: the GIBS night layer paints its oceans and unlit land a dark
# BLUE, and the lights themselves are yellow-white, so min(R, G) separates them
# cleanly. Measured on the 2026-08-26 capture: 95 percent of the world sits at
# min(R, G) <= 18, every named city core is above 230.
LIGHT_FLOOR = 0.12
LIGHT_GAMMA = 1.35

STAR_COUNT = 8000
STAR_MAG_OFF = 2.0        # mag byte = round((mag + 2) * 20), so -2.0 .. +10.75
STAR_MAG_SCALE = 20.0
STAR_DEC_SCALE = 180.0    # int16 units per degree, +/- 16200
OBLIQ_DEG = 23.43928      # J2000 mean obliquity, the value make_voyage_data uses


def _pil():
    try:
        from PIL import Image
    except ImportError:
        sys.stderr.write("Pillow is required for --textures: pip install pillow\n")
        raise
    return Image


def gibs_url(layer, w=TEX_W, h=TEX_H):
    return (GIBS_WMS + "?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=" + layer +
            "&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=%d&HEIGHT=%d&FORMAT=image/jpeg"
            % (w, h))


def fetch_gibs(layer, dest, w=TEX_W, h=TEX_H):
    import urllib.request
    url = gibs_url(layer, w, h)
    sys.stdout.write("fetching %s\n" % layer)
    with urllib.request.urlopen(url, timeout=180) as r:
        data = r.read()
    if len(data) < 20000 or data[:2] != b"\xff\xd8":
        raise RuntimeError("GIBS returned %d bytes that are not a JPEG" % len(data))
    with open(dest, "wb") as fh:
        fh.write(data)
    return dest


def tone_basemap(img):
    """Blue Marble to the Observatory palette. Desaturate, then a compressive
    luminance curve with a soft shoulder, then a cool tint. Pure per pixel: no
    blur, no sharpening, nothing invented."""
    import numpy as np
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    lum = 0.30 * a[:, :, 0] + 0.59 * a[:, :, 1] + 0.11 * a[:, :, 2]
    for c in range(3):
        a[:, :, c] = lum + (a[:, :, c] - lum) * TONE_DESAT
    y = np.power(np.clip(lum / 255.0, 0.0, 1.0), TONE_GAMMA) * TONE_GAIN
    over = y > TONE_KNEE
    span = TONE_HI - TONE_KNEE
    y = np.where(over, TONE_KNEE + span * (1.0 - np.exp(-(y - TONE_KNEE) / span)), y)
    scale = y / np.maximum(lum / 255.0, 1e-4)
    out = np.empty_like(a)
    for c in range(3):
        out[:, :, c] = a[:, :, c] * scale * TONE_TINT[c]
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def lights_channel(img):
    """VIIRS city lights to a single intensity channel. The blue base of the
    source layer is discarded by taking min(R, G); what survives is lit ground."""
    import numpy as np
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    m = np.minimum(a[:, :, 0], a[:, :, 1]) / 255.0
    e = np.clip((m - LIGHT_FLOOR) / (1.0 - LIGHT_FLOOR), 0.0, 1.0) ** LIGHT_GAMMA
    return np.clip(e * 255.0 + 0.5, 0, 255).astype(np.uint8)


def probe_texture(arr, label):
    """Named probes, printed so a change to the curve is visible in the log."""
    probes = [("deep pacific", -150.0, 0.0), ("north atlantic", -30.0, 45.0),
              ("sahara", 15.0, 23.0), ("amazon", -62.0, -4.0),
              ("siberia taiga", 95.0, 60.0), ("greenland", -42.0, 72.0),
              ("himalaya", 86.0, 30.0), ("outback", 133.0, -25.0),
              ("great lakes", -85.0, 45.0), ("congo", 20.0, 0.0)]
    h, w = arr.shape[0], arr.shape[1]
    sys.stdout.write("  %s probes\n" % label)
    for name, lon, lat in probes:
        x = int((lon + 180.0) / 360.0 * w) % w
        y = max(0, min(h - 1, int((90.0 - lat) / 180.0 * h)))
        if arr.ndim == 3:
            r, g, b = int(arr[y, x, 0]), int(arr[y, x, 1]), int(arr[y, x, 2])
            sys.stdout.write("    %-15s rgb %3d %3d %3d  lum %5.1f\n"
                             % (name, r, g, b, 0.30 * r + 0.59 * g + 0.11 * b))
        else:
            sys.stdout.write("    %-15s %3d\n" % (name, int(arr[y, x])))


def build_textures(fixtures, outdir, fetch):
    Image = _pil()
    import numpy as np
    if not os.path.isdir(fixtures):
        os.makedirs(fixtures)
    if not os.path.isdir(outdir):
        os.makedirs(outdir)
    day_src = os.path.join(fixtures, "gibs-bluemarble-2048.jpg")
    big_src = os.path.join(fixtures, "gibs-bluemarble-4096.jpg")
    night_src = os.path.join(fixtures, "gibs-citylights-2048.jpg")
    if fetch or not os.path.isfile(day_src):
        fetch_gibs(GIBS_DAY_LAYER, day_src)
    if fetch or not os.path.isfile(big_src):
        fetch_gibs(GIBS_DAY_LAYER, big_src, TEX_BIG_W, TEX_BIG_H)
    if fetch or not os.path.isfile(night_src):
        fetch_gibs(GIBS_NIGHT_LAYER, night_src)

    day = tone_basemap(Image.open(day_src))
    assert day.shape == (TEX_H, TEX_W, 3), "day texture is not %dx%d" % (TEX_W, TEX_H)
    probe_texture(day, "day")
    # The two numbers the tone curve exists to hit.
    ocean = day[TEX_H // 2, int((-150.0 + 180.0) / 360.0 * TEX_W)]
    ocean_lum = 0.30 * ocean[0] + 0.59 * ocean[1] + 0.11 * ocean[2]
    assert 16.0 <= ocean_lum <= 24.0, "deep ocean luminance %.1f is off palette" % ocean_lum
    day_path = os.path.join(outdir, "earth-day-2048.jpg")
    Image.fromarray(day, "RGB").save(day_path, quality=TEX_QUALITY, optimize=True,
                                     progressive=True, subsampling=1)

    # r13 (15): the wide one, off the same curve. The ocean assertion is
    # repeated rather than shared, because the two files are re-toned from two
    # separate GIBS renders and a curve that drifts on one must not ship on the
    # other unnoticed.
    big = tone_basemap(Image.open(big_src))
    assert big.shape == (TEX_BIG_H, TEX_BIG_W, 3), \
        "wide day texture is not %dx%d" % (TEX_BIG_W, TEX_BIG_H)
    probe_texture(big, "day 4096")
    b_ocean = big[TEX_BIG_H // 2, int((-150.0 + 180.0) / 360.0 * TEX_BIG_W)]
    b_lum = 0.30 * b_ocean[0] + 0.59 * b_ocean[1] + 0.11 * b_ocean[2]
    assert 16.0 <= b_lum <= 24.0, "wide deep ocean luminance %.1f is off palette" % b_lum
    assert abs(b_lum - ocean_lum) < 3.0, \
        "the two widths disagree on deep ocean by %.1f" % abs(b_lum - ocean_lum)
    big_path = os.path.join(outdir, "earth-day-4096.jpg")
    Image.fromarray(big, "RGB").save(big_path, quality=TEX_BIG_QUALITY, optimize=True,
                                     progressive=True, subsampling=1)

    night = lights_channel(Image.open(night_src))
    probe_texture(night, "night")
    lit = float((night > 8).mean())
    assert 0.005 < lit < 0.10, "lit fraction %.4f is not a plausible night side" % lit
    night_path = os.path.join(outdir, "earth-night-2048.jpg")
    Image.fromarray(night, "L").save(night_path, quality=80, optimize=True)

    creds = os.path.join(outdir, "CREDITS.txt")
    with open(creds, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(CREDITS_TXT)
    return day_path, big_path, night_path, creds


# ----------------------------------------------------------------------------
# Star field. Source: the star arrays already bundled in assets/js/voyage-data.js,
# which make_voyage_data.py generated from AT-HYG v4.0 and which hold the whole
# naked-eye sky as ECLIPTIC J2000 x, y, z in light-years, brightest first.
#
# assets/js/voyage-bg.js is NOT the source: make_voyage_data.py excludes every
# star the navigable tier already took, so the background bands start at
# magnitude 6.6 and contain no bright star at all. That was worth a wrong turn
# here, and the anchor assertions below are what caught it.
#
# The Observatory needs directions on the sky, not positions in space, so each
# record is turned back into equatorial J2000 right ascension and declination.
# The renderer then rotates that inertial frame into the Earth-fixed frame by
# Greenwich mean sidereal time, which is what makes the sky true for the moment
# rather than decorative.
#
# Six bytes per star, little endian, brightest first:
#   uint16  right ascension, 0 to 65535 spanning 0 to 360 degrees (0.0055 deg)
#   int16   declination times 180
#   uint8   (magnitude + 2) times 20
#   uint8   colour index times 100 plus 50, 255 meaning unknown
# ----------------------------------------------------------------------------

def read_voyage_stars(path):
    """The navigable tier of voyage-data.js as (x, y, z, mag, ci) tuples."""
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()
    i = src.find('{"meta"')
    assert i >= 0, "no star payload found in " + path
    j = src.rfind("}")
    st = json.loads(src[i:j + 1])["stars"]
    n = len(st["mag"])
    out = []
    for k in range(n):
        mag = st["mag"][k]
        x, y, z = st["x"][k], st["y"][k], st["z"][k]
        if mag is None or x is None or y is None or z is None:
            continue
        out.append((float(x), float(y), float(z), float(mag), st["ci"][k]))
    out.sort(key=lambda r: r[3])
    return out


def ecliptic_to_radec(x, y, z):
    """Inverse of make_voyage_data.to_ecliptic, then Cartesian to spherical."""
    o = math.radians(OBLIQ_DEG)
    xe = x
    ye = math.cos(o) * y - math.sin(o) * z
    ze = math.sin(o) * y + math.cos(o) * z
    r = math.sqrt(xe * xe + ye * ye + ze * ze)
    if not r > 0:
        return None
    ra = math.degrees(math.atan2(ye, xe)) % 360.0
    dec = math.degrees(math.asin(max(-1.0, min(1.0, ze / r))))
    return ra, dec


# Anchors. Four stars a reader knows, at their published J2000 positions,
# checked to a quarter of a degree: well inside the 0.0055 degree quantization
# and far outside any frame, sign or obliquity error.
STAR_ANCHORS = [("Sirius", 101.287, -16.716), ("Vega", 279.234, 38.784),
                ("Betelgeuse", 88.793, 7.407), ("Polaris", 37.955, 89.264)]


def build_stars(voyage_data, outdir, count):
    stars = read_voyage_stars(voyage_data)
    assert len(stars) >= count, "only %d stars available, wanted %d" % (len(stars), count)
    buf = bytearray()
    faint = -99.0
    for x, y, z, mag, ci in stars[:count]:
        rd = ecliptic_to_radec(x, y, z)
        assert rd is not None, "a star at the origin cannot have a direction"
        ra, dec = rd
        ra_u = int(round(ra / 360.0 * 65536.0)) % 65536
        dec_i = max(-32768, min(32767, int(round(dec * STAR_DEC_SCALE))))
        m = max(0, min(255, int(round((mag + STAR_MAG_OFF) * STAR_MAG_SCALE))))
        c100 = 255 if ci is None else max(0, min(254, int(round(ci * 100)) + 50))
        buf += struct.pack("<HhBB", ra_u, dec_i, m, c100)
        faint = max(faint, mag)

    got = []
    for i in range(count):
        ra_u, dec_i, m, c = struct.unpack_from("<HhBB", buf, i * 6)
        got.append((ra_u / 65536.0 * 360.0, dec_i / STAR_DEC_SCALE,
                    m / STAR_MAG_SCALE - STAR_MAG_OFF))
    for name, ra, dec in STAR_ANCHORS:
        hit = False
        for g in got:
            dra = abs(((g[0] - ra + 180.0) % 360.0) - 180.0) * math.cos(math.radians(dec))
            if dra < 0.25 and abs(g[1] - dec) < 0.25:
                hit = True
                break
        assert hit, "%s is missing from the star field" % name
    first = got[0]
    assert abs(((first[0] - 101.287 + 180.0) % 360.0) - 180.0) < 0.25 and \
        abs(first[1] + 16.716) < 0.25, \
        "the brightest star is not Sirius: ra %.3f dec %.3f" % (first[0], first[1])
    unknown = sum(1 for i in range(count) if buf[i * 6 + 5] == 255)
    assert unknown < count * 0.05, "%d stars have no colour index" % unknown

    if not os.path.isdir(outdir):
        os.makedirs(outdir)
    out = os.path.join(outdir, "stars-8k.bin")
    with open(out, "wb") as fh:
        fh.write(bytes(buf))
    return out, count, got[0][2], faint, unknown



CREDITS_TXT = """The Observatory (/observatory/) bundles four sky-and-surface assets here.

earth-day-2048.jpg
earth-day-4096.jpg
  NASA Global Imagery Browse Services (GIBS), layer
  BlueMarble_ShadedRelief_Bathymetry, EPSG:4326, 2048x1024 and 4096x2048.
  A work of the United States Government; not subject to copyright.
  Re-toned offline into the Observatory's palette (desaturated to 40 percent
  chroma, compressive luminance curve with a soft shoulder, cool tint) by
  make_observatory_earth.py --textures. It is a re-toned basemap, not a
  photograph of tonight's Earth. The page fetches exactly one of the two:
  the wide file on the WebGL tier at a desktop sized viewport, the small one
  on a phone and on the flat tier.

earth-night-2048.jpg
  NASA GIBS, layer VIIRS_CityLights_2012 (the Black Marble / Earth at Night
  composite), EPSG:4326, 2048x1024, reduced offline to a single lit-ground
  intensity channel. A work of the United States Government; not subject to
  copyright. It is a 2016 composite, not tonight's lights.

stars-8k.bin
  The brightest 8,000 stars, MODIFIED from the AT-HYG (Augmented Tycho-HYG)
  database v4.0, (c) David Nash, astronexus.com, licensed CC BY-SA 4.0
  (https://creativecommons.org/licenses/by-sa/4.0/). This derived subset
  carries the same licence. Taken from the copy already bundled in
  assets/js/voyage-bg.js and converted back to equatorial J2000 right
  ascension and declination. Six bytes per star, little endian:
  uint16 right ascension (0 to 65535 spans 0 to 360 degrees), int16
  declination times 180, uint8 (magnitude + 2) times 20, uint8 colour index
  times 100 plus 50 with 255 meaning unknown. Brightest first.

Generated by make_observatory_earth.py; see that file for the exact curves.
"""


def main():
    ap = argparse.ArgumentParser(description="Generate assets/js/obs-earth-data.js")
    ap.add_argument("--fixtures", default=DEFAULT_FIXTURES,
                    help="directory holding the captured source files")
    ap.add_argument("--land", default=None, help="path to ne_110m_land.geojson")
    ap.add_argument("--cof", default=None, help="path to wmm2025.cof")
    ap.add_argument("--testvals", default=None, help="path to wmm2025_testvalues.txt")
    ap.add_argument("--out", default=os.path.join(REPO_ROOT, "assets", "js", "obs-earth-data.js"))
    ap.add_argument("--tol", type=float, default=0.08,
                    help="Douglas-Peucker tolerance in degrees (default 0.08)")
    ap.add_argument("--ntest", type=int, default=12,
                    help="how many official WMM test vectors to bundle (default 12)")
    ap.add_argument("--fetch", action="store_true",
                    help="re-download the Natural Earth land file before generating")
    ap.add_argument("--textures", action="store_true",
                    help="build images/obs/earth-day-2048.jpg and earth-night-2048.jpg "
                         "from the NASA GIBS captures and exit")
    ap.add_argument("--stars", action="store_true",
                    help="build images/obs/stars-8k.bin from assets/js/voyage-bg.js and exit")
    ap.add_argument("--texfix", default=os.path.join(
        REPO_ROOT, "_tests", "observatory", "r12", "globe", "fixtures"),
        help="directory holding the captured GIBS JPEGs")
    ap.add_argument("--imgdir", default=os.path.join(REPO_ROOT, "images", "obs"))
    ap.add_argument("--nstars", type=int, default=STAR_COUNT)
    args = ap.parse_args()

    # The three r12 assets are independent of the land and magnetic-model
    # inputs, so either switch runs on its own and exits.
    if args.textures or args.stars:
        if args.textures:
            day, big, night, creds = build_textures(args.texfix, args.imgdir, args.fetch)
            for p in (day, big, night, creds):
                sys.stdout.write("wrote %s  (%.1f KB)\n" % (p, os.path.getsize(p) / 1024.0))
            assert os.path.getsize(day) < 320 * 1024, "day texture over budget"
            assert os.path.getsize(big) < 600 * 1024, "wide day texture over budget"
            assert os.path.getsize(night) < 200 * 1024, "night texture over budget"
        if args.stars:
            vd = os.path.join(REPO_ROOT, "assets", "js", "voyage-data.js")
            out, n, bright, faint, unknown = build_stars(vd, args.imgdir, args.nstars)
            sys.stdout.write(
                "wrote %s  %d stars, magnitude %.2f to %.2f, %d without a colour "
                "index  (%.1f KB)\n"
                % (out, n, bright, faint, unknown, os.path.getsize(out) / 1024.0))
        return 0

    land = args.land or os.path.join(args.fixtures, "body_ne_110m_land.geojson")
    cof = args.cof or os.path.join(args.fixtures, "wmm2025.cof")
    tvals = args.testvals or os.path.join(args.fixtures, "wmm2025_testvalues.txt")

    if args.fetch:
        d = os.path.dirname(os.path.abspath(land))
        if d and not os.path.isdir(d):
            os.makedirs(d)
        fetch_land(land)

    for p in (land, cof, tvals):
        if not os.path.isfile(p):
            sys.stderr.write("missing input: %s\n" % p)
            return 2

    check_regions()

    raw_rings = load_rings(land)
    rings = []
    for r in raw_rings:
        s = simplify_ring(r, args.tol)
        if s and len(s) >= 4:
            rings.append(s)
    npoints = sum(len(r) for r in rings)
    assert npoints <= MAX_POINTS, "point budget blown: %d > %d" % (npoints, MAX_POINTS)
    assert len(rings) >= 60, "suspiciously few rings: %d" % len(rings)

    counts, blob = quantize(rings)

    # Round trip check: quantization error must stay under half a step.
    worst = 0.0
    vals = struct.unpack("<%dh" % (len(blob) // 2), blob)
    k = 0
    for ring in rings:
        for lon, lat in ring:
            worst = max(worst, abs(vals[k] / float(RING_SCALE) - lat),
                        abs(vals[k + 1] / float(RING_SCALE) - lon))
            k += 2
    assert worst <= 0.5 / RING_SCALE + 1e-9, "quantization error %.6f too large" % worst

    epoch, n_max, wmm_rows = load_wmm(cof)
    test_rows = load_test_values(tvals, args.ntest)

    cmd = " ".join([os.path.basename(sys.argv[0])] + sys.argv[1:])
    js = build_js(counts, blob, epoch, n_max, wmm_rows, test_rows, args.tol,
                  "python " + cmd)
    # House rule: no em dashes or en dashes anywhere. Written as escapes so this
    # guard does not itself trip a repo wide dash scan.
    assert chr(8212) not in js and chr(8211) not in js, "dash policy violation in output"

    outdir = os.path.dirname(os.path.abspath(args.out))
    if outdir and not os.path.isdir(outdir):
        os.makedirs(outdir)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(js)

    size = os.path.getsize(args.out)
    assert size < MAX_BYTES, "output too big: %d bytes" % size
    sys.stdout.write(
        "wrote %s\n  %d rings, %d points (tolerance %.3f deg), max quantization error %.5f deg\n"
        "  WMM epoch %.1f, degree %d, %d coefficient rows, %d test vectors\n"
        "  %d regions, %d probes checked\n  %d bytes (%.1f KB)\n"
        % (args.out, len(rings), npoints, args.tol, worst, epoch, n_max, len(wmm_rows),
           len(test_rows), len(REGIONS), len(REGION_PROBES), size, size / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
