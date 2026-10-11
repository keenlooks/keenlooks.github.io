"""Keep It Together (/keepittogether/): the trainer and the model exporter.

Self-contained, like make_fourinarow_model.py and make_lander_model.py. It holds:

  * the world, ported line for line from _tests/twoengineers/proto/env.py at
    MAPS["v4"] and the v2 config (doctrines.B_CFG plus the train_v4i B4 flags,
    budgets 24/1/1), including the focus-fire option, plus MAPS["v5"], which is
    the SHIPPED board since build spec v3 section 7.4 ruling 1 (v4 with the
    centre gorge narrowed to three tiles, 239 buildable). `--map` still defaults
    to v4 so every v4 path stays reproducible; the fixtures and the exported
    model are made with `--map v5`;
  * the per-tile feature encoder, ported from proto/train_smoke.py Builder;
  * the CEM trainer for Stage A;
  * hashState (FNV-1a 32 bit) in the field order pinned in
    _tests/twoengineers/INTERFACES.md, which is what the browser core replays
    against;
  * the parity fixtures (P2 recorded episode, P3 free rollouts);
  * the int8 export of assets/js/keepittogether-model.js.

The prototype under _tests/twoengineers/proto/ stays as the reference. Run

    python -u make_keepittogether_model.py --verify-proto --n 200

to replay this port against it and assert identical scores, wave logs and
final-state hashes.

Usage

    python -u make_keepittogether_model.py --selftest
    python -u make_keepittogether_model.py --verify-proto --n 200
    python -u make_keepittogether_model.py --fixtures --map v5 --roll 200
    python -u make_keepittogether_model.py --placeholder-model --map v5 --net-seed 20260905
    python -u make_keepittogether_model.py --s0 --map v5 --n 200 --target 42
    python -u make_keepittogether_model.py --train --seed 501 --minutes 58 \
        --hidden 48 --out _tests/twoengineers/train
"""

from collections import deque
import argparse
import base64
import heapq
import json
import math
import os
import random
import struct
import sys
import time

import numpy as np

INF = 1 << 30

# ---------------------------------------------------------------- the world

G = "."


def _spans_v4():
    """Map v4, the shipped board: 28 x 19, 243 buildable tiles, three gates.

    Rows 0 to 5 are three gates and three gorges with alcoves; 6 to 8 are a
    gallery right across the map; 9 to 11 a canyon with a butte and two hanging
    pockets; 12 to 14 a bowl; 15 to 17 the keep on the floor with a four wide
    gap to its west and a six wide gap to its east.
    """
    return {
        0:  [("W", 2, 4), ("C", 12, 15), ("E", 23, 25)],
        1:  [(G, 2, 4), (G, 12, 15), (G, 23, 25)],
        2:  [(G, 2, 5), (G, 12, 15), (G, 22, 25)],
        3:  [(G, 2, 5), (G, 11, 15), (G, 23, 25)],
        4:  [(G, 1, 4), (G, 12, 16), (G, 23, 26)],
        5:  [(G, 2, 4), (G, 12, 15), (G, 23, 25)],
        6:  [(G, 2, 25)],
        7:  [(G, 2, 25)],
        8:  [(G, 2, 25)],
        9:  [(G, 4, 5), (G, 7, 20), (G, 22, 23)],
        10: [(G, 7, 8), (G, 11, 20)],
        11: [(G, 7, 8), (G, 11, 20)],
        12: [(G, 7, 20)],
        13: [(G, 7, 20)],
        14: [(G, 7, 20)],
        15: [(G, 7, 10), ("K", 11, 14), (G, 15, 20)],
        16: [(G, 7, 10), ("K", 11, 14), (G, 15, 20)],
        17: [(G, 7, 10), ("K", 11, 14), (G, 15, 20)],
    }


def _rows_from_spans(w, h, spans):
    grid = [["#"] * w for _ in range(h)]
    for y, items in spans.items():
        for (ch, a, b) in items:
            for x in range(a, b + 1):
                grid[y][x] = ch
    return ["".join(r) for r in grid]


MAP_V4 = _rows_from_spans(28, 19, _spans_v4())


def _spans_v5():
    """Map v5: map v4 with the CENTRE gate narrowed from four tiles to three,
    so all three gorges are the same width. This is W4-map section 8b's board,
    and it exists here ONLY for the diagnosis pass of build spec v3 section
    7.2 remedy (b). It is not the shipped world: `--map` defaults to v4 and
    every v4 path in this file is untouched. The rows are copied from
    `_tests/twoengineers/train/mapv5.py`, which is where the board was
    designed and where its world gates are run.
    """
    return {
        0:  [("W", 2, 4), ("C", 13, 15), ("E", 23, 25)],
        1:  [(G, 2, 4), (G, 13, 15), (G, 23, 25)],
        2:  [(G, 2, 5), (G, 12, 15), (G, 22, 25)],
        3:  [(G, 2, 5), (G, 13, 16), (G, 23, 25)],
        4:  [(G, 1, 4), (G, 12, 15), (G, 23, 26)],
        5:  [(G, 2, 4), (G, 13, 15), (G, 23, 25)],
        6:  [(G, 2, 25)],
        7:  [(G, 2, 25)],
        8:  [(G, 2, 25)],
        9:  [(G, 4, 5), (G, 7, 20), (G, 22, 23)],
        10: [(G, 7, 8), (G, 11, 20)],
        11: [(G, 7, 8), (G, 11, 20)],
        12: [(G, 7, 20)],
        13: [(G, 7, 20)],
        14: [(G, 7, 20)],
        15: [(G, 7, 10), ("K", 11, 14), (G, 15, 20)],
        16: [(G, 7, 10), ("K", 11, 14), (G, 15, 20)],
        17: [(G, 7, 10), ("K", 11, 14), (G, 15, 20)],
    }


MAP_V5 = _rows_from_spans(28, 19, _spans_v5())

MAPS = {"v4": MAP_V4, "v5": MAP_V5}

WALL = "wall"
TURRET = "turret"
COST = {WALL: "wall_cost", TURRET: "turret_cost"}
MAXHP = {WALL: "wall_hp", TURRET: "turret_hp"}
NEIGH = ((0, -1), (-1, 0), (1, 0), (0, 1))

# The v2 config: doctrines.B_CFG with the train_v4i B4 overrides and budgets
# 24/1/1, which is 26 plus or minus 2 credits per engineer in one build phase.
CFG = dict(
    keep_hp=100,
    dig_cost=6,
    wall_cost=2,
    wall_hp=400,
    turret_cost=10,
    turret_hp=400,
    turret_range=2.0,
    turret_period=2,
    turret_damage=10,
    gun_needs_stall=1,
    walker_hp=30,
    walker_move_period=2,
    walker_attack=5,
    walker_keep_damage=4,
    wave_walkers=(8, 15, 23),
    wave_walker_jitter=1,
    gate_weights=(0.7, 0.15, 0.15),
    gate_weights3=(0.55, 0.06, 0.06, 0.06, 0.09, 0.09, 0.09),
    spawn_gap=4,
    budgets=(24, 1, 1),
    budget_jitter=2,
    n_rubble=5,
    n_ruins=3,
    wave_max_ticks=600,
    mounted_guns=False,
    focus_fire=0,
    focus_seats=(0, 0),
    focus_mode="smart",
    focus_scope="own",
    focus_tier="door",
)


class Terrain(object):
    def __init__(self, rows):
        self.rows = list(rows)
        self.h = len(rows)
        self.w = len(rows[0])
        for r in rows:
            assert len(r) == self.w, "ragged map row: %r" % (r,)
        self.cell = [list(r) for r in rows]
        self.keep = [(x, y) for y in range(self.h) for x in range(self.w)
                     if self.cell[y][x] == "K"]
        self.gate_w = [(x, y) for y in range(self.h) for x in range(self.w)
                       if self.cell[y][x] == "W"]
        self.gate_e = [(x, y) for y in range(self.h) for x in range(self.w)
                       if self.cell[y][x] == "E"]
        self.gate_c = [(x, y) for y in range(self.h) for x in range(self.w)
                       if self.cell[y][x] == "C"]
        self.buildable = [(x, y) for y in range(self.h) for x in range(self.w)
                          if self.cell[y][x] == "."]
        assert self.keep and self.gate_w and self.gate_e
        self._build_pnbrs()

    def passable(self, x, y):
        if x < 0 or y < 0 or x >= self.w or y >= self.h:
            return False
        return self.cell[y][x] in ".WEC"

    def neighbours(self, x, y):
        for dx, dy in NEIGH:
            nx, ny = x + dx, y + dy
            if 0 <= nx < self.w and 0 <= ny < self.h:
                yield nx, ny

    def _build_pnbrs(self):
        self.pnbrs = {}
        for y in range(self.h):
            for x in range(self.w):
                if not (self.passable(x, y) or self.cell[y][x] == "K"):
                    continue
                self.pnbrs[(x, y)] = tuple(
                    (nx, ny) for (nx, ny) in self.neighbours(x, y)
                    if self.passable(nx, ny))


class Episode(object):
    """One randomized episode: rubble, ruins, the three waves, the budgets.

    The draw is Python's Mersenne Twister, exactly as proto/env.py draws it, so
    --verify-proto can compare episode for episode. The browser never draws
    these: the parity fixtures carry every episode fully resolved (INTERFACES
    T1 pin 5).
    """

    def __init__(self, seed, terrain, cfg):
        self.seed = seed
        self.terrain = terrain
        self.cfg = cfg
        rng = random.Random(seed * 7919 + 13)
        self.rng = rng

        pool = list(terrain.buildable)
        rng.shuffle(pool)
        self.rubble_list = list(pool[: cfg["n_rubble"]])
        self.rubble = set(self.rubble_list)
        ruin_pool = pool[cfg["n_rubble"]:]
        ruins = []
        for tile in ruin_pool:
            if len(ruins) >= cfg["n_ruins"]:
                break
            ruins.append(tile)
        self.ruin_list = list(ruins)
        self.ruins = set(ruins)

        self.waves = []
        three = bool(terrain.gate_c)
        for wi in range(3):
            n = cfg["wave_walkers"][wi]
            n += rng.randint(-cfg["wave_walker_jitter"], cfg["wave_walker_jitter"])
            n = max(2, n)
            if three:
                nw, nc, ne, mode = self._split3(rng, n, cfg)
            else:
                nc = 0
                mode = rng.choices(("both", "west", "east"),
                                   weights=cfg["gate_weights"])[0]
                if mode == "both":
                    share = rng.choice((0.3, 0.4, 0.5, 0.6, 0.7))
                    nw = max(1, min(n - 1, int(round(n * share))))
                    ne = n - nw
                elif mode == "west":
                    nw, ne = n, 0
                else:
                    nw, ne = 0, n
            gap = cfg["spawn_gap"] + rng.randint(-1, 1)
            self.waves.append(dict(mode=mode, west=nw, centre=nc, east=ne,
                                   gap=max(2, gap), offset=rng.randint(0, 3)))

        self.budgets = []
        for wi in range(3):
            base = cfg["budgets"][wi]
            j = cfg["budget_jitter"]
            self.budgets.append((base + rng.randint(-j, j),
                                 base + rng.randint(-j, j)))

    @staticmethod
    def _split3(rng, n, cfg):
        modes = ("all", "west", "centre", "east", "wc", "ce", "we")
        mode = rng.choices(modes, weights=cfg["gate_weights3"])[0]
        live = {"all": "wce", "west": "w", "centre": "c", "east": "e",
                "wc": "wc", "ce": "ce", "we": "we"}[mode]
        shares = [rng.choice((0.2, 0.3, 0.4, 0.5, 0.6)) for _ in live]
        tot = sum(shares)
        counts = [max(1, int(round(n * s / tot))) for s in shares]
        while sum(counts) > n and max(counts) > 1:
            counts[counts.index(max(counts))] -= 1
        while sum(counts) < n:
            counts[counts.index(min(counts))] += 1
        out = dict(zip(live, counts))
        return out.get("w", 0), out.get("c", 0), out.get("e", 0), mode

    def record(self):
        """The fixture record of INTERFACES T1 pin 5."""
        return dict(
            seed=self.seed,
            rubble=[[x, y] for (x, y) in self.rubble_list],
            ruins=[[x, y] for (x, y) in self.ruin_list],
            waves=[dict(mode=w["mode"], west=w["west"], centre=w["centre"],
                        east=w["east"], gap=w["gap"], offset=w["offset"])
                   for w in self.waves],
            budgets=[[int(a), int(b)] for (a, b) in self.budgets],
        )


class Walker(object):
    __slots__ = ("wid", "x", "y", "hp", "phase", "stuck", "atk")

    def __init__(self, wid, x, y, hp, phase):
        self.wid = wid
        self.x = x
        self.y = y
        self.hp = hp
        self.phase = phase
        self.stuck = 0
        self.atk = False


class FocusPolicy(object):
    """The scripted stand-in for a visitor tapping one planted walker.

    Ported from proto/env.py. On the page the mark comes from the visitor's own
    tap; this class is what the audit used to measure the verb.
    """

    __slots__ = ("seats", "mode", "scope", "tier", "mark", "taps", "drops")

    def __init__(self, seats, mode="smart", scope="own", tier="mark"):
        self.seats = (bool(seats[0]), bool(seats[1]))
        self.mode = mode
        self.scope = scope
        self.tier = tier
        self.mark = [None, None]
        self.taps = [0, 0]
        self.drops = [0, 0]
        if scope == "all" and self.seats[0] and self.seats[1]:
            raise ValueError("focus_scope 'all' is ambiguous with both seats on")

    def mark_for(self, owner):
        if owner not in (0, 1):
            return None
        if self.scope == "all":
            for side in (0, 1):
                if self.seats[side]:
                    return self.mark[side]
            return None
        if not self.seats[owner]:
            return None
        return self.mark[owner]

    def key(self, wk, mark, dd):
        if self.tier == "door":
            if dd <= 1:
                return (0, dd, wk.wid)
            return (1 if wk.wid == mark else 2, dd, wk.wid)
        return (0 if wk.wid == mark else 1, dd, wk.wid)

    def update(self, game, walkers, d, rng2):
        live = {}
        for wk in walkers:
            if wk.hp > 0:
                live[wk.wid] = wk
        need = False
        for side in (0, 1):
            if not self.seats[side]:
                continue
            cur = self.mark[side]
            if cur is not None:
                wk = live.get(cur)
                if wk is not None and wk.atk:
                    continue
                self.mark[side] = None
                self.drops[side] += 1
            need = True
        if not need:
            return
        cand = self._planted(game, walkers, d, rng2)
        if not cand:
            return
        for side in (0, 1):
            if not self.seats[side] or self.mark[side] is not None:
                continue
            pick = self._pick(side, cand)
            if pick is not None:
                self.mark[side] = pick
                self.taps[side] += 1

    def _planted(self, game, walkers, d, rng2):
        guns = []
        for tile, s in game.struct.items():
            if s["kind"] == TURRET and s["owner"] in (0, 1):
                guns.append((tile[0], tile[1], s["owner"]))
        out = []
        for wk in walkers:
            if wk.hp <= 0 or not wk.atk:
                continue
            g0 = 0
            g1 = 0
            for tx, ty, owner in guns:
                dx = wk.x - tx
                dy = wk.y - ty
                if dx * dx + dy * dy > rng2:
                    continue
                if owner:
                    g1 += 1
                else:
                    g0 += 1
            out.append((wk.wid, wk.hp, d[wk.y][wk.x], g0, g1))
        return out

    def _pick(self, side, cand):
        best = None
        bestkey = None
        for wid, hp, dd, g0, g1 in cand:
            reach = (g0 + g1) if self.scope == "all" else (g1 if side else g0)
            if self.mode == "smart":
                if reach <= 0:
                    continue
                key = (-reach, hp, wid)
            elif self.mode == "naive":
                key = (dd, wid)
            else:
                key = (-dd, -hp, wid)
            if bestkey is None or key < bestkey:
                bestkey = key
                best = wid
        return best


def _make_focus(cfg):
    if not cfg.get("focus_fire", 0):
        return None
    seats = cfg.get("focus_seats", (0, 0))
    if not (seats[0] or seats[1]):
        return None
    return FocusPolicy(seats, cfg.get("focus_mode", "smart"),
                       cfg.get("focus_scope", "own"),
                       cfg.get("focus_tier", "mark"))


class Game(object):
    def __init__(self, episode, cfg=None):
        self.ep = episode
        self.cfg = cfg or episode.cfg
        self.t = episode.terrain
        self.keep_hp = self.cfg["keep_hp"]
        self.struct = {}
        for tile in getattr(episode, "ruin_list", list(episode.ruins)):
            self.struct[tile] = dict(kind=WALL, hp=self.cfg["wall_hp"],
                                     max=self.cfg["wall_hp"], owner="ruin")
        self._dist = None
        self._dig = None
        self.leaks = 0
        self.spent = [0, 0]
        # Structures of each seat destroyed during the wave that is running, or
        # that ran most recently. Reset at the top of run_wave and incremented
        # where a structure is deleted. Bookkeeping ONLY: no decision, no RNG
        # draw and no field in hash_state reads it, so adding it changed no
        # game (train/stageb/nochange-*.txt is the proof). Its one consumer is
        # feature 34 of board_summary (T2a, build spec v3 section 7.8 ruling 1).
        self.lost = [0, 0]
        self.log = []
        self.wave_index = 0
        self.focus = _make_focus(self.cfg)

    # ---- building

    def can_build(self, x, y):
        if self.t.cell[y][x] != ".":
            return False
        if (x, y) in self.ep.rubble:
            return False
        if (x, y) in self.struct:
            return False
        return True

    def can_mount(self, x, y):
        s = self.struct.get((x, y))
        if s is None or s["kind"] != WALL:
            return False
        return s["owner"] in (0, 1)

    def place(self, x, y, kind, owner):
        prev = self.struct.get((x, y))
        self.struct[(x, y)] = dict(kind=kind, hp=self.cfg[MAXHP[kind]],
                                   max=self.cfg[MAXHP[kind]], owner=owner)
        if prev is not None and prev["kind"] == WALL and kind == TURRET:
            self.struct[(x, y)]["wall_owner"] = prev["owner"]
        self._dist = None
        self._dig = None

    def repair_all(self):
        for s in self.struct.values():
            s["hp"] = s["max"]

    # ---- fields

    def open_tile(self, x, y):
        return self.t.passable(x, y) and (x, y) not in self.struct

    def dist(self):
        if self._dist is not None:
            return self._dist
        t = self.t
        pn = t.pnbrs
        struct = self.struct
        d = [[INF] * t.w for _ in range(t.h)]
        dq = deque()
        for (kx, ky) in t.keep:
            d[ky][kx] = 0
            dq.append((kx, ky))
        while dq:
            x, y = dq.popleft()
            nd = d[y][x] + 1
            for tile in pn[(x, y)]:
                nx, ny = tile
                if d[ny][nx] > nd and tile not in struct:
                    d[ny][nx] = nd
                    dq.append(tile)
        self._dist = d
        return d

    def dig(self):
        if self._dig is not None:
            return self._dig
        t = self.t
        pn = t.pnbrs
        struct = self.struct
        cost = self.cfg["dig_cost"]
        d = [[INF] * t.w for _ in range(t.h)]
        pq = []
        for (kx, ky) in t.keep:
            d[ky][kx] = 0
            heapq.heappush(pq, (0, kx, ky))
        while pq:
            cur, x, y = heapq.heappop(pq)
            if cur > d[y][x]:
                continue
            for tile in pn[(x, y)]:
                nx, ny = tile
                nd = cur + (cost if tile in struct else 1)
                if nd < d[ny][nx]:
                    d[ny][nx] = nd
                    heapq.heappush(pq, (nd, nx, ny))
        self._dig = d
        return d

    # ---- wave

    def run_wave(self, wave_index, trace=None):
        """The wave. trace, when given, is called as trace(kind, tick, walkers)
        after every tick and at the end, and changes nothing."""
        cfg = self.cfg
        w = self.ep.waves[wave_index]
        t = self.t
        self.wave_index = wave_index
        self.lost = [0, 0]

        queue = []
        wid = 0
        west = list(t.gate_w)
        east = list(t.gate_e)
        centre = list(t.gate_c)
        for i in range(w["west"]):
            tile = west[(i + w["offset"]) % len(west)]
            queue.append((w["offset"] + i * w["gap"], tile, wid))
            wid += 1
        for i in range(w["east"]):
            tile = east[(i + w["offset"]) % len(east)]
            queue.append((w["offset"] + i * w["gap"], tile, wid))
            wid += 1
        for i in range(w.get("centre", 0)):
            tile = centre[(i + w["offset"]) % len(centre)]
            queue.append((w["offset"] + i * w["gap"], tile, wid))
            wid += 1
        queue.sort()
        qi = 0

        walkers = []
        occupied = {}
        tick = 0
        arrived = 0
        killed = 0
        while tick < cfg["wave_max_ticks"]:
            while qi < len(queue) and queue[qi][0] <= tick:
                _, (sx, sy), sid = queue[qi]
                if (sx, sy) in occupied:
                    break
                wk = Walker(sid, sx, sy, cfg["walker_hp"],
                            sid % cfg["walker_move_period"])
                walkers.append(wk)
                occupied[(sx, sy)] = wk
                qi += 1

            if not walkers and qi >= len(queue):
                break

            if tick % cfg["turret_period"] == 0 and walkers:
                self._turrets_fire(walkers)
                dead = [wk for wk in walkers if wk.hp <= 0]
                for wk in dead:
                    if occupied.get((wk.x, wk.y)) is wk:
                        del occupied[(wk.x, wk.y)]
                    walkers.remove(wk)
                    killed += 1

            gone = []
            for wk in list(walkers):
                res = self._walker_act(wk, tick, occupied)
                if res == "arrive":
                    gone.append(wk)
                    arrived += 1
            for wk in gone:
                if occupied.get((wk.x, wk.y)) is wk:
                    del occupied[(wk.x, wk.y)]
                walkers.remove(wk)

            if trace is not None:
                trace("t", tick, walkers)
            if self.keep_hp <= 0:
                break
            tick += 1

        for wk in walkers:
            self.keep_hp -= cfg["walker_keep_damage"]
            arrived += 1
        self.keep_hp = max(0, self.keep_hp)
        self.leaks += arrived
        self.log.append(dict(wave=wave_index, ticks=tick, arrived=arrived,
                             killed=killed, keep=self.keep_hp))
        if trace is not None:
            trace("w", tick, [])
        return arrived

    def _turrets_fire(self, walkers):
        cfg = self.cfg
        rng2 = cfg["turret_range"] * cfg["turret_range"]
        d = self.dist()
        dg = self.dig()
        stall_only = cfg.get("gun_needs_stall", 0)
        focus = self.focus
        if focus is not None:
            focus.update(self, walkers, d, rng2)
        for (tx, ty), s in self.struct.items():
            if s["kind"] != TURRET:
                continue
            mark = None if focus is None else focus.mark_for(s["owner"])
            best = None
            bestkey = None
            for wk in walkers:
                if wk.hp <= 0:
                    continue
                if stall_only and not (wk.atk or d[wk.y][wk.x] <= 1):
                    continue
                dx = wk.x - tx
                dy = wk.y - ty
                if dx * dx + dy * dy > rng2:
                    continue
                dd = d[wk.y][wk.x]
                if dd >= INF:
                    dd = INF + dg[wk.y][wk.x]
                key = (dd, wk.wid) if mark is None else focus.key(wk, mark, dd)
                if bestkey is None or key < bestkey:
                    bestkey = key
                    best = wk
            if best is not None:
                best.hp -= cfg["turret_damage"]

    def _walker_act(self, wk, tick, occupied):
        cfg = self.cfg
        d = self.dist()
        cur = d[wk.y][wk.x]
        if cur < INF:
            wk.atk = False
            if tick % cfg["walker_move_period"] != wk.phase:
                return None
            if cur <= 1:
                self.keep_hp = max(0, self.keep_hp - cfg["walker_keep_damage"])
                return "arrive"
            return self._step_down(wk, d, cur, occupied)
        dg = self.dig()
        best = None
        bestv = INF
        for nx, ny in self.t.neighbours(wk.x, wk.y):
            if not self.t.passable(nx, ny) and self.t.cell[ny][nx] != "K":
                continue
            v = dg[ny][nx]
            if v < bestv:
                bestv = v
                best = (nx, ny)
        if best is None:
            wk.atk = False
            return None
        if best in self.struct:
            wk.atk = True
            s = self.struct[best]
            s["hp"] -= cfg["walker_attack"]
            if s["hp"] <= 0:
                so = s["owner"]
                if so == 0 or so == 1:
                    self.lost[so] += 1
                del self.struct[best]
                self._dist = None
                self._dig = None
            return None
        wk.atk = False
        if tick % cfg["walker_move_period"] != wk.phase:
            return None
        if self.t.cell[best[1]][best[0]] == "K":
            self.keep_hp = max(0, self.keep_hp - cfg["walker_keep_damage"])
            return "arrive"
        if best in occupied:
            return None
        del occupied[(wk.x, wk.y)]
        wk.x, wk.y = best
        occupied[best] = wk
        return None

    def _step_down(self, wk, d, cur, occupied):
        order = NEIGH[wk.wid % 4:] + NEIGH[: wk.wid % 4]
        forward = []
        lateral = []
        for dx, dy in order:
            nx, ny = wk.x + dx, wk.y + dy
            if not self.open_tile(nx, ny):
                continue
            v = d[ny][nx]
            if v == cur - 1:
                forward.append((nx, ny))
            elif v == cur:
                lateral.append((nx, ny))
        for tile in forward:
            if tile not in occupied:
                del occupied[(wk.x, wk.y)]
                wk.x, wk.y = tile
                occupied[tile] = wk
                wk.stuck = 0
                return None
        wk.stuck += 1
        if wk.stuck >= 3:
            for tile in lateral:
                if tile not in occupied:
                    del occupied[(wk.x, wk.y)]
                    wk.x, wk.y = tile
                    occupied[tile] = wk
                    wk.stuck = 0
                    return None
        return None


# ---------------------------------------------------------------- hashState

FNV_OFFSET = 2166136261
FNV_PRIME = 16777619
MASK32 = 0xFFFFFFFF
NO_MARK = 0xFFFFFFFF
KIND_CODE = {WALL: 0, TURRET: 1}


def _fnv_u32(h, v):
    v &= MASK32
    for shift in (0, 8, 16, 24):
        h = ((h ^ ((v >> shift) & 0xFF)) * FNV_PRIME) & MASK32
    return h


def hash_state(game, tick=0, walkers=None):
    """FNV-1a 32 bit over the integer state, in the field order pinned in
    _tests/twoengineers/INTERFACES.md (T1 pin 2). No float is ever hashed."""
    h = FNV_OFFSET
    w = game.t.w
    h = _fnv_u32(h, 0x4B495431)
    h = _fnv_u32(h, game.keep_hp)
    h = _fnv_u32(h, tick)
    h = _fnv_u32(h, game.wave_index)
    h = _fnv_u32(h, game.leaks)
    h = _fnv_u32(h, game.spent[0])
    h = _fnv_u32(h, game.spent[1])
    tiles = sorted(game.struct.keys(), key=lambda p: p[1] * w + p[0])
    h = _fnv_u32(h, len(tiles))
    for (x, y) in tiles:
        s = game.struct[(x, y)]
        owner = s["owner"]
        oc = 2 if owner == "ruin" else int(owner)
        h = _fnv_u32(h, x)
        h = _fnv_u32(h, y)
        h = _fnv_u32(h, KIND_CODE[s["kind"]])
        h = _fnv_u32(h, s["hp"])
        h = _fnv_u32(h, oc)
    live = sorted([wk for wk in (walkers or []) if wk.hp > 0],
                  key=lambda wk: wk.wid)
    h = _fnv_u32(h, len(live))
    for wk in live:
        h = _fnv_u32(h, wk.wid)
        h = _fnv_u32(h, wk.x)
        h = _fnv_u32(h, wk.y)
        h = _fnv_u32(h, wk.hp)
        h = _fnv_u32(h, wk.phase)
        h = _fnv_u32(h, wk.stuck)
        h = _fnv_u32(h, 1 if wk.atk else 0)
    fo = game.focus
    for side in (0, 1):
        m = NO_MARK
        if fo is not None and fo.mark[side] is not None:
            m = fo.mark[side]
        h = _fnv_u32(h, m)
    return h


# ---------------------------------------------------------------- features

N_LOCAL = 26
N_LOCAL3 = N_LOCAL + 1
N_GLOBAL = 8

# Feature 18 (live distance) is normalised by this, NOT by the board's own
# dnorm. proto/train_smoke.py scales the STATIC empty-board distance (feature 3)
# by dnorm = w + h = 47 and the LIVE distance by the module constant 24, and the
# shipped engineers were trained against exactly that pair. Verified against the
# prototype: using 47 in both places changes feature 18 by up to 0.49 and moves
# the very first placement of a game. Do not "unify" these two numbers.
DNORM_LIVE = 24.0

LOCAL_NAMES = [
    "bias", "nx", "ny", "d0", "flow0",
    "ybump0", "ybump1", "ybump2", "ybump3", "ybump4",
    "xbump0", "xbump1", "xbump2", "xbump3", "xbump4",
    "rowwidth", "dwest", "deast",
    "livedist", "liveflow", "adj_h", "adj_v", "adj_mine", "adj_partner",
    "turret_cov", "adj_ruin", "dcentre",
]
GLOBAL_NAMES = [
    "budget", "wave0", "wave1", "wave2", "seat", "mine", "partner", "turn",
]
SUMMARY_NAMES = (
    ["partner_walls", "partner_guns", "partner_wall_share"]
    + ["row_share%d" % k for k in range(10)]
    + ["colband_share%d" % k for k in range(7)]
    + ["wall_dist", "gun_dist", "contiguity", "longest_run",
       "west_half", "valleys", "keep_frontage", "mean_flow0",
       "guns_on_walls", "credits_left"]
    + ["wave0", "wave1", "wave2", "seat", "lost_last_wave", "bias"]
)


def _multi_bfs(terrain, sources):
    big = 1 << 20
    d = [[big] * terrain.w for _ in range(terrain.h)]
    dq = deque()
    for (x, y) in sources:
        d[y][x] = 0
        dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        nd = d[y][x] + 1
        for nx, ny in terrain.neighbours(x, y):
            if not terrain.passable(nx, ny):
                continue
            if d[ny][nx] > nd:
                d[ny][nx] = nd
                dq.append((nx, ny))
    return d


def flow_field(board, dist):
    """Expected walker traffic per tile. Unit mass 1/3 per gate GROUP, split
    evenly among that group's gate tiles, running down the dist gradient and
    splitting evenly between forward neighbours.

    The accumulation order is pinned (INTERFACES T1 pin 3) because float
    addition is not associative: buckets are filled scanning y ascending then x
    ascending and processed by distance descending, and forward neighbours are
    taken in NEIGH order.
    """
    h, w = board.h, board.w
    flow = [[0.0] * w for _ in range(h)]
    buckets = {}
    for y in range(h):
        drow = dist[y]
        for x in range(w):
            v = drow[x]
            if v < INF:
                buckets.setdefault(v, []).append((x, y))
    for (x, y, m) in board.gate_src:
        if dist[y][x] < INF:
            flow[y][x] += m
    for v in sorted(buckets.keys(), reverse=True):
        if v <= 1:
            continue
        want = v - 1
        for (x, y) in buckets[v]:
            m = flow[y][x]
            if m <= 0.0:
                continue
            fwd = [(nx, ny) for (nx, ny) in board.pnb[(x, y)]
                   if dist[ny][nx] == want]
            if not fwd:
                continue
            share = m / len(fwd)
            for (nx, ny) in fwd:
                flow[ny][nx] += share
    return flow


def flow_field_sorted(board, dist):
    """The STATIC traffic field, feature 4 only.

    proto/train_smoke.py computes the empty-board field with a fully sorted
    traversal and the live field with a bucket sort, and float addition is not
    associative, so the two can differ in the last bits. The shipped engineers
    were trained against exactly this pair, so both orders are ported: sorted
    here for feature 4, bucketed in flow_field for feature 19.
    """
    h, w = board.h, board.w
    flow = [[0.0] * w for _ in range(h)]
    order = []
    for y in range(h):
        for x in range(w):
            if dist[y][x] < INF:
                order.append((dist[y][x], x, y))
    order.sort(reverse=True)
    for (x, y, m) in board.gate_src:
        if dist[y][x] < INF:
            flow[y][x] += m
    for (dv, x, y) in order:
        m = flow[y][x]
        if m <= 0.0 or dv <= 1:
            continue
        fwd = [(nx, ny) for nx, ny in board.t.neighbours(x, y)
               if dist[ny][nx] == dv - 1]
        if not fwd:
            continue
        share = m / len(fwd)
        for (nx, ny) in fwd:
            flow[ny][nx] += share
    return flow


class _EmptyEpisode(object):
    def __init__(self, terrain, cfg):
        self.terrain = terrain
        self.cfg = cfg
        self.rubble = set()
        self.ruins = set()
        self.ruin_list = []
        self.rubble_list = []
        self.seed = 0
        self.waves = []
        self.budgets = []


class Board(object):
    """Everything about the terrain that never changes between episodes."""

    def __init__(self, terrain, cfg):
        self.t = terrain
        self.cfg = cfg
        self.w = terrain.w
        self.h = terrain.h
        self.tiles = list(terrain.buildable)
        self.n = len(self.tiles)
        self.idx = {tile: i for i, tile in enumerate(self.tiles)}
        self.xs = np.array([t[0] for t in self.tiles], dtype=np.float64)
        self.ys = np.array([t[1] for t in self.tiles], dtype=np.float64)

        self.three = bool(terrain.gate_c)
        self.n_local = N_LOCAL3 if self.three else N_LOCAL
        self.n_in = self.n_local + N_GLOBAL

        self.pnb = {}
        for y in range(self.h):
            for x in range(self.w):
                if terrain.passable(x, y) or terrain.cell[y][x] == "K":
                    self.pnb[(x, y)] = [(nx, ny) for nx, ny
                                        in terrain.neighbours(x, y)
                                        if terrain.passable(nx, ny)]
        share = (1 / 3.0) if self.three else 0.5
        self.gate_src = ([(x, y, share / len(terrain.gate_w))
                          for (x, y) in terrain.gate_w] +
                         [(x, y, share / len(terrain.gate_e))
                          for (x, y) in terrain.gate_e] +
                         ([(x, y, share / len(terrain.gate_c))
                           for (x, y) in terrain.gate_c] if self.three else []))

        g = Game(_EmptyEpisode(terrain, cfg), cfg)
        d0 = np.array(g.dist(), dtype=np.float64)
        f0 = flow_field_sorted(self, g.dist())
        self.dist0 = g.dist()

        rowcount = np.zeros(self.h)
        for (x, y) in self.tiles:
            rowcount[y] += 1

        self.dnorm = float(self.w + self.h)
        self.rowmax = float(max(1.0, rowcount.max()))
        self.bnorm = float(cfg["budgets"][0])
        self.cnorm = float(cfg["budgets"][0]) / cfg["wall_cost"]
        yb = tuple((k + 0.5) * self.h / 5.0 for k in range(5))
        xb = tuple((k + 0.5) * self.w / 5.0 for k in range(5))
        ysig = self.h / 8.0
        xsig = self.w / 8.0
        self.yb, self.xb, self.ysig, self.xsig = yb, xb, ysig, xsig

        dw = _multi_bfs(terrain, terrain.gate_w)
        de = _multi_bfs(terrain, terrain.gate_e)
        dc = _multi_bfs(terrain, terrain.gate_c) if self.three else None

        S = np.zeros((self.n, self.n_local))
        for i, (x, y) in enumerate(self.tiles):
            S[i, 0] = 1.0
            S[i, 1] = x / float(self.w - 1)
            S[i, 2] = y / float(self.h - 1)
            S[i, 3] = min(d0[y][x], self.dnorm) / self.dnorm
            S[i, 4] = math.log1p(f0[y][x]) / 2.0
            for k, c in enumerate(yb):
                S[i, 5 + k] = math.exp(-0.5 * ((y - c) / ysig) ** 2)
            for k, c in enumerate(xb):
                S[i, 10 + k] = math.exp(-0.5 * ((x - c) / xsig) ** 2)
            S[i, 15] = rowcount[y] / self.rowmax
            S[i, 16] = min(dw[y][x], self.dnorm) / self.dnorm
            S[i, 17] = min(de[y][x], self.dnorm) / self.dnorm
            if self.three:
                S[i, N_LOCAL] = min(dc[y][x], self.dnorm) / self.dnorm
        self.static = S

        self.nb = -np.ones((self.n, 4), dtype=np.int32)
        for i, (x, y) in enumerate(self.tiles):
            for k, (dx, dy) in enumerate(((-1, 0), (1, 0), (0, -1), (0, 1))):
                self.nb[i, k] = self.idx.get((x + dx, y + dy), -1)

        r2 = cfg["turret_range"] ** 2
        cov = []
        for i in range(self.n):
            dx = self.xs - self.xs[i]
            dy = self.ys - self.ys[i]
            cov.append(np.where(dx * dx + dy * dy <= r2)[0])
        self.cov = cov

        self.flat = np.array([y * self.w + x for (x, y) in self.tiles],
                             dtype=np.int64)

    def feature_names(self):
        loc = list(LOCAL_NAMES[: self.n_local])
        return loc, list(GLOBAL_NAMES)


class Builder(object):
    """The per-episode ledgers the policy reads.

    These are PLACEMENT ledgers: they are never rolled back when a wave
    destroys a structure. That is what the shipped engineers were trained
    against (INTERFACES T1 pin 3).
    """

    def __init__(self, board, episode, game):
        self.b = board
        self.ep = episode
        self.g = game
        n = board.n
        self.free = np.ones(n, dtype=bool)
        self.owner = np.zeros(n, dtype=np.int8)
        self.occ = np.zeros(n, dtype=bool)
        self.turret_cov = np.zeros(n)
        for tile in episode.rubble:
            if tile in board.idx:
                self.free[board.idx[tile]] = False
        for tile in episode.ruins:
            if tile in board.idx:
                i = board.idx[tile]
                self.free[i] = False
                self.occ[i] = True
                self.owner[i] = 3
        self.counts = [0, 0]
        self.mounted = bool(game.cfg.get("mounted_guns"))
        self.mount = np.zeros(board.n, dtype=bool)

    def note_place(self, tile, kind, side):
        i = self.b.idx[tile]
        self.free[i] = False
        self.occ[i] = True
        self.owner[i] = 1 + side
        self.counts[side] += 1
        if kind == TURRET:
            self.turret_cov[self.b.cov[i]] += 1.0
            self.mount[i] = False
        else:
            if self.mounted:
                self.mount[i] = True

    def dynamic(self):
        b = self.b
        d = self.g.dist()
        dv = np.asarray(d, dtype=np.float64).ravel()
        live = np.minimum(dv[b.flat], DNORM_LIVE) / DNORM_LIVE
        f = flow_field(b, d)
        flw = np.log1p(np.asarray(f).ravel()[b.flat]) / 2.0

        nb = b.nb
        occ = np.concatenate([self.occ, [False]])
        own = np.concatenate([self.owner, [0]])
        ii = np.where(nb < 0, len(self.occ), nb)
        o = occ[ii]
        adj_h = (o[:, 0].astype(float) + o[:, 1]) / 2.0
        adj_v = (o[:, 2].astype(float) + o[:, 3]) / 2.0
        ow = own[ii]
        adj_a = (ow == 1).sum(axis=1) / 4.0
        adj_b = (ow == 2).sum(axis=1) / 4.0
        adj_r = (ow == 3).sum(axis=1) / 4.0
        return live, flw, adj_h, adj_v, adj_a, adj_b, adj_r

    def features(self, side, budget, wave, turn):
        b = self.b
        L = b.n_local
        live, flw, adj_h, adj_v, adj_a, adj_b, adj_r = self.dynamic()
        X = np.empty((b.n, b.n_in))
        X[:, :18] = b.static[:, :18]
        X[:, 18] = live
        X[:, 19] = flw
        X[:, 20] = adj_h
        X[:, 21] = adj_v
        X[:, 22] = adj_a if side == 0 else adj_b
        X[:, 23] = adj_b if side == 0 else adj_a
        X[:, 24] = np.minimum(self.turret_cov, 3.0) / 3.0
        X[:, 25] = adj_r
        if L > N_LOCAL:
            X[:, N_LOCAL] = b.static[:, N_LOCAL]
        X[:, L + 0] = budget / b.bnorm
        X[:, L + 1] = 1.0 if wave == 0 else 0.0
        X[:, L + 2] = 1.0 if wave == 1 else 0.0
        X[:, L + 3] = 1.0 if wave == 2 else 0.0
        X[:, L + 4] = float(side)
        X[:, L + 5] = self.counts[side] / b.cnorm
        X[:, L + 6] = self.counts[1 - side] / b.cnorm
        X[:, L + 7] = turn / b.cnorm
        return X


# ------------------------------------------------- the S = 36 board summary

# D2 section 3.3. The discriminator's input: what ONE seat has built, read off
# the board, never off its actions. Every entry is geometry or bookkeeping, and
# nothing in it knows a plan, which is the sentence the page's honesty card
# makes. SUMMARY_NAMES above is the feature order and this is its arithmetic;
# INTERFACES carries both so core can port it line for line.
#
# D2 wrote the table for a 14 x 10 board ("10 rows", "7 bands of 2 columns").
# The shipped board is 28 x 19, so the two banded blocks are BANDS over the
# board's own extent rather than literal rows and column pairs: ten row bands
# and seven column bands, each derived from the buildable tiles' bounding box,
# so the same code lands on v4 (243 tiles) and on v5 (239) with no constant.

N_SUMMARY = 36
S_ROWS = 10          # row bands, features 3 to 12
S_COLS = 7           # column bands, features 13 to 19
S_DNORM = 24.0       # the distance normaliser D2 section 3.3 names
S_WALL_NORM = 12.0
S_GUN_NORM = 8.0
S_RUN_NORM = 8.0
S_LOST_NORM = 6.0


def _clip01(v):
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def summary_tables(board):
    """The terrain-derived tables the summary reads, computed once per Board.

    ygal is the GALLERY row: the first row, scanning down, whose buildable
    tiles form one contiguous run. Every row above it is cut into separate
    corridors, and those rows are the valleys, which on v4 and v5 is exactly
    the three gorges (rows 1 to 5). Derived from the terrain rather than
    written down, so a new board needs no new constant.
    """
    tb = getattr(board, "_sumtab", None)
    if tb is not None:
        return tb
    t = board.t
    xs = [x for (x, y) in board.tiles]
    ys = [y for (x, y) in board.tiles]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    rows = {}
    for (x, y) in board.tiles:
        rows.setdefault(y, []).append(x)
    ygal = ymax + 1
    for y in range(t.h):
        row = rows.get(y)
        if not row:
            continue
        row = sorted(row)
        runs = 1
        for k in range(1, len(row)):
            if row[k] != row[k - 1] + 1:
                runs += 1
        if runs == 1:
            ygal = y
            break
    keepset = set(t.keep)
    n = board.n
    rowband = [0] * n
    colband = [0] * n
    west = [0.0] * n
    valley = [0.0] * n
    front = [0.0] * n
    dist = [0.0] * n
    flow = [0.0] * n
    d0 = board.dist0
    for i, (x, y) in enumerate(board.tiles):
        rowband[i] = int(((y - ymin) * S_ROWS) // (ymax - ymin + 1))
        colband[i] = int(((x - xmin) * S_COLS) // (xmax - xmin + 1))
        west[i] = 1.0 if (2 * x < t.w) else 0.0
        valley[i] = 1.0 if y < ygal else 0.0
        f = 0.0
        for (dx, dy) in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            if (x + dx, y + dy) in keepset:
                f = 1.0
                break
        front[i] = f
        dv = d0[y][x]
        dist[i] = (S_DNORM if dv > S_DNORM else float(dv)) / S_DNORM
        flow[i] = float(board.static[i, 4])
    tb = dict(rowband=rowband, colband=colband, west=west, valley=valley,
              front=front, dist=dist, flow=flow, ygal=ygal,
              xmin=xmin, xmax=xmax, ymin=ymin, ymax=ymax)
    board._sumtab = tb
    return tb


def board_summary(board, g, seat, wave, out=None):
    """S, the 36 wide summary of what `seat` has on the board right now.

    The scan is over board.tiles in INDEX ORDER (y ascending then x), not over
    the game's structure dict, so the accumulation order is the same in Python
    and in JS and the two encoders agree bit for bit. Live structures only:
    what a wave destroyed is gone from the board and shows up in feature 34.
    """
    tb = summary_tables(board)
    S = np.zeros(N_SUMMARY) if out is None else out
    if out is not None:
        S[:] = 0.0
    cfg = g.cfg
    wall_cost = float(cfg[COST[WALL]])
    gun_cost = float(cfg[COST[TURRET]])
    tiles = board.tiles
    struct = g.struct
    rowband = tb["rowband"]
    colband = tb["colband"]

    walls = 0
    guns = 0
    cred = 0.0
    wall_cred = 0.0
    wall_d = 0.0
    gun_d = 0.0
    flow_sum = 0.0
    nstruct = 0
    row = [0.0] * S_ROWS
    col = [0.0] * S_COLS
    west_c = 0.0
    valley_c = 0.0
    front_c = 0.0
    is_wall = [False] * board.n
    mine = [False] * board.n
    gun_idx = []
    wset = set()
    for i, tile in enumerate(tiles):
        s = struct.get(tile)
        if s is None or s["owner"] != seat:
            continue
        kind = s["kind"]
        c = wall_cost if kind == WALL else gun_cost
        mine[i] = True
        nstruct += 1
        cred += c
        row[rowband[i]] += c
        col[colband[i]] += c
        west_c += c * tb["west"][i]
        valley_c += c * tb["valley"][i]
        front_c += c * tb["front"][i]
        flow_sum += tb["flow"][i]
        if kind == WALL:
            walls += 1
            wall_cred += c
            wall_d += tb["dist"][i]
            is_wall[i] = True
            wset.add(tile)
        else:
            guns += 1
            gun_d += tb["dist"][i]
            gun_idx.append(i)

    S[0] = _clip01(walls / S_WALL_NORM)
    S[1] = _clip01(guns / S_GUN_NORM)
    S[2] = (wall_cred / cred) if cred > 0.0 else 0.0
    if cred > 0.0:
        for k in range(S_ROWS):
            S[3 + k] = row[k] / cred
        for k in range(S_COLS):
            S[13 + k] = col[k] / cred
        S[24] = west_c / cred
        S[25] = valley_c / cred
        S[26] = front_c / cred
    S[20] = (wall_d / walls) if walls else 0.0
    S[21] = (gun_d / guns) if guns else 0.0

    # contiguity: the share of this seat's walls with a 4-neighbour tile that
    # this seat also built, wall or gun.
    touch = 0
    if walls:
        for i in range(board.n):
            if not is_wall[i]:
                continue
            nb = board.nb[i]
            for k in range(4):
                j = nb[k]
                if j >= 0 and mine[j]:
                    touch += 1
                    break
    S[22] = (touch / float(walls)) if walls else 0.0

    # longest horizontal run of this seat's walls: start at every wall whose
    # left neighbour is not one, and walk right.
    best = 0
    for i, tile in enumerate(tiles):
        if not is_wall[i]:
            continue
        x, y = tile
        if (x - 1, y) in wset:
            continue
        run = 1
        while (x + run, y) in wset:
            run += 1
        if run > best:
            best = run
    S[23] = _clip01(best / S_RUN_NORM)

    S[27] = (flow_sum / nstruct) if nstruct else 0.0

    covering = 0
    for i in gun_idx:
        for j in board.cov[i]:
            if is_wall[j]:
                covering += 1
                break
    S[28] = (covering / float(guns)) if guns else 0.0

    granted = 0.0
    buds = getattr(g.ep, "budgets", None)
    if buds:
        for wi in range(min(wave + 1, len(buds))):
            b = buds[wi][seat]
            granted += b if b > 0 else 0
    S[29] = _clip01((granted - g.spent[seat]) / board.bnorm)

    S[30] = 1.0 if wave == 0 else 0.0
    S[31] = 1.0 if wave == 1 else 0.0
    S[32] = 1.0 if wave == 2 else 0.0
    S[33] = float(seat)
    S[34] = _clip01(g.lost[seat] / S_LOST_NORM)
    S[35] = 1.0
    return S


# ---------------------------------------------------------------- policy


def n_params(hidden, n_in):
    return n_in * hidden + hidden + hidden * 2 + 2


def unpack(theta, hidden, n_in):
    i = 0
    W1 = theta[i:i + n_in * hidden].reshape(n_in, hidden); i += n_in * hidden
    b1 = theta[i:i + hidden]; i += hidden
    W2 = theta[i:i + hidden * 2].reshape(hidden, 2); i += hidden * 2
    b2 = theta[i:i + 2]
    return W1, b1, W2, b2


def scores_blas(X, net):
    W1, b1, W2, b2 = net
    return np.tanh(X @ W1 + b1) @ W2 + b2


def scores_ref(X, net):
    """The REFERENCE accumulation order, which the browser core reproduces bit
    for bit: per hidden unit, sum over inputs ascending; per output column, sum
    over hidden units ascending. numpy's blocked BLAS sum is not this order, so
    the two can differ in the last bits, which is why the parity fixtures are
    generated with this one (INTERFACES T1 pin 6).

    Vectorised over tiles, sequential over the summed axis, so every element is
    accumulated in exactly the order a plain JS loop would use.
    """
    W1, b1, W2, b2 = net
    n, n_in = X.shape
    hidden = W1.shape[1]
    acc = np.zeros((n, hidden))
    for k in range(n_in):
        acc += X[:, k:k + 1] * W1[k]
    hv = np.tanh(acc + b1)
    out = np.zeros((n, 2))
    for hI in range(hidden):
        out += hv[:, hI:hI + 1] * W2[hI]
    return out + b2


def scores_ref_scalar(X, net):
    """The same order written out one scalar at a time. Slow; the selftest uses
    it to prove scores_ref really is that order."""
    W1, b1, W2, b2 = net
    n, n_in = X.shape
    hidden = W1.shape[1]
    out = np.empty((n, 2))
    for i in range(n):
        row = X[i]
        hv = np.empty(hidden)
        for hI in range(hidden):
            acc = 0.0
            for k in range(n_in):
                acc += row[k] * W1[k, hI]
            hv[hI] = math.tanh(acc + b1[hI])
        for c in range(2):
            acc = 0.0
            for hI in range(hidden):
                acc += hv[hI] * W2[hI, c]
            out[i, c] = acc + b2[c]
    return out


def choose(sc, bld, bud, cfg, want_margin=False):
    """Mask the illegal entries and take the flat argmax. Returns
    (tileIndex, kindIdx, margin) or None when nothing is affordable. The margin
    is the gap to the runner up; it costs a pass over the scores, so training
    does not ask for it and the fixtures do."""
    cw = cfg["wall_cost"]
    ct = cfg["turret_cost"]
    wall_ok = bld.free
    gun_ok = bld.mount if bld.mounted else bld.free
    can_w = bud >= cw and bool(wall_ok.any())
    can_g = bud >= ct and bool(gun_ok.any())
    if not (can_w or can_g):
        return None
    sc = sc.copy()
    if not can_w:
        sc[:, 0] = -1e9
    else:
        sc[~wall_ok, 0] = -1e9
    if not can_g:
        sc[:, 1] = -1e9
    else:
        sc[~gun_ok, 1] = -1e9
    flat = sc.ravel()
    k = int(np.argmax(flat))
    i, kind_i = divmod(k, 2)
    if not want_margin:
        return i, kind_i, 0.0
    top = flat[k]
    flat[k] = -1e18
    second = float(np.max(flat))
    flat[k] = top
    return i, kind_i, float(top - second)


def net_build_phase(board, bld, nets, budgets, wave, ref=False,
                    on_place=None, forced=None):
    """Both engineers place at once, alternating, each seeing the other's
    placements land. ref selects the reference accumulation order; forced, when
    given, is a list of (side, tileIndex, kindIdx) replayed instead of the
    policy (teacher forcing for the P2 fixture)."""
    g = bld.g
    cfg = g.cfg
    done = [False, False]
    side = 0
    turn = [0, 0]
    fi = 0
    margins = []
    while not (done[0] and done[1]):
        if done[side]:
            side ^= 1
            continue
        if forced is not None:
            if fi >= len(forced):
                done[0] = done[1] = True
                break
            fside, i, kind_i = forced[fi]
            if fside != side:
                done[side] = True
                side ^= 1
                continue
            fi += 1
        else:
            bud = budgets[side]
            X = bld.features(side, bud, wave, turn[side])
            sc = scores_ref(X, nets[side]) if ref else scores_blas(X, nets[side])
            pick = choose(sc, bld, bud, cfg, want_margin=ref)
            if pick is None:
                done[side] = True
                side ^= 1
                continue
            i, kind_i, margin = pick
            margins.append(margin)
        kind = WALL if kind_i == 0 else TURRET
        tile = board.tiles[i]
        g.place(tile[0], tile[1], kind, side)
        cost = cfg[COST[kind]]
        budgets[side] -= cost
        g.spent[side] += cost
        bld.note_place(tile, kind, side)
        turn[side] += 1
        if on_place is not None:
            on_place(side, i, kind_i)
        side ^= 1
    return budgets, margins


def play_net(board, episode, net_a, net_b, cfg, solo=False, ref=False,
             trace=None):
    g = Game(episode, cfg)
    bld = Builder(board, episode, g)
    margins = []
    for wi in range(3):
        ba, bb = episode.budgets[wi]
        if solo:
            bb = 0
        g.repair_all()
        g.wave_index = wi

        def on_place(side, i, kind_i, wi=wi):
            if trace is not None:
                trace("b", wi, side, i, kind_i, g, None)

        _, mm = net_build_phase(board, bld, (net_a, net_b),
                                [max(0, ba), max(0, bb)], wi, ref=ref,
                                on_place=on_place)
        margins.extend(mm)
        if trace is not None:
            g.run_wave(wi, trace=lambda kind, tick, walkers, wi=wi:
                       trace(kind, wi, None, None, None, g, (tick, walkers)))
        else:
            g.run_wave(wi)
        if g.keep_hp <= 0:
            break
    return g, margins


def evaluate(theta, hidden, board, eps, cfg):
    net = unpack(theta, hidden, board.n_in)
    tot = 0.0
    for ep in eps:
        g, _ = play_net(board, ep, net, net, cfg)
        tot += g.keep_hp
    return tot / len(eps)


# ---------------------------------------------------------------- CEM


def cem(args, board, cfg, log):
    """CEM with a sigma floor from the start and a HELD-OUT export selector.

    The prototype exported the generation whose mean was best on the CRN block
    it was training against, which is a 12 episode sample and swings by 20 keep
    HP between neighbouring generations. Here every eval_every generations the
    current mean is scored on a held-out block the trainer never trains on, and
    that is what selects the exported weights.
    """
    hidden = args.hidden
    P = n_params(hidden, board.n_in)
    rng = np.random.default_rng(args.seed)
    mean = np.zeros(P)
    std = np.full(P, args.sigma)
    if args.init:
        mean = np.load(args.init)
        assert mean.shape == (P,), ("--init has %d parameters, this run wants %d"
                                    % (mean.shape[0], P))
        std = np.full(P, args.init_sigma)
        log("resumed from %s at sigma %.3f" % (args.init, args.init_sigma))
    t = board.t
    t0 = time.time()
    deadline = t0 + args.minutes * 60.0
    gen = 0
    games = 0
    sel = [Episode(800000 + i, t, cfg) for i in range(args.seln)]
    best_theta = mean.copy()
    best_sel = -1.0
    best_gen = -1
    hist = []
    while (time.time() < deadline) and (args.gens <= 0 or gen < args.gens):
        blk = args.k
        base = args.seed * 1000 + (gen // args.refresh) * blk
        eps = [Episode(base + i, t, cfg) for i in range(blk)]
        pop = mean + std * rng.standard_normal((args.pop, P))
        vals = np.empty(args.pop)
        for j in range(args.pop):
            vals[j] = evaluate(pop[j], hidden, board, eps, cfg)
        games += args.pop * blk
        order = np.argsort(-vals)
        elite = pop[order[: args.elite]]
        mean = elite.mean(axis=0)
        std = np.maximum(elite.std(axis=0), args.floor)
        mval = evaluate(mean, hidden, board, eps, cfg)
        games += blk
        sval = float("nan")
        if gen % args.eval_every == 0:
            sval = evaluate(mean, hidden, board, sel, cfg)
            games += len(sel)
            if sval > best_sel:
                best_sel = sval
                best_theta = mean.copy()
                best_gen = gen
        hist.append((gen, float(vals[order[0]]), float(mval), sval))
        log("gen %3d  best %5.1f  elite %5.1f  mean %5.1f  sel %5.1f  "
            "bestsel %5.1f (gen %d)  sigma %.3f  %6.0fs  %d games"
            % (gen, vals[order[0]], vals[order[: args.elite]].mean(), mval,
               sval, best_sel, best_gen, std.mean(), time.time() - t0, games))
        if gen % args.ckpt_every == 0:
            np.save(os.path.join(args.out, "ck_%s_gen%04d.npy"
                                 % (args.tag, gen)), best_theta)
        gen += 1
    return best_theta, best_sel, best_gen, hist, games


# ---------------------------------------------------------------- fixtures


def _f32b64(arr):
    a = np.asarray(arr, dtype="<f4")
    return base64.b64encode(a.tobytes()).decode("ascii")


def random_net(hidden, n_in, seed, scale=0.5):
    """A random-weight net of the pinned shape at a pinned seed. The weights
    are rounded to float32 and read back, so the fixture carries exactly the
    numbers both languages compute with."""
    rng = np.random.default_rng(seed)
    theta = (rng.standard_normal(n_params(hidden, n_in)) * scale)
    theta = np.asarray(theta, dtype=np.float32).astype(np.float64)
    return theta


def _p2_margin(board, cfg, ep, net, hidden):
    g = Game(ep, cfg)
    bld = Builder(board, ep, g)
    worst = 1e18
    for wi in range(3):
        ba, bb = ep.budgets[wi]
        g.repair_all()
        g.wave_index = wi
        _, mm = net_build_phase(board, bld, (net, net),
                                [max(0, ba), max(0, bb)], wi, ref=True)
        if mm:
            worst = min(worst, min(mm))
        g.run_wave(wi)
        if g.keep_hp <= 0:
            break
    return worst


def make_fixtures(board, cfg, outdir, hidden, seed, n_roll, log,
                  map_name="v4"):
    """Write the P2 and P3 parity fixtures.

    The net seed is SEARCHED, as D2 section 10 asks: a near tie between two
    tiles would let a legitimate 1e-6 float difference flip a placement and fail
    the parity test for no real reason, so the exported fixture is the first
    candidate whose smallest argmax margin clears 1e-3.

    Each file also carries an `arch` block, `{map, tiles, nIn}`, so a reader
    READS the board a fixture was made on instead of deducing it (SEAM C3-S1).
    It is the last key written, so a file regenerated after this block was added
    is byte identical up to the insertion point.
    """
    os.makedirs(outdir, exist_ok=True)
    t = board.t
    ep_seed = seed
    probe = Episode(ep_seed, t, cfg)
    best = (seed, -1.0)
    for off in range(48):
        cand = seed + off
        th = random_net(hidden, board.n_in, cand)
        m = _p2_margin(board, cfg, probe, unpack(th, hidden, board.n_in), hidden)
        if m > best[1]:
            best = (cand, m)
        if m >= 1e-3:
            break
    seed, marg = best
    log("net seed %d chosen, smallest P2 argmax margin %.4g" % (seed, marg))
    theta = random_net(hidden, board.n_in, seed)
    net = unpack(theta, hidden, board.n_in)

    # ---- P2: one recorded three wave episode, teacher forced on replay
    ep = Episode(ep_seed, t, cfg)
    g = Game(ep, cfg)
    bld = Builder(board, ep, g)
    phases = []
    ticks = []
    all_margins = []
    for wi in range(3):
        ba, bb = ep.budgets[wi]
        g.repair_all()
        g.wave_index = wi
        acts = []

        def on_place(side, i, kind_i):
            acts.append([side, i, kind_i])
            ticks.append(dict(kind="b", wave=wi, h=hash_state(g, 0, [])))

        _, mm = net_build_phase(board, bld, (net, net),
                                [max(0, ba), max(0, bb)], wi, ref=True,
                                on_place=on_place)
        all_margins.extend(mm)
        phases.append(acts)

        def trace(kind, tick, walkers):
            ticks.append(dict(kind=kind, wave=wi, tick=tick,
                              h=hash_state(g, tick, walkers)))

        g.run_wave(wi, trace=trace)
        if g.keep_hp <= 0:
            break
    p2 = dict(
        note=("P2: one three wave episode played by a random weight net of the "
              "pinned shape, recorded with teacher forced actions and a "
              "hashState per tick. Replay it with the recorded actions, never "
              "with your own policy."),
        hidden=hidden, nIn=board.n_in, netSeed=seed, episodeSeed=ep_seed,
        net=dict(theta=_f32b64(theta), shape=[board.n_in, hidden]),
        episode=ep.record(),
        phases=phases,
        ticks=ticks,
        keepHp=int(g.keep_hp),
        waveLog=[dict(wave=r["wave"], ticks=r["ticks"], arrived=r["arrived"],
                      killed=r["killed"], keep=r["keep"]) for r in g.log],
        finalHash=int(hash_state(g, 0, [])),
        minMargin=float(min(all_margins)) if all_margins else 0.0,
        arch=dict(map=map_name, tiles=int(board.n), nIn=int(board.n_in)),
    )
    path2 = os.path.join(outdir, "episode-random.json")
    with open(path2, "w", newline="\n") as fh:
        json.dump(p2, fh, separators=(",", ":"))
    log("P2 written: %s  ticks %d  keep %d  minMargin %.4g"
        % (path2, len(ticks), g.keep_hp, p2["minMargin"]))

    # ---- P3: n free rollouts with the same net
    rolls = []
    near = 0
    worst = 1e18
    for s in range(n_roll):
        e = Episode(700000 + s, t, cfg)
        gg = Game(e, cfg)
        bb = Builder(board, e, gg)
        seq = []
        margins = []
        for wi in range(3):
            ba, bbud = e.budgets[wi]
            gg.repair_all()
            gg.wave_index = wi

            def on_place(side, i, kind_i, wi=wi):
                seq.append([wi, side, i, kind_i])

            _, mm = net_build_phase(board, bb, (net, net),
                                    [max(0, ba), max(0, bbud)], wi, ref=True,
                                    on_place=on_place)
            margins.extend(mm)
            gg.run_wave(wi)
            if gg.keep_hp <= 0:
                break
        mm = min(margins) if margins else 0.0
        if mm < 1e-5:
            near += 1
        worst = min(worst, mm)
        rolls.append(dict(episode=e.record(), actions=seq,
                          keepHp=int(gg.keep_hp),
                          finalHash=int(hash_state(gg, 0, [])),
                          minMargin=float(mm)))
    p3 = dict(
        note=("P3: free rollouts with the same random weight net. The browser "
              "runs its own policy and must produce the same action sequence. "
              "A divergence is tolerated only at a tick whose argmax margin is "
              "below 1e-5; three or more near ties across the set is a fail."),
        hidden=hidden, nIn=board.n_in, netSeed=seed,
        net=dict(theta=_f32b64(theta), shape=[board.n_in, hidden]),
        count=len(rolls), nearTies=near, worstMargin=float(worst),
        rollouts=rolls,
        arch=dict(map=map_name, tiles=int(board.n), nIn=int(board.n_in)),
    )
    path3 = os.path.join(outdir, "rollout-%d.json" % n_roll)
    with open(path3, "w", newline="\n") as fh:
        json.dump(p3, fh, separators=(",", ":"))
    log("P3 written: %s  rollouts %d  nearTies %d  worstMargin %.4g"
        % (path3, len(rolls), near, worst))
    return p2, p3


# ---------------------------------------------------------------- int8 export


def quantize(w):
    a = np.asarray(w, dtype=np.float64)
    m = float(np.max(np.abs(a))) if a.size else 0.0
    s = (m / 127.0) if m > 0 else 1.0
    q = np.clip(np.rint(a / s), -127, 127).astype(np.int8)
    return dict(s=s, shape=list(a.shape),
                b64=base64.b64encode(q.tobytes()).decode("ascii"))


def dequantize(t):
    q = np.frombuffer(base64.b64decode(t["b64"]), dtype=np.int8)
    return q.astype(np.float64).reshape(t["shape"]) * t["s"]


def export_net(theta, hidden, n_in):
    W1, b1, W2, b2 = unpack(theta, hidden, n_in)
    return dict(W1=quantize(W1), b1=[float(v) for v in b1],
                W2=quantize(W2), b2=[float(v) for v in b2])


# ---------------------------------------------------------------- placeholder model


SUMMARY_NAMES = [
    "p_walls", "p_guns", "p_wallshare",
    "row0", "row1", "row2", "row3", "row4",
    "row5", "row6", "row7", "row8", "row9",
    "band0", "band1", "band2", "band3", "band4", "band5", "band6",
    "p_walldist", "p_gundist", "p_contig", "p_runh",
    "p_west", "p_valleys", "p_frontage", "p_traffic", "p_guncover",
    "p_unspent", "s_wave0", "s_wave1", "s_wave2", "p_seat", "p_lost", "s_bias",
]


def _rand_flat(n, seed, scale=0.5):
    """The fixture generator, generalised to any length. Same draw, same
    float32 rounding, so nets.sp0 is bit for bit the net the P2 and P3
    fixtures were recorded with."""
    rng = np.random.default_rng(seed)
    a = (rng.standard_normal(n) * scale)
    return np.asarray(a, dtype=np.float32).astype(np.float64)


def _cfg_hash(cfg):
    items = []
    for k in sorted(cfg):
        v = cfg[k]
        if isinstance(v, tuple):
            v = list(v)
        items.append("%s=%s" % (k, v))
    h = 2166136261
    for ch in "|".join(items):
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return "%08x" % h


def _scorer(n_in, hidden, seed):
    theta = _rand_flat(n_params(hidden, n_in), seed)
    W1, b1, W2, b2 = unpack(theta, hidden, n_in)
    return dict(W1=quantize(W1), b1=[float(v) for v in b1],
                W2=quantize(W2), b2=[float(v) for v in b2])


def _accommodator(n_in, hidden, s_in, trunk, n_int, seed):
    """One flat draw split in this documented order: Ws, bs, Wd, bd, then the
    policy theta in the usual W1, b1, W2, b2 order."""
    pol = n_params(hidden, n_in + trunk)
    tot = s_in * trunk + trunk + trunk * n_int + n_int + pol
    flat = _rand_flat(tot, seed)
    i = 0
    Ws = flat[i:i + s_in * trunk].reshape(s_in, trunk)
    i += s_in * trunk
    bs = flat[i:i + trunk]
    i += trunk
    Wd = flat[i:i + trunk * n_int].reshape(trunk, n_int)
    i += trunk * n_int
    bd = flat[i:i + n_int]
    i += n_int
    W1, b1, W2, b2 = unpack(flat[i:i + pol], hidden, n_in + trunk)
    return dict(Ws=quantize(Ws), bs=[float(v) for v in bs],
                Wd=quantize(Wd), bd=[float(v) for v in bd],
                W1=quantize(W1), b1=[float(v) for v in b1],
                W2=quantize(W2), b2=[float(v) for v in b2])


def _net_from_export(d):
    """Read an exported net back the way the browser core does: dequantise the
    int8 tensors, so a probe is computed from the numbers that ship."""
    return (dequantize(d["W1"]), np.asarray(d["b1"], dtype=np.float64),
            dequantize(d["W2"]), np.asarray(d["b2"], dtype=np.float64))


def _probe_rows(board, cfg, rows, n_in, seed):
    """A probe feature matrix: the first `rows` tiles of a real build turn on a
    real episode, padded on the right with a deterministic suffix when the net
    takes more inputs than the board packs (the specializer intent one hot, the
    accommodator trunk vector)."""
    ep = Episode(seed, board.t, cfg)
    g = Game(ep, cfg)
    bld = Builder(board, ep, g)
    g.repair_all()
    g.wave_index = 0
    X = np.array(bld.features(0, ep.budgets[0][0], 0, 0)[:rows],
                 dtype=np.float64)
    if n_in == board.n_in:
        return X
    extra = _rand_flat(n_in - board.n_in, seed + 991, scale=0.25)
    out = np.zeros((rows, n_in))
    out[:, :board.n_in] = X
    out[:, board.n_in:] = extra
    return out


def placeholder_model(board, cfg, path, log, map_name="v4", base=20260906):
    """SEAM F-S1: write assets/js/keepittogether-model.js as the random weight
    placeholder in the pinned format of INTERFACES T1 pin 4, so the page loads,
    the parity plate reads honestly and the CI link checker is green. T2
    overwrites this file with the trained export.

    `map_name` is written into arch.map and `board` decides arch.tiles, so the
    file always names the world it was drawn on. `base` is the seed the fixture
    search settled on for that world, which is what keeps nets.sp0 bit for bit
    the net the P2 and P3 fixtures were recorded with."""
    n_in = board.n_in
    H1 = 48
    S = 36
    C = 32
    N = 6
    nets = {}
    for i in range(8):
        nets["sp%d" % i] = _scorer(n_in, H1, base + i)
    nets["spec"] = _scorer(n_in + N, H1, base + 100)
    nets["specDiv"] = _scorer(n_in + N, H1, base + 101)
    for i in range(8):
        nets["ac%d" % i] = _accommodator(n_in, H1, S, C, N, base + 200 + i)

    # ---- probes: recomputed in the browser by KeepCore.checkProbes
    probes = []
    for key, pin in (("sp0", n_in), ("sp3", n_in), ("spec", n_in + N),
                     ("ac0", n_in + C)):
        X = _probe_rows(board, cfg, 8, pin, 20260905)
        out = scores_ref(X, _net_from_export(nets[key]))
        probes.append(dict(net=key, nIn=pin, rows=8,
                           X=[float(v) for v in X.ravel()],
                           out=[float(v) for v in out.ravel()]))
    log("probes: %d, worst absolute score %.4g"
        % (len(probes), max(abs(v) for p in probes for v in p["out"])))

    # ---- the recorded episode: sp0 against itself, hashed every tick
    net = _net_from_export(nets["sp0"])
    ep = Episode(20260905, board.t, cfg)
    g = Game(ep, cfg)
    bld = Builder(board, ep, g)
    phases = []
    ticks = []
    margins = []
    for wi in range(3):
        ba, bb = ep.budgets[wi]
        g.repair_all()
        g.wave_index = wi
        acts = []

        def on_place(side, i, kind_i):
            acts.append([side, i, kind_i])
            ticks.append(dict(kind="b", wave=wi, h=hash_state(g, 0, [])))

        _, mm = net_build_phase(board, bld, (net, net),
                                [max(0, ba), max(0, bb)], wi, ref=True,
                                on_place=on_place)
        margins.extend(mm)
        phases.append(acts)

        def trace(kind, tick, walkers):
            ticks.append(dict(kind=kind, wave=wi, tick=tick,
                              h=hash_state(g, tick, walkers)))

        g.run_wave(wi, trace=trace)
        if g.keep_hp <= 0:
            break
    episode = dict(
        note=("One three wave episode played by nets.sp0 against itself and "
              "hashed after every placement and every tick. Replay it with "
              "the recorded actions, never with your own policy."),
        net="sp0", episode=ep.record(), phases=phases, ticks=ticks,
        keepHp=int(g.keep_hp), finalHash=int(hash_state(g, 0, [])),
    )
    margin = float(min(margins)) if margins else 0.0
    log("recorded episode: %d ticks, keep %d, smallest argmax margin %.4g"
        % (len(ticks), g.keep_hp, margin))

    loc, glo = board.feature_names()
    model = dict(
        version=1,
        arch=dict(map=map_name, W=board.t.w, H=board.t.h, tiles=board.n,
                  L=len(loc), G=len(glo), nIn=n_in, S=S, H1=H1, C=C, N=N,
                  cfgHash=_cfg_hash(cfg)),
        featureNames=dict(local=list(loc), summary=list(SUMMARY_NAMES)),
        meta=dict(
            trained="",
            placeholder=True,
            note=("UNTRAINED PLACEHOLDER. Every weight in this file is a "
                  "random draw, not a trained engineer, and nothing here has "
                  "played a game it learned from. It exists so the page loads "
                  "and reports its own state honestly while training runs. "
                  "The trained export replaces it and fills meta.trained."),
            generator=("numpy default_rng(seed).standard_normal times 0.5, "
                       "rounded through float32; the same generator and base "
                       "seed as fixtures/episode-random.json, so nets.sp0 is "
                       "bit for bit the net those fixtures were recorded "
                       "with"),
            seeds=dict(sp="%d + 0..7" % base,
                       spec="%d, %d" % (base + 100, base + 101),
                       ac="%d + 0..7" % (base + 200)),
            s0={}, s1={}, g0={}, g1={},
        ),
        nets=nets,
        probes=probes,
        testVector=dict(probes=probes, episode=episode, margin=margin),
    )
    model["featureNames"]["global"] = list(glo)

    body = json.dumps(model, separators=(",", ":"), sort_keys=False)
    header = (
        "/* keepittogether-model.js  GENERATED by "
        "make_keepittogether_model.py --placeholder-model.\n"
        " * Never hand edit this file.\n"
        " *\n"
        " * THIS IS AN UNTRAINED PLACEHOLDER. Every weight below is a random\n"
        " * draw. meta.trained is empty, which is how the page knows to say\n"
        " * so on the canvas and in the verify line. The trained export\n"
        " * replaces this whole file.\n"
        " */\n"
    )
    js = (header +
          "(typeof self !== 'undefined' ? self : globalThis).KIT_MODEL =\n" +
          body + ";\n")
    with open(path, "w", newline="\n") as fh:
        fh.write(js)
    log("placeholder model written: %s  %.1f KB  %d nets"
        % (path, len(js) / 1024.0, len(nets)))
    return model

# ---------------------------------------------------------------- trained export
#
# D2 section 10 and INTERFACES T1 pin 4. The trained file has the SAME shape as
# the placeholder above, so nothing downstream learns a second format; what
# changes is that every weight came out of a run and meta carries the gate
# numbers that were measured on it.
#
# The exporter never trains and never gates. It reads a PLAN written by the
# gates (`_tests/twoengineers/train/gates/export-plan.json`), which names the
# weights file for each of the eighteen nets and carries G0's and G1's numbers
# and the six plan names. Keeping the two apart means the file the browser
# loads cannot quietly disagree with the file the gate wrote its verdict from.


def quantize32(w):
    """Per tensor symmetric int8 with the scale rounded through float32, so the
    number the browser multiplies by is exactly the number this file wrote."""
    a = np.asarray(w, dtype=np.float64)
    m = float(np.max(np.abs(a))) if a.size else 0.0
    s = float(np.float32(m / 127.0)) if m > 0 else 1.0
    q = np.clip(np.rint(a / s), -127, 127).astype(np.int8)
    return dict(s=s, shape=list(a.shape),
                b64=base64.b64encode(q.tobytes()).decode("ascii"))


def _fl(v):
    return [float(x) for x in np.asarray(v).ravel()]


def export_scorer(theta, hidden, n_in):
    """sp0..sp7, spec, specDiv: W1 [n_in, hidden], b1, W2 [hidden, 2], b2."""
    W1, b1, W2, b2 = unpack(theta, hidden, n_in)
    return dict(W1=quantize32(W1), b1=_fl(b1),
                W2=quantize32(W2), b2=_fl(b2))


def split_disc(phi, s_in=36, c=32, nz=6):
    i = 0
    Ws = phi[i:i + s_in * c].reshape(s_in, c)
    i += s_in * c
    bs = phi[i:i + c]
    i += c
    Wd = phi[i:i + c * nz].reshape(c, nz)
    i += c * nz
    bd = phi[i:i + nz]
    i += nz
    assert i == phi.shape[0], "phi is %d long, the split wants %d" % (
        phi.shape[0], i)
    return Ws, bs, Wd, bd


def export_accommodator(theta_acc, phi, hidden, n_in, s_in=36, c=32, nz=6):
    """ac0..ac7: the shared trunk and the discriminator head out of phi, the
    policy out of theta. The policy reads [X | h] with h broadcast to every
    tile, so its W1 has n_in + c rows."""
    Ws, bs, Wd, bd = split_disc(phi, s_in, c, nz)
    W1, b1, W2, b2 = unpack(theta_acc, hidden, n_in + c)
    return dict(Ws=quantize32(Ws), bs=_fl(bs),
                Wd=quantize32(Wd), bd=_fl(bd),
                W1=quantize32(W1), b1=_fl(b1),
                W2=quantize32(W2), b2=_fl(b2))


def _acc_net_from_export(d):
    return (dequantize(d["W1"]), np.asarray(d["b1"], dtype=np.float64),
            dequantize(d["W2"]), np.asarray(d["b2"], dtype=np.float64))


def _stage_b_weights(path, which="best"):
    z = np.load(path)
    if which == "mean" and "mean" in z.files:
        return z["mean"], z["meanphi"], int(z["hidden"]), int(z["gen"])
    return z["theta"], z["phi"], int(z["hidden"]), int(z["gen"])


def _augment_rows(X, extra):
    out = np.empty((X.shape[0], X.shape[1] + len(extra)))
    out[:, :X.shape[1]] = X
    out[:, X.shape[1]:] = extra
    return out


def _fresh_state(board, cfg, seed, waves_done=0, net=None):
    """A real board to read features off. waves_done = 0 is the opening turn of
    wave 0; 1 means wave 0 was built and resolved, so the probe is taken on a
    board that has been through a wave, which is where the mid resolve probe
    comes from."""
    ep = Episode(seed, board.t, cfg)
    g = Game(ep, cfg)
    bld = Builder(board, ep, g)
    for wi in range(waves_done):
        ba, bb = ep.budgets[wi]
        g.repair_all()
        g.wave_index = wi
        net_build_phase(board, bld, (net, net), [max(0, ba), max(0, bb)], wi)
        g.run_wave(wi)
    g.repair_all()
    g.wave_index = waves_done
    return ep, g, bld


def trained_probes(board, cfg, nets, log, seed=800521):
    """The six P1 probes. Each is a feature matrix the browser is handed and the
    scores this file computed for it, so a dequantisation, stride or
    accumulation fault in the forward pass fails at load and names the head.

    Coverage, which is the point of choosing six: a self-play scorer on a fresh
    board; a second self-play scorer on a board that has already been through a
    wave (the mid resolve row); the specializer at two different intents, which
    is the only probe that can catch a transposed intent block; the diversity
    only control; and the accommodator, whose 32 extra columns are its own
    trunk over a real board summary, so a wrong Ws or bs moves the probe."""
    n_in = board.n_in
    C = len(nets["ac0"]["bs"])
    N = len(nets["ac0"]["bd"])
    sp0 = _net_from_export(nets["sp0"])
    probes = []

    def add(key, X):
        out = scores_ref(X, _net_from_export(nets[key]))
        probes.append(dict(net=key, nIn=int(X.shape[1]), rows=int(X.shape[0]),
                           X=_fl(X), out=_fl(out)))

    _, g0, b0 = _fresh_state(board, cfg, seed)
    X0 = np.array(b0.features(0, 24, 0, 0)[:8], dtype=np.float64)
    add("sp0", X0)

    _, g1, b1 = _fresh_state(board, cfg, seed + 1, waves_done=1, net=sp0)
    X1 = np.array(b1.features(1, 12, 1, 2)[:8], dtype=np.float64)
    add("sp3", X1)

    for z, key in ((0, "spec"), (3, "spec"), (2, "specDiv")):
        zv = np.zeros(N)
        zv[z] = 1.0
        _, gz, bz = _fresh_state(board, cfg, seed + 2 + z)
        Xz = np.array(bz.features(0, 20, 0, 1)[:8], dtype=np.float64)
        Xz = _augment_rows(Xz, zv)
        add(key, Xz)
        probes[-1]["z"] = int(z)

    Ws = dequantize(nets["ac0"]["Ws"])
    bs = np.asarray(nets["ac0"]["bs"], dtype=np.float64)
    _, ga, ba = _fresh_state(board, cfg, seed + 9, waves_done=1, net=sp0)
    S = board_summary(board, ga, 1, 1)
    h = np.tanh(S.dot(Ws) + bs)
    Xa = np.array(ba.features(0, 14, 1, 0)[:8], dtype=np.float64)
    Xa = _augment_rows(Xa, h)
    add("ac0", Xa)
    probes[-1]["trunkFrom"] = dict(seat=1, wave=1, seed=int(seed + 9),
                                   note=("the 32 extra columns are ac0's own "
                                         "trunk over a real board summary, so "
                                         "Ws and bs are inside this probe"))
    assert len(probes) == 6
    log("probes: %d, widths %s, worst absolute score %.4g"
        % (len(probes), ",".join(str(p["nIn"]) for p in probes),
           max(abs(v) for p in probes for v in p["out"])))
    return probes


def trained_episode(board, cfg, nets, log, key="sp0", seeds=(800600, 800900)):
    """The P2 recording: one three wave episode played by a cast engineer
    against itself, hashed after every placement, every tick and every wave.

    The seed is SEARCHED, on two conditions. The keep must survive all three
    waves, so the recording is a three wave record and the trail is as long as
    the world can make it; and the smallest argmax margin anywhere in the
    episode must clear 1e-3, so a legitimate float difference in the last bits
    cannot flip a placement and fail the parity test for no real reason
    (D2 section 10)."""
    net = _net_from_export(nets[key])
    best = None
    for seed in range(seeds[0], seeds[1]):
        ep = Episode(seed, board.t, cfg)
        g = Game(ep, cfg)
        bld = Builder(board, ep, g)
        phases = []
        ticks = []
        margins = []
        waves = 0
        for wi in range(3):
            ba, bb = ep.budgets[wi]
            g.repair_all()
            g.wave_index = wi
            acts = []

            def on_place(side, i, kind_i, wi=wi, acts=acts):
                acts.append([side, i, kind_i])
                ticks.append(dict(kind="b", wave=wi, h=hash_state(g, 0, [])))

            _, mm = net_build_phase(board, bld, (net, net),
                                    [max(0, ba), max(0, bb)], wi, ref=True,
                                    on_place=on_place)
            margins.extend(mm)
            phases.append(acts)

            def trace(kind, tick, walkers, wi=wi):
                ticks.append(dict(kind=kind, wave=wi, tick=tick,
                                  h=hash_state(g, tick, walkers)))

            g.run_wave(wi, trace=trace)
            waves = wi + 1
            if g.keep_hp <= 0:
                break
        margin = float(min(margins)) if margins else 0.0
        rec = (seed, waves, int(g.keep_hp), margin, phases, ticks,
               int(hash_state(g, 0, [])), ep)
        if waves == 3 and g.keep_hp > 0 and margin > 1e-3:
            best = rec
            break
        if best is None or (waves, margin) > (best[1], best[3]):
            best = rec
    seed, waves, keep, margin, phases, ticks, final, ep = best
    if not (waves == 3 and keep > 0 and margin > 1e-3):
        log("WARNING: no seed in %d..%d gave a surviving three wave episode "
            "with margin > 1e-3; the best found is seed %d, %d waves, keep %d, "
            "margin %.4g" % (seeds[0], seeds[1], seed, waves, keep, margin))
    episode = dict(
        note=("One three wave episode played by nets.%s against itself and "
              "hashed after every placement and every tick. Replay it with "
              "the recorded actions, never with your own policy." % key),
        net=key, episode=ep.record(), phases=phases, ticks=ticks,
        keepHp=int(keep), finalHash=int(final))
    log("recorded episode: seed %d, %d waves, %d ticks, keep %d, smallest "
        "argmax margin %.4g" % (seed, waves, len(ticks), keep, margin))
    return episode, margin


# ------------------------------------------ the accommodator recording (T2d)
#
# Build spec v3 section 7.12 ruling 1. The page plays an accommodator with its
# 32 trunk columns missing (SEAM C5-S1), and the fix needs a recording the page
# side helper can be tested against. This block writes one, and it reads the
# weights out of the SHIPPED export rather than out of a checkpoint, so what is
# recorded is what the browser multiplies by.


def load_export(path):
    """Read a generated keepittogether-model.js back into a dict. The file is a
    comment header, one assignment and a JSON object, so the JSON is everything
    from the first brace after the assignment to the final semicolon."""
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    key = "KIT_MODEL ="
    i = src.index(key) + len(key)
    j = src.rindex(";")
    return json.loads(src[i:j].strip())


def _acc_from_export(d):
    """One accommodator read the way the browser reads it: the policy AND the
    trunk both dequantised from the int8 tensors that ship, never from the
    float64 npz they were quantised from."""
    net = (dequantize(d["W1"]), np.asarray(d["b1"], dtype=np.float64),
           dequantize(d["W2"]), np.asarray(d["b2"], dtype=np.float64))
    return net, dequantize(d["Ws"]), np.asarray(d["bs"], dtype=np.float64)


def acc_trunk(board, g, partner_seat, wave, Ws, bs):
    """h, the accommodator's extra input columns, verbatim from stageb.py 136
    to 154: h = tanh(S . Ws + bs) over S = board_summary(board, g,
    partner_seat, wave), taken at the start of the accommodator's turn. S is
    the summary of the PARTNER's structures, so the seat argument is the seat
    the accommodator is reading, not its own."""
    S = board_summary(board, g, partner_seat, wave)
    return S, np.tanh(S.dot(Ws) + bs)


def acc_build_phase(board, bld, cfg, wave, budgets, acc_seat, acc_net, Ws, bs,
                    spec_net, zvec, on_place=None, on_turn=None):
    """stageb.build_phase_b's control flow with the REFERENCE accumulation
    order, so the browser reproduces it bit for bit. The accommodator's extra
    columns are recomputed on EVERY one of its turns; the specializer's intent
    one hot never moves."""
    g = bld.g
    spec_seat = 1 - acc_seat
    done = [False, False]
    side = 0
    turn = [0, 0]
    margins = []
    while not (done[0] and done[1]):
        if done[side]:
            side ^= 1
            continue
        bud = budgets[side]
        X = np.asarray(bld.features(side, bud, wave, turn[side]),
                       dtype=np.float64)
        if side == acc_seat:
            S, extra = acc_trunk(board, g, spec_seat, wave, Ws, bs)
            net = acc_net
        else:
            S, extra = None, zvec
            net = spec_net
        sc = scores_ref(_augment_rows(X, extra), net)
        pick = choose(sc, bld, bud, cfg, want_margin=True)
        if on_turn is not None:
            on_turn(side, wave, turn[side], extra, S, pick)
        if pick is None:
            done[side] = True
            side ^= 1
            continue
        i, kind_i, margin = pick
        margins.append(margin)
        kind = WALL if kind_i == 0 else TURRET
        tile = board.tiles[i]
        g.place(tile[0], tile[1], kind, side)
        cost = cfg[COST[kind]]
        budgets[side] -= cost
        g.spent[side] += cost
        bld.note_place(tile, kind, side)
        turn[side] += 1
        if on_place is not None:
            on_place(side, i, kind_i)
        side ^= 1
    return budgets, margins


def acc_episode(board, cfg, model, log, acc_key="ac0", spec_key="spec",
                intent=4, acc_seat=0, seeds=(800000, 800064), widen=400):
    """The accommodator recording of 7.12 ruling 1: one three wave episode with
    an accommodator seat against a specializer intent, hashed after every
    placement and every tick, carrying the per turn extra columns of BOTH
    seats.

    The seed is SEARCHED over the probe block on the P2 recording's own two
    conditions: the keep survives all three waves, so the trail is as long as
    the world allows, and the smallest argmax margin anywhere clears 1e-3, so a
    float difference in the last bits cannot flip a placement and fail parity
    for no real reason. Among the seeds that pass both, the one with the most
    ACCOMMODATOR TURNS is taken (ties by total placements, then by margin),
    because every accommodator turn is one more recomputed trunk vector for the
    page side helper to be tested against, and a recording is worth what it
    covers."""
    acc_net, Ws, bs = _acc_from_export(model["nets"][acc_key])
    spec_net = _net_from_export(model["nets"][spec_key])
    nz = int(model["arch"]["N"])
    zvec = np.zeros(nz)
    zvec[intent] = 1.0
    spec_seat = 1 - acc_seat

    def one(seed):
        ep = Episode(seed, board.t, cfg)
        g = Game(ep, cfg)
        bld = Builder(board, ep, g)
        phases = []
        ticks = []
        turns = []
        margins = []
        waves = 0
        for wi in range(3):
            ba, bb = ep.budgets[wi]
            g.repair_all()
            g.wave_index = wi
            acts = []
            base = sum(len(p) for p in phases)

            def on_place(side, i, kind_i, wi=wi, acts=acts, g=g, ticks=ticks):
                acts.append([side, i, kind_i])
                ticks.append(dict(kind="b", wave=wi, h=hash_state(g, 0, [])))

            def on_turn(side, wave, t, extra, S, pick, wi=wi, acts=acts,
                        base=base, turns=turns):
                turns.append(dict(
                    wave=wi, side=int(side), turn=int(t),
                    seat=("acc" if side == acc_seat else "spec"),
                    placed=bool(pick is not None),
                    place=((base + len(acts)) if pick is not None else None),
                    extra=[float(v) for v in extra],
                    summary=([float(v) for v in S] if S is not None else None)))

            _, mm = acc_build_phase(board, bld, cfg, wi,
                                    [max(0, ba), max(0, bb)], acc_seat,
                                    acc_net, Ws, bs, spec_net, zvec,
                                    on_place=on_place, on_turn=on_turn)
            margins.extend(mm)
            phases.append(acts)

            def trace(kind, tick, walkers, wi=wi, g=g, ticks=ticks):
                ticks.append(dict(kind=kind, wave=wi, tick=tick,
                                  h=hash_state(g, tick, walkers)))

            g.run_wave(wi, trace=trace)
            waves = wi + 1
            if g.keep_hp <= 0:
                break
        margin = float(min(margins)) if margins else 0.0
        placed = sum(len(p) for p in phases)
        nacc = sum(1 for t in turns if t["seat"] == "acc")
        rec = (seed, waves, int(g.keep_hp), margin, phases, ticks, turns,
               int(hash_state(g, 0, [])), ep)
        good = (waves == 3 and g.keep_hp > 0 and margin > 1e-3)
        rank = (1 if good else 0, nacc if good else 0, placed if good else 0,
                waves, margin)
        return rank, rec

    best = None
    lo, hi = seeds
    for seed in range(lo, hi):
        cand = one(seed)
        if best is None or cand[0] > best[0]:
            best = cand
    if best[0][0] == 0 and widen > 0:
        # The 64 seed probe block is where this recording belongs, because no
        # trainer ever fit on it. If no seed in it gives a surviving three wave
        # game with a safe margin, the search widens rather than shipping a
        # recording that dies in wave 1, and it says so here and in the file's
        # own `probeBlock` field, so a reader can tell which block the seed
        # came from.
        log("no seed in the %d..%d probe block gave a surviving three wave "
            "episode with margin > 1e-3; widening the search by %d seeds"
            % (lo, hi - 1, widen))
        for seed in range(hi, hi + widen):
            cand = one(seed)
            if cand[0] > best[0]:
                best = cand
            if cand[0][0] == 1:
                break
    seed, waves, keep, margin, phases, ticks, turns, final, ep = best[1]
    if not (waves == 3 and keep > 0 and margin > 1e-3):
        log("WARNING: no seed in %d..%d gave a surviving three wave "
            "accommodator episode with margin > 1e-3; the best found is seed "
            "%d, %d waves, keep %d, margin %.4g"
            % (lo, hi - 1, seed, waves, keep, margin))
    nacc = sum(1 for t in turns if t["seat"] == "acc")
    out = dict(
        note=("One three wave episode with an accommodator seat against a "
              "specializer intent, hashed after every placement and every "
              "tick. Replay it with the recorded actions, never with your own "
              "policy. Seat %d is nets.%s, whose extra input columns are "
              "h = tanh(S . Ws + bs) over board_summary(board, game, seat %d, "
              "wave), recomputed at the start of each of its turns; seat %d is "
              "nets.%s at intent %d, whose extra columns are that intent's one "
              "hot and never move."
              % (acc_seat, acc_key, spec_seat, spec_seat, spec_key, intent)),
        law=("acc extra = tanh(board_summary(board, game, partnerSeat, wave) "
             "dot Ws + bs), recomputed at the start of every accommodator "
             "turn; spec extra = the one hot of the intent, constant"),
        net=(spec_key if acc_seat == 1 else acc_key),
        netB=(acc_key if acc_seat == 1 else spec_key),
        accSeat=int(acc_seat), specSeat=int(spec_seat),
        accNet=acc_key, specNet=spec_key, intent=int(intent),
        extraSeatA=("trunk" if acc_seat == 0 else int(intent)),
        extraSeatB=("trunk" if acc_seat == 1 else int(intent)),
        S=int(model["arch"]["S"]), C=int(model["arch"]["C"]),
        N=nz, nIn=int(model["arch"]["nIn"]),
        hidden=int(model["meta"]["hidden"][acc_key]),
        hiddenSpec=int(model["meta"]["hidden"][spec_key]),
        episode=ep.record(), phases=phases, ticks=ticks, turns=turns,
        keepHp=int(keep), finalHash=int(final), margin=float(margin),
        waves=int(waves), seed=int(seed),
        probeBlock=((lo, hi - 1) if lo <= seed < hi else (hi, seed)),
        fromProbeBlock=bool(lo <= seed < hi),
        nets=dict(acc=json.loads(json.dumps(model["nets"][acc_key])),
                  spec=json.loads(json.dumps(model["nets"][spec_key]))))
    log("accommodator recording: seed %d, %d waves, %d ticks, %d placements, "
        "%d accommodator turns, keep %d, smallest argmax margin %.4g"
        % (seed, waves, len(ticks), sum(len(p) for p in phases), nacc, keep,
           margin))
    return out, margin


def acc_episode_replay(board, cfg, model, rec, log):
    """The proof of 7.12 ruling 1: replay the recording FROM THE BOARD ALONE.

    The placements are teacher forced from `phases`; every accommodator turn's
    S and h are recomputed from the live game and compared with the recorded
    ones, every hash entry is recompared, and the keep and the final hash have
    to land where the recording says. The free policy is also asked for its own
    pick at every turn and has to agree with the recording, so the file is not
    merely self consistent."""
    fails = []
    n = [0]

    def ck(cond, msg):
        n[0] += 1
        if not cond:
            fails.append(msg)
        return bool(cond)

    acc_key, spec_key = rec["accNet"], rec["specNet"]
    acc_seat, spec_seat = rec["accSeat"], rec["specSeat"]
    # The fixture carries its own copy of the two nets, verbatim int8 tensors
    # from the export it was recorded off. Replaying from THOSE is what makes
    # the file self contained: it goes on replaying after a later export
    # changes ac0, and a reader can still say which weights it describes. The
    # model's own copy is compared against it first, so a fixture that has
    # gone stale says so here rather than as a numeric mystery downstream.
    inl = rec.get("nets")
    if inl:
        for key, d in (("acc", model["nets"][acc_key]),
                       ("spec", model["nets"][spec_key])):
            for t in ("W1", "W2"):
                ck(inl[key][t]["b64"] == d[t]["b64"]
                   and inl[key][t]["s"] == d[t]["s"],
                   "the fixture's inline %s.%s is not the one this model "
                   "carries; the recording is stale for this export"
                   % (key, t))
        acc_net, Ws, bs = _acc_from_export(inl["acc"])
        spec_net = _net_from_export(inl["spec"])
    else:
        acc_net, Ws, bs = _acc_from_export(model["nets"][acc_key])
        spec_net = _net_from_export(model["nets"][spec_key])
    zvec = np.zeros(rec["N"])
    zvec[rec["intent"]] = 1.0
    ep = Episode(rec["episode"]["seed"], board.t, cfg)
    ck(json.loads(json.dumps(ep.record())) == rec["episode"],
       "the episode record does not rebuild from its own seed")
    g = Game(ep, cfg)
    bld = Builder(board, ep, g)
    worstS = 0.0
    worstH = 0.0
    ti = [0]
    tidx = [0]
    placed_n = [0]
    turns = list(rec["turns"])

    def check_tick(kind, wave, tick, walkers):
        want = rec["ticks"][ti[0]] if ti[0] < len(rec["ticks"]) else None
        got = int(hash_state(g, tick, walkers))
        ck(want is not None and want["kind"] == kind and want["wave"] == wave
           and int(want["h"]) == got,
           "tick %d: %s wave %d hash %d, the recording has %s"
           % (ti[0], kind, wave, got, want))
        ti[0] += 1

    for wi in range(3):
        ba, bb = ep.budgets[wi]
        g.repair_all()
        g.wave_index = wi
        acts = list(rec["phases"][wi]) if wi < len(rec["phases"]) else []
        ai = 0
        budgets = [max(0, ba), max(0, bb)]
        done = [False, False]
        side = 0
        turn = [0, 0]
        while not (done[0] and done[1]):
            if done[side]:
                side ^= 1
                continue
            X = np.asarray(bld.features(side, budgets[side], wi, turn[side]),
                           dtype=np.float64)
            if side == acc_seat:
                S, extra = acc_trunk(board, g, spec_seat, wi, Ws, bs)
                net = acc_net
            else:
                S, extra, net = None, zvec, spec_net
            t = turns[tidx[0]] if tidx[0] < len(turns) else None
            ck(t is not None and t["wave"] == wi and t["side"] == side
               and t["turn"] == turn[side],
               "turn %d: this replay is at wave %d seat %d turn %d, the "
               "recording has %s" % (tidx[0], wi, side, turn[side], t))
            if t is not None:
                d = max(abs(float(a) - float(b))
                        for a, b in zip(extra, t["extra"]))
                worstH = max(worstH, d)
                ck(d <= 1e-9, "turn %d: the extra columns differ by %.3g"
                   % (tidx[0], d))
                ck(len(t["extra"]) == (rec["C"] if side == acc_seat
                                       else rec["N"]),
                   "turn %d: the recorded extra is %d wide"
                   % (tidx[0], len(t["extra"])))
                if S is not None and t.get("summary") is not None:
                    ds = max(abs(float(a) - float(b))
                             for a, b in zip(S, t["summary"]))
                    worstS = max(worstS, ds)
                    ck(ds <= 1e-9, "turn %d: the board summary differs by %.3g"
                       % (tidx[0], ds))
            tidx[0] += 1
            sc = scores_ref(_augment_rows(X, extra), net)
            pick = choose(sc, bld, budgets[side], cfg, want_margin=True)
            want = acts[ai] if ai < len(acts) else None
            if want is not None and want[0] == side:
                if not ck(pick is not None,
                          "wave %d seat %d turn %d: the recording places and "
                          "this replay cannot"
                          % (wi, side, turn[side])):
                    return False, n[0], fails, worstS, worstH
                ck(pick[0] == want[1] and pick[1] == want[2],
                   "wave %d seat %d turn %d: the free policy picks tile %d "
                   "kind %d, the recording has tile %d kind %d"
                   % (wi, side, turn[side], pick[0], pick[1], want[1],
                      want[2]))
                ai += 1
                i, kind_i = want[1], want[2]
                kind = WALL if kind_i == 0 else TURRET
                tile = board.tiles[i]
                g.place(tile[0], tile[1], kind, side)
                cost = cfg[COST[kind]]
                budgets[side] -= cost
                g.spent[side] += cost
                bld.note_place(tile, kind, side)
                turn[side] += 1
                placed_n[0] += 1
                check_tick("b", wi, 0, [])
                side ^= 1
            else:
                ck(pick is None,
                   "wave %d seat %d turn %d: the recording stops this seat and "
                   "the free policy would place tile %s"
                   % (wi, side, turn[side],
                      (pick[0] if pick is not None else None)))
                done[side] = True
                side ^= 1

        def trace(kind, tick, walkers, wi=wi):
            check_tick(kind, wi, tick, walkers)

        g.run_wave(wi, trace=trace)
        if g.keep_hp <= 0:
            break
    ck(ti[0] == len(rec["ticks"]),
       "the replay produced %d hash entries, the recording holds %d"
       % (ti[0], len(rec["ticks"])))
    ck(tidx[0] == len(turns),
       "the replay took %d turns, the recording holds %d"
       % (tidx[0], len(turns)))
    ck(placed_n[0] == sum(len(p) for p in rec["phases"]),
       "the replay placed %d pieces, the recording holds %d"
       % (placed_n[0], sum(len(p) for p in rec["phases"])))
    ck(int(g.keep_hp) == rec["keepHp"],
       "the keep ends at %d, the recording has %d" % (g.keep_hp, rec["keepHp"]))
    ck(int(hash_state(g, 0, [])) == rec["finalHash"],
       "the final hash is %d, the recording has %d"
       % (hash_state(g, 0, []), rec["finalHash"]))
    log("replay from the board alone: %d checks, %d failures, %d placements, "
        "worst summary difference %.3g, worst trunk difference %.3g"
        % (n[0], len(fails), placed_n[0], worstS, worstH))
    for f in fails[:8]:
        log("  FAIL  %s" % f)
    return (not fails), n[0], fails, worstS, worstH


def acc_free_play(board, cfg, model, rec, trunk="law"):
    """Play the recording's own episode FREELY, with the accommodator's extra
    columns produced three ways, and report what each one places.

    `law` is 7.12 ruling 1's law. `zero` is what the page does today (SEAM
    C5-S1: no extra is handed in, so the policy's last 32 rows never multiply
    anything, which is arithmetically the zero vector). `bias` is tanh(bs),
    which is what a summary of all zeros would give, and is named here only
    because it is the value a reader might assume `zero` means and it is not.
    """
    inl = rec.get("nets")
    acc_net, Ws, bs = _acc_from_export(inl["acc"] if inl
                                       else model["nets"][rec["accNet"]])
    spec_net = _net_from_export(inl["spec"] if inl
                                else model["nets"][rec["specNet"]])
    acc_seat, spec_seat = rec["accSeat"], rec["specSeat"]
    zvec = np.zeros(rec["N"])
    zvec[rec["intent"]] = 1.0
    fixed = None
    if trunk == "zero":
        fixed = np.zeros(rec["C"])
    elif trunk == "bias":
        fixed = np.tanh(bs)
    ep = Episode(rec["episode"]["seed"], board.t, cfg)
    g = Game(ep, cfg)
    bld = Builder(board, ep, g)
    acts = []
    for wi in range(3):
        ba, bb = ep.budgets[wi]
        g.repair_all()
        g.wave_index = wi
        budgets = [max(0, ba), max(0, bb)]
        done = [False, False]
        side = 0
        turn = [0, 0]
        while not (done[0] and done[1]):
            if done[side]:
                side ^= 1
                continue
            X = np.asarray(bld.features(side, budgets[side], wi, turn[side]),
                           dtype=np.float64)
            if side == acc_seat:
                if fixed is None:
                    _, extra = acc_trunk(board, g, spec_seat, wi, Ws, bs)
                else:
                    extra = fixed
                net = acc_net
            else:
                extra, net = zvec, spec_net
            sc = scores_ref(_augment_rows(X, extra), net)
            pick = choose(sc, bld, budgets[side], cfg)
            if pick is None:
                done[side] = True
                side ^= 1
                continue
            i, kind_i, _ = pick
            kind = WALL if kind_i == 0 else TURRET
            tile = board.tiles[i]
            g.place(tile[0], tile[1], kind, side)
            cost = cfg[COST[kind]]
            budgets[side] -= cost
            g.spent[side] += cost
            bld.note_place(tile, kind, side)
            turn[side] += 1
            acts.append([wi, side, i, kind_i])
            side ^= 1
        g.run_wave(wi)
        if g.keep_hp <= 0:
            break
    return acts, int(g.keep_hp)


def acc_episode_proofs(board, cfg, model, rec, log):
    """Two things a recording has to survive to be worth pinning.

    ONE, non vacuity. A replay that cannot fail proves nothing, so one recorded
    trunk number is moved by 1e-6 and the replay has to go red on it, and one
    weight of the accommodator's own trunk matrix is moved and the replay has
    to go red too, because a page side helper that ignored `Ws` would otherwise
    pass this fixture.

    TWO, the size of the defect the recording exists to close. The same episode
    is played with the extra columns pinned to the zero vector, which is
    arithmetically what the page does today (SEAM C5-S1), and the placements
    are compared with the law's."""
    fails = []
    n = [0]

    def ck(cond, msg):
        n[0] += 1
        if not cond:
            fails.append(msg)
            log("  FAIL  %s" % msg)

    hit = None
    for i, t in enumerate(rec["turns"]):
        if t["seat"] == "acc":
            hit = i
            break
    ck(hit is not None, "the recording holds no accommodator turn")
    if hit is not None:
        bent = json.loads(json.dumps(rec))
        bent["turns"][hit]["extra"][0] += 1e-6
        good, _, f, _, _ = acc_episode_replay(board, cfg, model, bent,
                                              lambda m: None)
        ck((not good) and any("extra columns differ" in x for x in f),
            "moving one recorded trunk number by 1e-6 is not caught")
    bentm = json.loads(json.dumps(model))
    bentr = json.loads(json.dumps(rec))
    targets = [bentm["nets"][rec["accNet"]]["Ws"]]
    if bentr.get("nets"):
        targets.append(bentr["nets"]["acc"]["Ws"])
    for d in targets:
        raw = bytearray(base64.b64decode(d["b64"]))
        raw[0] = (raw[0] + 40) % 256
        d["b64"] = base64.b64encode(bytes(raw)).decode("ascii")
    good, _, f, _, _ = acc_episode_replay(board, cfg, bentm, bentr,
                                          lambda m: None)
    ck(not good, "moving one int8 of the trunk matrix Ws is not caught, so "
                 "this fixture would pass for a helper that never read Ws")

    law, keep_law = acc_free_play(board, cfg, model, rec, "law")
    want = []
    for wi, ph in enumerate(rec["phases"]):
        for a in ph:
            want.append([wi, a[0], a[1], a[2]])
    ck(law == want, "the free replay under the law does not reproduce the "
                    "recorded placements")
    ck(keep_law == rec["keepHp"], "the free replay under the law ends at keep "
                                  "%d, the recording has %d"
                                  % (keep_law, rec["keepHp"]))
    zero, keep_zero = acc_free_play(board, cfg, model, rec, "zero")
    first = None
    for i in range(max(len(law), len(zero))):
        a = law[i] if i < len(law) else None
        b = zero[i] if i < len(zero) else None
        if a != b:
            first = i
            break
    diff = sum(1 for i in range(min(len(law), len(zero)))
               if law[i] != zero[i]) + abs(len(law) - len(zero))
    log("the defect this recording closes, on this episode: playing the "
        "accommodator the way the page does today (no extra columns, so the "
        "last %d rows of W1 multiply nothing) places %d pieces to the law's "
        "%d, first difference at placement %s, %d placements differ, keep %d "
        "against %d" % (rec["C"], len(zero), len(law), first, diff, keep_zero,
                        keep_law))
    return (not fails), n[0], fails, dict(
        lawPlacements=len(law), zeroPlacements=len(zero),
        firstDiverge=first, placementsDiffer=diff,
        keepLaw=keep_law, keepZero=keep_zero)


def trained_model(board, cfg, plan, path, log, map_name="v5",
                  acc_record=True, acc_in_episodes=False, acc_key="ac0",
                  acc_spec="spec", acc_intent=4, acc_seat=0, acc_out=None):
    """Write the trained assets/js/keepittogether-model.js from a gate plan.

    `acc_record` adds spec v3 7.12 ruling 1's ACCOMMODATOR recording, made
    against the nets this very file is about to write, so the verify plate
    covers the trunk law on the shipped weights. Where it goes is a decision
    about the SHIPPED CORE and not about the recording: `testVector.episodes`
    is the field `checkTestVector` runs, and its moves half cannot yet replay
    a per turn trunk (SEAM T2b-S3 reads three STATIC forms and says so), so a
    recording put there before the core has that hook would fail the plate
    rather than prove anything. Until then it ships under `testVector`'s own
    `accEpisode`, which the core ignores, and `--acc-in-episodes` promotes it
    the day the hook lands."""
    n_in = board.n_in
    S, C, N = 36, 32, 6
    root = os.path.dirname(os.path.abspath(__file__))

    def full(p):
        return p if os.path.isabs(p) else os.path.join(root, p)

    nets = {}
    hidden_of = {}
    src = {}
    for i, c in enumerate(plan["cast"]):
        theta = np.load(full(c["theta"]))
        h = int(c["hidden"])
        assert theta.shape == (n_params(h, n_in),), (
            "%s is not a hidden %d engineer for this board" % (c["theta"], h))
        nets["sp%d" % i] = export_scorer(theta, h, n_in)
        hidden_of["sp%d" % i] = h
        src["sp%d" % i] = c["tag"]
    for i, a in enumerate(plan["acc"]):
        theta, phi, h, gen = _stage_b_weights(full(a["npz"]),
                                              a.get("which", "best"))
        # Since spec v3 7.12 ruling 3 the two halves of a Stage B theta may
        # have their own widths, so where they split is READ from the plan
        # rather than recomputed from one number. A plan entry written before
        # the ruling carries neither key and the old arithmetic is exactly
        # right for it, because both halves were the same width by
        # construction.
        ah = int(a.get("accHidden", h))
        ns = int(a.get("specN", n_params(h, n_in + N)))
        assert theta.shape[0] - ns == n_params(ah, n_in + C), (
            "%s: %d parameters after the split is not a hidden %d "
            "accommodator" % (a["npz"], theta.shape[0] - ns, ah))
        nets["ac%d" % i] = export_accommodator(theta[ns:], phi, ah, n_in,
                                               S, C, N)
        hidden_of["ac%d" % i] = ah
        src["ac%d" % i] = "%s gen %d" % (a["run"], gen)
    for key in ("spec", "specDiv"):
        p = plan[key]
        theta, phi, h, gen = _stage_b_weights(full(p["npz"]),
                                              p.get("which", "best"))
        ns = n_params(h, n_in + N)
        nets[key] = export_scorer(theta[:ns], h, n_in + N)
        hidden_of[key] = h
        src[key] = "%s gen %d" % (p["run"], gen)
    assert len(nets) == 18, "the export is eighteen nets, not %d" % len(nets)

    probes = trained_probes(board, cfg, nets, log)
    episode, margin = trained_episode(board, cfg, nets, log)

    acc_rec = None
    if acc_record and acc_key in nets and acc_spec in nets:
        mdl = dict(arch=dict(N=N, S=S, C=C, nIn=n_in, map=map_name),
                   nets=nets, meta=dict(hidden=hidden_of, source=src))
        acc_rec, _am = acc_episode(board, cfg, mdl, log, acc_key=acc_key,
                                   spec_key=acc_spec, intent=acc_intent,
                                   acc_seat=acc_seat)
        acc_rec["source"] = dict(model=os.path.basename(path), map=map_name,
                                 cfgHash=_cfg_hash(cfg),
                                 accSource=src[acc_key],
                                 specSource=src[acc_spec])
        good, nck, fails, wS, wH = acc_episode_replay(board, cfg, mdl,
                                                      acc_rec, log)
        assert good, ("the accommodator recording does not replay: %s"
                      % (fails[:3],))
        if acc_out:
            d = os.path.dirname(os.path.abspath(acc_out))
            if d and not os.path.isdir(d):
                os.makedirs(d)
            with open(acc_out, "w", newline="\n") as fh:
                json.dump(acc_rec, fh, separators=(",", ":"),
                          sort_keys=False)
                fh.write("\n")
            log("accommodator fixture written: %s  %.1f KB"
                % (acc_out, os.path.getsize(acc_out) / 1024.0))

    loc, glo = board.feature_names()
    meta = dict(plan["meta"])
    meta["hidden"] = hidden_of
    meta["source"] = src
    meta["placeholder"] = False
    model = dict(
        version=1,
        arch=dict(map=map_name, W=board.t.w, H=board.t.h, tiles=board.n,
                  L=len(loc), G=len(glo), nIn=n_in, S=S, H1=48, C=C, N=N,
                  cfgHash=_cfg_hash(cfg)),
        featureNames=dict(local=list(loc), global_=None,
                          summary=list(SUMMARY_NAMES)),
        meta=meta,
        nets=nets,
        probes=probes,
        testVector=dict(probes=probes, episode=episode, margin=margin),
    )
    if acc_rec is not None:
        # the export's copy drops the fixture's inline weight tensors: the
        # nets are in this very file, under the keys the recording names, so
        # carrying them twice would be 9 KB of the same numbers.
        # `extraSeatA` / `extraSeatB` are the names SEAM T2d-S1 pinned and the
        # shipped core reads them (it reads `extra` / `extraB` first, then
        # these), so the fixture and the export carry ONE shape rather than
        # two spellings of it.
        emb = {k: v for k, v in acc_rec.items() if k != "nets"}
        if acc_in_episodes:
            model["testVector"]["episodes"] = [episode, emb]
        else:
            model["testVector"]["accEpisode"] = emb
            model["testVector"]["accEpisodeNote"] = (
                "spec v3 7.12 ruling 1's accommodator recording. It is NOT in "
                "testVector.episodes because the shipped core's replay reads "
                "only STATIC extra columns and an accommodator's are a trunk "
                "over its partner's board summary recomputed every turn; a "
                "static value there would replay a different game and pass. "
                "Move it into episodes the day the core recomputes the extra "
                "per turn.")
    del model["featureNames"]["global_"]
    model["featureNames"]["global"] = list(glo)

    body = json.dumps(model, separators=(",", ":"), sort_keys=False)
    header = (
        "/* keepittogether-model.js  GENERATED by "
        "make_keepittogether_model.py --export.\n"
        " * Never hand edit this file.\n"
        " *\n"
        " * Eighteen trained nets: eight self-play engineers, eight\n"
        " * accommodators, the specializer and the diversity only control.\n"
        " * meta carries the gate numbers they were measured against and the\n"
        " * plan names read off the specializer's own geometry.\n"
        " */\n"
    )
    js = (header +
          "(typeof self !== 'undefined' ? self : globalThis).KIT_MODEL =\n" +
          body + ";\n")
    with open(path, "w", newline="\n") as fh:
        fh.write(js)
    log("trained model written: %s  %.1f KB  %d nets  %d probes"
        % (path, len(js) / 1024.0, len(nets), len(probes)))
    return model


# ---------------------------------------------------------------- selftest


def _assert(cond, msg, state):
    state[0] += 1
    if not cond:
        state[1].append(msg)
        print("  FAIL  %s" % msg)
    return bool(cond)


def selftest(board, cfg, log):
    state = [0, []]
    t = board.t

    _assert(board.n == 243, "v4 has 243 buildable tiles, got %d" % board.n, state)
    _assert((board.w, board.h) == (28, 19), "v4 is 28 by 19", state)
    _assert(len(t.gate_w) == 3 and len(t.gate_c) == 4 and len(t.gate_e) == 3,
            "gate groups are 3 / 4 / 3", state)
    _assert(board.n_in == 35, "n_in is 35 on v4, got %d" % board.n_in, state)
    _assert(abs(board.dnorm - 47.0) < 1e-12, "DNORM is 47", state)
    _assert(abs(board.rowmax - 24.0) < 1e-12, "ROWMAX is 24", state)
    _assert(abs(board.bnorm - 24.0) < 1e-12, "BNORM is 24", state)
    _assert(abs(board.cnorm - 12.0) < 1e-12, "CNORM is 12", state)

    # the hash: order sensitive, value sensitive, and stable
    ep = Episode(3, t, cfg)
    g1 = Game(ep, cfg)
    g2 = Game(ep, cfg)
    _assert(hash_state(g1, 0, []) == hash_state(g2, 0, []),
            "the hash is stable for two identical fresh games", state)
    h0 = hash_state(g1, 0, [])
    g1.place(9, 12, WALL, 0)
    h1 = hash_state(g1, 0, [])
    _assert(h0 != h1, "placing a wall changes the hash", state)
    g2.place(9, 12, TURRET, 0)
    _assert(hash_state(g2, 0, []) != h1,
            "a gun and a wall on the same tile hash differently", state)
    g3 = Game(ep, cfg)
    g3.place(9, 12, WALL, 1)
    _assert(hash_state(g3, 0, []) != h1, "the owner is in the hash", state)
    _assert(hash_state(g1, 1, []) != h1, "the tick is in the hash", state)
    wk = Walker(0, 3, 1, 30, 0)
    _assert(hash_state(g1, 0, [wk]) != h1, "a live walker is in the hash", state)
    wk.hp = 0
    _assert(hash_state(g1, 0, [wk]) == h1, "a dead walker is not hashed", state)

    # the feature encoder
    ep2 = Episode(11, t, cfg)
    g = Game(ep2, cfg)
    bld = Builder(board, ep2, g)
    X = bld.features(0, 24, 0, 0)
    _assert(X.shape == (board.n, 35), "features are n by 35, got %s"
            % (X.shape,), state)
    _assert(np.all(np.isfinite(X)), "no feature is NaN or infinite", state)
    _assert(abs(X[0, 0] - 1.0) < 1e-12, "feature 0 is the bias", state)
    _assert(abs(X[0, 31] - 0.0) < 1e-12 and
            abs(bld.features(1, 24, 0, 0)[0, 31] - 1.0) < 1e-12,
            "feature 31 is the seat bit", state)
    _assert(abs(X[0, 28] - 1.0) < 1e-12 and abs(X[0, 29]) < 1e-12,
            "features 28 to 30 are the wave one hot", state)
    _assert(float(np.max(X[:, 18])) <= 1.0 + 1e-12,
            "feature 18 clips at 1.0", state)
    loc, glo = board.feature_names()
    _assert(len(loc) == 27 and len(glo) == 8,
            "27 local names and 8 global names", state)

    # the two accumulation orders agree behaviourally
    theta = random_net(20, board.n_in, 1234)
    net = unpack(theta, 20, board.n_in)
    Xs = bld.features(0, 24, 0, 0)
    a = scores_blas(Xs, net)
    b = scores_ref(Xs, net)
    _assert(float(np.max(np.abs(a - b))) < 1e-9,
            "the BLAS and reference accumulation orders agree to 1e-9", state)
    _assert(int(np.argmax(a.ravel())) == int(np.argmax(b.ravel())),
            "the two orders pick the same tile", state)
    sm = scores_ref_scalar(Xs[:24], net)
    dsm = float(np.max(np.abs(sm - b[:24])))
    # The accumulation order is identical; the only residual is one ULP of tanh
    # (numpy's tanh against the C library's), which is what the fixtures'
    # margin field exists to absorb.
    _assert(dsm < 1e-14,
            "the vectorised reference order matches the scalar one to 1e-14, "
            "got %.3e" % dsm, state)

    # int8 round trip
    q = quantize(net[0])
    back = dequantize(q)
    err = float(np.max(np.abs(back - net[0])))
    _assert(err <= q["s"] / 2.0 + 1e-12,
            "int8 round trip is within half a step, got %.4g" % err, state)
    exp = export_net(theta, 20, board.n_in)
    _assert(exp["W1"]["shape"] == [board.n_in, 20], "W1 ships as [n_in, H]", state)
    _assert(exp["W2"]["shape"] == [20, 2], "W2 ships as [H, 2]", state)
    _assert(len(exp["b1"]) == 20 and len(exp["b2"]) == 2,
            "the biases ship as float arrays", state)
    rt = unpack(np.concatenate([dequantize(exp["W1"]).ravel(),
                                np.array(exp["b1"]),
                                dequantize(exp["W2"]).ravel(),
                                np.array(exp["b2"])]), 20, board.n_in)
    Xq = bld.features(0, 24, 0, 0)
    d = float(np.max(np.abs(scores_blas(Xq, rt) - scores_blas(Xq, net))))
    _assert(d < 0.05, "the quantized net scores within 0.05 of the float net, "
            "got %.4g" % d, state)

    # the env: a game runs, and building nothing loses ground
    g4, _ = play_net(board, Episode(5, t, cfg), net, net, cfg)
    _assert(0 <= g4.keep_hp <= 100, "keep HP stays in range", state)
    gn = Game(Episode(5, t, cfg), cfg)
    for wi in range(3):
        gn.repair_all()
        gn.run_wave(wi)
        if gn.keep_hp <= 0:
            break
    _assert(gn.keep_hp == 0, "building nothing is a floor of 0", state)

    # focus fire is off by default and changes nothing when it is
    cfg_focus = dict(cfg)
    cfg_focus["focus_fire"] = 1
    cfg_focus["focus_seats"] = (0, 0)
    ga, _ = play_net(board, Episode(7, t, cfg), net, net, cfg)
    gb, _ = play_net(board, Episode(7, t, cfg_focus), net, net, cfg_focus)
    _assert(hash_state(ga, 0, []) == hash_state(gb, 0, []),
            "focus with no seat on is byte identical", state)

    log("selftest: %d checks, %d failures" % (state[0], len(state[1])))
    for m in state[1]:
        log("  FAILED: %s" % m)
    return len(state[1]) == 0


# ---------------------------------------------------------------- verify


def verify_proto(board, cfg, n, log):
    """Replay this port against _tests/twoengineers/proto/env.py and assert
    identical episodes, scores, wave logs and final state hashes."""
    proto = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "_tests", "twoengineers", "proto")
    sys.path.insert(0, proto)
    cwd = os.getcwd()
    os.chdir(proto)
    try:
        import env as PENV
        import train_smoke as PTS
    finally:
        os.chdir(cwd)

    pt = PENV.Terrain(PENV.MAPS["v4"])
    pboard = PTS.Board(pt, cfg)
    if list(pt.buildable) != list(board.t.buildable):
        log("FAIL: the buildable tile lists differ")
        return False
    hidden = 20
    theta = random_net(hidden, board.n_in, 424242)
    net = unpack(theta, hidden, board.n_in)

    bad = 0
    for s in range(n):
        e1 = Episode(s, board.t, cfg)
        e2 = PENV.Episode(s, pt, cfg)
        if (e1.rubble != e2.rubble or e1.ruins != e2.ruins
                or e1.budgets != e2.budgets):
            log("FAIL: episode %d differs in rubble, ruins or budgets" % s)
            bad += 1
            continue
        for a, b in zip(e1.waves, e2.waves):
            if a != b:
                log("FAIL: episode %d differs in a wave record" % s)
                bad += 1
                break

        g1, _ = play_net(board, e1, net, net, cfg)
        g2 = PTS.play_net(pboard, e2, net, net, cfg)
        if g1.keep_hp != g2.keep_hp:
            log("FAIL: episode %d keep HP %d vs proto %d"
                % (s, g1.keep_hp, g2.keep_hp))
            bad += 1
            continue
        if [dict(r) for r in g1.log] != [dict(r) for r in g2.log]:
            log("FAIL: episode %d wave log differs" % s)
            bad += 1
            continue
        # the same hash function read over the proto game object
        g2.wave_index = g1.wave_index
        if not hasattr(g2, "focus"):
            g2.focus = None
        if hash_state(g1, 0, []) != hash_state(g2, 0, []):
            log("FAIL: episode %d final hash differs" % s)
            bad += 1
    log("verify-proto: %d episodes, %d mismatches" % (n, bad))
    return bad == 0


# ---------------------------------------------------------------- S0


def s0(board, cfg, n, log, map_name="v4", target=44):
    """S0: reproduce W4-map section 5 at the v2 config, through THIS port.

    The doctrines themselves are the prototype's (doctrines.py); the world the
    games are played in is the port above.
    """
    proto = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "_tests", "twoengineers", "proto")
    sys.path.insert(0, proto)
    cwd = os.getcwd()
    os.chdir(proto)
    try:
        import doctrines as DOC
    finally:
        os.chdir(cwd)

    if map_name != "v4":
        here = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, os.path.join(here, "_tests", "twoengineers",
                                        "train"))
        import mapv5
        mapv5.register(DOC.MAPS, DOC.CUTS, DOC.SHIP)
    docs = DOC.build(map_name, cfg, target=target)
    t = board.t
    eps = [Episode(s, t, cfg) for s in range(n)]
    keys = [d.key for d in docs]

    def play_doc(ep, da, db):
        g = Game(ep, cfg)
        order_a = da.order_forward()
        order_b = db.order_backward()
        for wi in range(3):
            ba, bb = ep.budgets[wi]
            g.repair_all()
            g.wave_index = wi
            build_phase(g, order_a, order_b, max(0, ba), max(0, bb))
            g.run_wave(wi)
            if g.keep_hp <= 0:
                break
        return g.keep_hp

    matched = {}
    for d in docs:
        sc = [play_doc(ep, d, d) for ep in eps]
        matched[d.key] = sum(sc) / float(len(sc))
    cross = {}
    for da in docs:
        for db in docs:
            if da.key == db.key:
                cross[(da.key, db.key)] = matched[da.key]
                continue
            sc = [play_doc(ep, da, db) for ep in eps]
            cross[(da.key, db.key)] = sum(sc) / float(len(sc))
    return keys, matched, cross


def build_phase(game, order_a, order_b, budget_a, budget_b):
    """The scripted doctrine builder, ported for S0 only. The trained
    engineers never call it."""
    def already(item):
        if item[0] == TURRET:
            for tile in item[1]:
                s = game.struct.get(tile)
                if s is not None and s["kind"] == TURRET:
                    return True
            return False
        for tile in item[1]:
            if tile in game.struct:
                return True
        return False

    def first_option(item):
        if item[0] == TURRET and game.cfg.get("mounted_guns"):
            for tile in item[1]:
                if game.can_mount(tile[0], tile[1]):
                    return tile
            return None
        for tile in item[1]:
            if game.can_build(tile[0], tile[1]):
                return tile
        return None

    game.repair_all()
    budgets = [budget_a, budget_b]
    orders = [order_a, order_b]
    done = [False, False]
    side = 0
    while not (done[0] and done[1]):
        if done[side]:
            side ^= 1
            continue
        placed = False
        for item in orders[side]:
            kind = item[0]
            cost = game.cfg[COST[kind]]
            if cost > budgets[side]:
                continue
            if already(item):
                continue
            tile = first_option(item)
            if tile is None:
                continue
            game.place(tile[0], tile[1], kind, side)
            budgets[side] -= cost
            game.spent[side] += cost
            placed = True
            break
        if not placed:
            done[side] = True
        side ^= 1
    return budgets


# ---------------------------------------------------------------- S1


def load_nets(spec, board):
    """spec is tag=path:hidden,tag=path:hidden,... The hidden width is part of
    the spec because Stage A trains two widths and the S1 matrix has to be able
    to cross them."""
    names = []
    nets = {}
    hid = {}
    for chunk in spec.split(","):
        if not chunk.strip():
            continue
        tag, rest = chunk.split("=", 1)
        path, h = rest.rsplit(":", 1)
        theta = np.load(path)
        h = int(h)
        assert theta.shape == (n_params(h, board.n_in),), (
            "%s has %d parameters, hidden %d wants %d"
            % (tag, theta.shape[0], h, n_params(h, board.n_in)))
        names.append(tag)
        nets[tag] = unpack(theta, h, board.n_in)
        hid[tag] = h
    return names, nets, hid


def s1(board, cfg, spec, n, floor, log):
    """Gate S1: the learned clash, over every ordered pair.

    D2 section 12 asks for min(cross) at least 15 below the weaker diagonal;
    W4-map section 7 measured it with max(cross), which is the stricter reading
    (BOTH crossed orders have to fall away), so that is what this reports, with
    the D2 reading printed beside it.
    """
    t = board.t
    held = [Episode(900000 + i, t, cfg) for i in range(n)]
    names, nets, hid = load_nets(spec, board)
    tiles = board.tiles
    idx = board.idx

    def pair(a, b):
        tot = 0.0
        for ep in held:
            g, _ = play_net(board, ep, nets[a], nets[b], cfg)
            tot += g.keep_hp
        return tot / float(len(held))

    def signature(a, side=0):
        v = np.zeros(2 * len(tiles))
        for ep in held[:64]:
            g, _ = play_net(board, ep, nets[a], nets[a], cfg)
            for tile, st in g.struct.items():
                if st["owner"] != side:
                    continue
                v[2 * idx[tile] + (0 if st["kind"] == WALL else 1)] +=                     cfg[COST[st["kind"]]]
        return v / v.sum() if v.sum() else v

    log("map v4   %d held-out episodes   engineers %s" % (n, " ".join(names)))
    M = {}
    for a in names:
        for b in names:
            M[(a, b)] = pair(a, b)
    log("")
    log("cross matrix (row = seat A, col = seat B)")
    log("%-10s" % "" + "".join("%9s" % b for b in names))
    for a in names:
        log("%-10s" % a + "".join("%9.1f" % M[(a, b)] for b in names))

    sigs = {a: signature(a) for a in names}
    log("")
    log("wall credit share: " +
        "  ".join("%s %.2f" % (a, sigs[a][0::2].sum()) for a in names))
    log("layout distance (total variation):")
    log("%-10s" % "" + "".join("%9s" % b for b in names))
    dist = {}
    for a in names:
        row = "%-10s" % a
        for b in names:
            d = 0.5 * float(np.abs(sigs[a] - sigs[b]).sum())
            dist[(a, b)] = d
            row += "%9.3f" % d
        log(row)

    log("")
    log("%-24s %8s %8s %8s %8s %7s" %
        ("pair", "AxA", "BxB", "worst x", "gap", "layout"))
    npass = 0
    npairs = 0
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            npairs += 1
            mn = min(M[(a, a)], M[(b, b)])
            cr = max(M[(a, b)], M[(b, a)])
            gap = mn - cr
            ok = gap >= 15.0 and mn >= floor and dist[(a, b)] >= 0.40
            npass += 1 if ok else 0
            log("%-24s %8.1f %8.1f %8.1f %8.1f %7.3f  %s"
                % (a + " x " + b, M[(a, a)], M[(b, b)], cr, gap,
                   dist[(a, b)], "PASS" if ok else "FAIL"))
    log("")
    above = [a for a in names if M[(a, a)] >= floor]
    log("engineers at or above the floor of %.0f: %d of %d  (%s)"
        % (floor, len(above), len(names), " ".join(above) or "none"))
    log("S1 over %d distinct pairs: %d pass, %d fail  (floor %.0f, "
        "layout at least 0.40)" % (npairs, npass, npairs - npass, floor))
    return names, M, dist


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--verify-proto", action="store_true")
    ap.add_argument("--fixtures", action="store_true")
    ap.add_argument("--placeholder-model", action="store_true",
                    help="write the untrained placeholder assets/js/keepittogether-model.js")
    ap.add_argument("--export", action="store_true",
                    help="write the TRAINED assets/js/keepittogether-model.js "
                         "from the gate plan named by --plan. It replaces the "
                         "placeholder; it never trains and never gates")
    ap.add_argument("--plan",
                    default="_tests/twoengineers/train/gates/export-plan.json",
                    help="the gates' export plan: the weights file behind each "
                         "of the eighteen nets, G0's and G1's numbers, the six "
                         "plan names and the meta strings")
    ap.add_argument("--model-out", default="assets/js/keepittogether-model.js")
    ap.add_argument("--acc-episode", action="store_true",
                    help="record ONE accommodator episode (7.12 ruling 1): an "
                         "accommodator seat against a specializer intent on a "
                         "probe seed, weights read back out of the export at "
                         "--acc-model, extras recorded per turn per side. It "
                         "writes --acc-out and replays it from the board alone")
    ap.add_argument("--acc-model",
                    default="assets/js/keepittogether-model.js",
                    help="the export the accommodator recording reads its "
                         "weights out of")
    ap.add_argument("--acc-out",
                    default="_tests/twoengineers/fixtures/acc-episode.json")
    ap.add_argument("--acc-net", default="ac0")
    ap.add_argument("--acc-spec", default="spec")
    ap.add_argument("--acc-intent", type=int, default=4)
    ap.add_argument("--acc-seat", type=int, default=0,
                    help="the seat the accommodator sits in; the specializer "
                         "takes the other one")
    ap.add_argument("--acc-seed0", type=int, default=800000)
    ap.add_argument("--acc-seed1", type=int, default=800064)
    ap.add_argument("--acc-in-episodes", action="store_true",
                    help="put the accommodator recording in "
                         "testVector.episodes, which is the field "
                         "checkTestVector replays. Only pass this once the "
                         "shipped core recomputes a per turn trunk extra; "
                         "without it the recording ships under "
                         "testVector.accEpisode, which the core ignores")
    ap.add_argument("--no-acc-record", action="store_true",
                    help="do not add the accommodator recording to --export")
    ap.add_argument("--s0", action="store_true")
    ap.add_argument("--map", default="v4", choices=("v4", "v5"),
                    help="the world. v4 is the shipped board and the default; "
                         "v5 is W4-map section 8b's equal width gates board "
                         "and exists for the section 7.2 diagnosis only")
    ap.add_argument("--target", type=float, default=44.0,
                    help="the doctrine price target S0 builds plans to")
    ap.add_argument("--train", action="store_true")
    ap.add_argument("--s1", default="",
                    help="tag=theta.npy:hidden,... run gate S1 over every "
                         "ordered pair")
    ap.add_argument("--s1-floor", type=float, default=70.0)
    ap.add_argument("--timeit", action="store_true")
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--roll", type=int, default=200)
    ap.add_argument("--hidden", type=int, default=48)
    ap.add_argument("--minutes", type=float, default=58.0)
    ap.add_argument("--pop", type=int, default=48)
    ap.add_argument("--elite", type=int, default=8)
    ap.add_argument("--k", type=int, default=12)
    ap.add_argument("--refresh", type=int, default=4)
    ap.add_argument("--sigma", type=float, default=0.35)
    ap.add_argument("--floor", type=float, default=0.08)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--seln", type=int, default=24, help="held-out selector block")
    ap.add_argument("--evaln", type=int, default=120, help="final held-out block")
    ap.add_argument("--eval-every", type=int, default=2)
    ap.add_argument("--ckpt-every", type=int, default=10)
    ap.add_argument("--gens", type=int, default=0,
                    help="stop after this many generations; 0 means run to "
                         "--minutes. A generation count is the fair unit of "
                         "work when the machine is shared, a wall clock is not")
    ap.add_argument("--init", default="",
                    help="a theta .npy to resume the CEM mean from")
    ap.add_argument("--init-sigma", type=float, default=0.12,
                    help="the sigma a resumed run restarts its search at")
    ap.add_argument("--tag", default="")
    ap.add_argument("--out", default="_tests/twoengineers/train")
    ap.add_argument("--fixdir", default="_tests/twoengineers/fixtures")
    ap.add_argument("--fix-seed", type=int, default=20260905,
                    help="base seed the fixture net search starts from; the "
                         "episode seed is this number exactly")
    ap.add_argument("--net-seed", type=int, default=20260906,
                    help="base seed for the placeholder model draws; it is "
                         "the seed the fixture search settled on, so nets.sp0 "
                         "is bit for bit the fixtures' net")
    args = ap.parse_args()
    if not args.tag:
        args.tag = "s%d" % args.seed

    def log(msg):
        print(msg, flush=True)

    cfg = dict(CFG)
    terrain = Terrain(MAPS[args.map])
    board = Board(terrain, cfg)
    log("map %s  %d buildable tiles  %d inputs  %d params (hidden %d)"
        % (args.map, board.n, board.n_in,
           n_params(args.hidden, board.n_in), args.hidden))
    if args.map != "v4" and args.verify_proto:
        log("FAIL: verify-proto is v4 only, because the reference prototype "
            "under _tests/twoengineers/proto/ ships v4 and nothing in this "
            "file may edit it")
        return 1

    ok = True
    if args.selftest:
        ok = selftest(board, cfg, log) and ok
    if args.timeit:
        theta = random_net(args.hidden, board.n_in, 7)
        eps = [Episode(i, terrain, cfg) for i in range(12)]
        t0 = time.time()
        evaluate(theta, args.hidden, board, eps, cfg)
        log("net game ms %.2f" % ((time.time() - t0) / len(eps) * 1000.0))
    if args.verify_proto:
        ok = verify_proto(board, cfg, args.n, log) and ok
    if args.fixtures:
        make_fixtures(board, cfg, args.fixdir, 48, args.fix_seed, args.roll,
                      log, map_name=args.map)
    if args.placeholder_model:
        placeholder_model(board, cfg, args.model_out, log,
                          map_name=args.map, base=args.net_seed)
    if args.acc_episode:
        model = load_export(args.acc_model)
        if model["arch"]["map"] != args.map:
            log("FAIL: %s names map %s and this run is on %s"
                % (args.acc_model, model["arch"]["map"], args.map))
            return 1
        rec, margin = acc_episode(
            board, cfg, model, log, acc_key=args.acc_net,
            spec_key=args.acc_spec, intent=args.acc_intent,
            acc_seat=args.acc_seat,
            seeds=(args.acc_seed0, args.acc_seed1))
        rec["source"] = dict(model=args.acc_model.replace("\\", "/"),
                             map=args.map, cfgHash=_cfg_hash(cfg),
                             accSource=model["meta"]["source"][args.acc_net],
                             specSource=model["meta"]["source"][args.acc_spec])
        d = os.path.dirname(os.path.abspath(args.acc_out))
        if d and not os.path.isdir(d):
            os.makedirs(d)
        with open(args.acc_out, "w", newline="\n") as fh:
            json.dump(rec, fh, separators=(",", ":"), sort_keys=False)
            fh.write("\n")
        log("wrote %s  %.1f KB"
            % (args.acc_out, os.path.getsize(args.acc_out) / 1024.0))
        with open(args.acc_out, encoding="utf-8") as fh:
            back = json.load(fh)
        good, nck, fails, wS, wH = acc_episode_replay(board, cfg, model, back,
                                                      log)
        ok = good and ok
        if not good:
            log("FAIL: the accommodator recording does not replay (%d of %d "
                "checks failed)" % (len(fails), nck))
        pgood, pn, pfails, defect = acc_episode_proofs(board, cfg, model, back,
                                                       log)
        ok = pgood and ok
        log("recording proofs: %d checks, %d failures" % (pn, len(pfails)))
    if args.export:
        with open(args.plan, encoding="utf-8") as fh:
            plan = json.load(fh)
        if plan.get("map", args.map) != args.map:
            log("FAIL: the plan was written for map %s and this run is on %s"
                % (plan.get("map"), args.map))
            return 1
        trained_model(board, cfg, plan, args.model_out, log,
                      map_name=args.map,
                      acc_record=not args.no_acc_record,
                      acc_in_episodes=bool(args.acc_in_episodes),
                      acc_key=args.acc_net, acc_spec=args.acc_spec,
                      acc_intent=args.acc_intent, acc_seat=args.acc_seat,
                      acc_out=args.acc_out)
    if args.s0:
        keys, matched, cross = s0(board, cfg, args.n, log,
                                  map_name=args.map, target=args.target)
        log("")
        log("MATCHED PAIRS over %d episodes" % args.n)
        for k in keys:
            log("  %-10s %6.1f" % (k, matched[k]))
        log("")
        log("CROSS MATRIX")
        log("  %-10s" % "" + "".join("%8s" % k[:7] for k in keys))
        for a in keys:
            log("  %-10s" % a + "".join("%8.1f" % cross[(a, b)] for b in keys))
        offs = [cross[(a, b)] for a in keys for b in keys if a != b]
        diag = [matched[k] for k in keys]
        log("")
        log("diagonal mean %.1f  off diagonal mean %.1f  clash %.1f"
            % (sum(diag) / len(diag), sum(offs) / len(offs),
               sum(diag) / len(diag) - sum(offs) / len(offs)))
        worst = None
        fails = 0
        for a in keys:
            for b in keys:
                if a == b:
                    continue
                v = cross[(a, b)]
                floor = min(matched[a], matched[b])
                gap = floor - v
                if not (gap >= 15.0 and v <= 0.85 * floor):
                    fails += 1
                if worst is None or gap < worst[2]:
                    worst = (a, b, gap, v, floor)
        log("smallest clash: %s x %s  cross %.1f vs floor %.1f  gap %.1f"
            % (worst[0], worst[1], worst[3], worst[4], worst[2]))
        log("clash gate: %d of %d clear" % (len(offs) - fails, len(offs)))
        best = max(diag)
        oka = sum(1 for k in keys if matched[k] >= 0.90 * best)
        log("equality gate: %d of %d at or above 90 percent of the best"
            % (oka, len(keys)))
    if args.s1:
        s1(board, cfg, args.s1, args.evaln, args.s1_floor, log)
    if args.train:
        os.makedirs(args.out, exist_ok=True)
        theta, best_sel, best_gen, hist, games = cem(args, board, cfg, log)
        np.save(os.path.join(args.out, "theta_%s.npy" % args.tag), theta)
        held = [Episode(900000 + i, terrain, cfg) for i in range(args.evaln)]
        final = evaluate(theta, args.hidden, board, held, cfg)
        log("")
        log("=== held-out evaluation, %d unseen episodes ===" % args.evaln)
        log("  exported generation      %d" % best_gen)
        log("  selector score           %.1f" % best_sel)
        log("  learned self-play pair   %.1f" % final)
        log("  games played             %d" % games)
        with open(os.path.join(args.out, "result_%s.json" % args.tag),
                  "w", newline="\n") as fh:
            json.dump(dict(tag=args.tag, seed=args.seed, hidden=args.hidden,
                           nIn=board.n_in, minutes=args.minutes,
                           bestGen=best_gen, selector=best_sel,
                           heldout=final, games=games,
                           gens=len(hist)), fh, indent=1)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
