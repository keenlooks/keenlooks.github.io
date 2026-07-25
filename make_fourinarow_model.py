#!/usr/bin/env python3
"""
make_fourinarow_model.py - trains the Four in a Row policy/value net for /fourinarow/
and exports it to assets/js/fourinarow-model.js (int8-quantized + base64).

Pipeline (see .claude/plans/plan-fourinarow.md):
  Stage A: an exact alpha-beta TEACHER (bitboards) plays epsilon-diversified games;
           the net is trained supervised on (position -> teacher move set, game outcome).
  Stage B: AlphaZero-style self-play refinement (batched-leaf MCTS across parallel
           games), with an arena gate per iteration.

Everything is pure numpy - no torch. The browser (assets/js/fourinarow-core.js)
re-implements the forward pass; the exported testVector (computed with the DEQUANTIZED
int8 weights) lets the page verify parity at load, exactly like the transformer demo.

Usage (run with `python -u`; long stages checkpoint to the workdir):
  python -u make_fourinarow_model.py --gradcheck
  python -u make_fourinarow_model.py --teacher-selftest
  python -u make_fourinarow_model.py --gen-data 12000        # games (Stage A data)
  python -u make_fourinarow_model.py --train-a
  python -u make_fourinarow_model.py --stage-b --iters 8 --games 1500 --sims 96
  python -u make_fourinarow_model.py --gauntlet stage_b_best.npz
  python -u make_fourinarow_model.py --export stage_b_best.npz
  python -u make_fourinarow_model.py --smoke                 # tiny end-to-end sanity run

Workdir (checkpoints, data, logs): %LOCALAPPDATA%/Temp/c4train  (never in the repo).
"""

import argparse
import base64
import json
import os
import sys
import time

import numpy as np

WORKDIR = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Temp", "c4train"
)
EXPORT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "assets", "js", "fourinarow-model.js")

W, H = 7, 6
COL_ORDER = [3, 2, 4, 1, 5, 0, 6]  # center-first move ordering for the teacher

# ---------------------------------------------------------------------------
# Bitboard game (teacher representation).
# Column c owns bits c*7 .. c*7+6; bit c*7 is row 0 (bottom); bit c*7+6 is a
# sentinel row that never holds a stone. `pos` = stones of the side to move,
# `mask` = all stones. (Pascal Pons' classic layout, reimplemented.)
# ---------------------------------------------------------------------------

BOTTOM = sum(1 << (c * 7) for c in range(W))
FULL_TOP = sum(1 << (c * 7 + H - 1) for c in range(W))  # highest playable cell per col


def can_play(mask, col):
    return (mask & (1 << (col * 7 + H - 1))) == 0


def play(pos, mask, col):
    """Returns (pos', mask') from the NEXT player's perspective."""
    new_mask = mask | (mask + (1 << (col * 7)))
    return pos ^ mask, new_mask


def winning_bit(mask, col):
    """The bit the next stone in `col` would occupy."""
    return (mask + (1 << (col * 7))) & (((1 << 7) - 1) << (col * 7))


def has_won(p):
    for s in (1, 7, 6, 8):  # vertical, horizontal, diag /, diag \
        q = p & (p >> s)
        if q & (q >> (2 * s)):
            return True
    return False


def is_winning_move(pos, mask, col):
    return has_won(pos | winning_bit(mask, col))


def popcount(x):
    return bin(x).count("1")


COL_MASK = [(((1 << H) - 1) << (c * 7)) for c in range(W)]
CENTER_W = (1, 2, 3, 4, 3, 2, 1)


def heuristic(pos, mask):
    """Cheap center-control eval for depth-0 cutoffs. |h| <= ~84, far below
    WIN_BASE, so it only breaks ties between moves the search left unresolved
    (this is what gives Stage A policy labels strategic signal early-game)."""
    opp = pos ^ mask
    h = 0
    for c in range(W):
        cm = COL_MASK[c]
        h += CENTER_W[c] * (popcount(pos & cm) - popcount(opp & cm))
    return h


# ---------------------------------------------------------------------------
# Teacher: negamax alpha-beta with a transposition table + iterative deepening.
# Scores: win for side to move = +(10000 - ply_of_win), loss symmetric, draw 0,
# unknown-at-depth = 0 heuristic. Good enough for strong move labels.
# ---------------------------------------------------------------------------

WIN_BASE = 10000


class Teacher:
    def __init__(self, depth=9):
        self.depth = depth
        self.tt = {}

    def _negamax(self, pos, mask, depth, alpha, beta, ply):
        # immediate win available?
        for c in COL_ORDER:
            if can_play(mask, c) and is_winning_move(pos, mask, c):
                return WIN_BASE - (ply + 1)
        if popcount(mask) == W * H:
            return 0
        if depth == 0:
            return heuristic(pos, mask)

        key = (pos, mask)
        hit = self.tt.get(key)
        if hit is not None and hit[0] >= depth:
            flag, lo_or_score = hit[1], hit[2]
            if flag == 0:
                return lo_or_score
            if flag == 1 and lo_or_score >= beta:
                return lo_or_score
            if flag == 2 and lo_or_score <= alpha:
                return lo_or_score

        best = -WIN_BASE * 2
        a0 = alpha
        for c in COL_ORDER:
            if not can_play(mask, c):
                continue
            p2, m2 = play(pos, mask, c)
            v = -self._negamax(p2, m2, depth - 1, -beta, -alpha, ply + 1)
            if v > best:
                best = v
            if best > alpha:
                alpha = best
            if alpha >= beta:
                break
        flag = 0 if a0 < best < beta else (1 if best >= beta else 2)
        if len(self.tt) > 2_000_000:
            self.tt.clear()
        self.tt[key] = (depth, flag, best)
        return best

    def root_scores(self, pos, mask, ply):
        """Score every legal move at the root. Returns {col: score}."""
        out = {}
        for c in range(W):
            if not can_play(mask, c):
                continue
            if is_winning_move(pos, mask, c):
                out[c] = WIN_BASE - (ply + 1)
                continue
            p2, m2 = play(pos, mask, c)
            out[c] = -self._negamax(p2, m2, self.depth - 1,
                                    -2 * WIN_BASE, 2 * WIN_BASE, ply + 1)
        return out

    def best_moves(self, pos, mask, ply):
        scores = self.root_scores(pos, mask, ply)
        top = max(scores.values())
        return [c for c, s in scores.items() if s == top], scores


def teacher_selftest():
    """The teacher must never miss an immediate win nor fail to block one."""
    rng = np.random.default_rng(0)
    t = Teacher(depth=5)
    checked_win = checked_block = 0
    for g in range(400):
        pos, mask, ply = 0, 0, 0
        while ply < 30:
            legal = [c for c in range(W) if can_play(mask, c)]
            if not legal:
                break
            wins = [c for c in legal if is_winning_move(pos, mask, c)]
            if wins:
                best, _ = t.best_moves(pos, mask, ply)
                assert set(best) <= set(wins), f"missed win: game {g} ply {ply}"
                checked_win += 1
                break
            # does the opponent threaten a win next move? then we must block (or win).
            opp = pos ^ mask
            threats = [c for c in legal if has_won(opp | winning_bit(mask, c))]
            if len(threats) == 1:
                best, scores = t.best_moves(pos, mask, ply)
                # every non-blocking move loses; the teacher's best must include the
                # block unless it found something scoring >= the block (impossible
                # here since any non-block loses immediately).
                assert threats[0] in best or all(
                    scores[b] <= -(WIN_BASE - (ply + 3)) for b in best
                ), f"missed block: game {g} ply {ply} best={best} threat={threats}"
                checked_block += 1
            c = int(rng.choice(legal))
            pos, mask = play(pos, mask, c)
            ply += 1
    print(f"teacher selftest OK ({checked_win} win checks, {checked_block} block checks)")


# ---------------------------------------------------------------------------
# Array-board helpers (NN representation). board: int8 (6,7), row 0 = bottom,
# values 0 empty / 1 first player / 2 second player.
# ---------------------------------------------------------------------------

def moves_to_board(moves):
    b = np.zeros((H, W), dtype=np.int8)
    hgt = np.zeros(W, dtype=np.int8)
    for i, c in enumerate(moves):
        b[hgt[c], c] = 1 + (i & 1)
        hgt[c] += 1
    return b, hgt


def planes_from_board(b, stm):
    """(2,6,7) float32: plane 0 = side-to-move stones, plane 1 = opponent."""
    me = (b == stm).astype(np.float32)
    op = ((b != 0) & (b != stm)).astype(np.float32)
    return np.stack([me, op])


def batch_planes(boards, stms):
    n = len(boards)
    x = np.empty((n, 2, H, W), dtype=np.float32)
    for i in range(n):
        x[i] = planes_from_board(boards[i], stms[i])
    return x


# ---------------------------------------------------------------------------
# The network (numpy). conv3x3(2->32) -> conv3x3(32->32) -> conv3x3(32->32)
# -> flatten -> [policy fc 1344->7]  [value fc 1344->64 relu -> 64->1 tanh]
# All convs stride 1, pad 1 (same shape). im2col forward; backward-data via
# convolution with rotated kernels (also im2col), so no scatter-adds.
# ---------------------------------------------------------------------------

def he(shape, rng, fan_in):
    return (rng.standard_normal(shape) * np.sqrt(2.0 / fan_in)).astype(np.float32)


def init_params(rng, ch=32):
    p = {
        "c1w": he((ch, 2 * 9), rng, 2 * 9), "c1b": np.zeros(ch, np.float32),
        "c2w": he((ch, ch * 9), rng, ch * 9), "c2b": np.zeros(ch, np.float32),
        "c3w": he((ch, ch * 9), rng, ch * 9), "c3b": np.zeros(ch, np.float32),
        "pw": he((7, ch * H * W), rng, ch * H * W), "pb": np.zeros(7, np.float32),
        "v1w": he((64, ch * H * W), rng, ch * H * W), "v1b": np.zeros(64, np.float32),
        "v2w": he((1, 64), rng, 64), "v2b": np.zeros(1, np.float32),
    }
    return p


class Im2Col:
    """Precomputed gather indices for 3x3/pad1 over a (H, W) grid."""

    def __init__(self):
        idx = []
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for i in range(H):
                    for j in range(W):
                        ii, jj = i + di, j + dj
                        if 0 <= ii < H and 0 <= jj < W:
                            idx.append(ii * W + jj)
                        else:
                            idx.append(H * W)  # points at the zero pad slot
        self.idx = np.array(idx, dtype=np.int64).reshape(9, H * W)

    def run(self, x):
        """x: (N, C, 42) -> (N, C*9, 42)"""
        n, c, _ = x.shape
        xp = np.concatenate([x, np.zeros((n, c, 1), x.dtype)], axis=2)  # pad slot
        cols = xp[:, :, self.idx]              # (N, C, 9, 42)
        return cols.reshape(n, c * 9, H * W)


I2C = Im2Col()


def conv_fwd(x, w, b):
    """x: (N,C,42)  w: (Cout, C*9)  ->  (N, Cout, 42)"""
    cols = I2C.run(x)
    y = np.einsum("oc,ncl->nol", w, cols, optimize=True) + b[None, :, None]
    return y, cols


def rot_weights(w, c_in):
    """(Cout, Cin*9) -> (Cin, Cout*9) with the 3x3 taps rotated 180 degrees,
    for the backward-data pass (dx = w_rot (*) dout)."""
    c_out = w.shape[0]
    w4 = w.reshape(c_out, c_in, 9)[:, :, ::-1]          # rotate 180 = reverse taps
    return np.ascontiguousarray(w4.transpose(1, 0, 2)).reshape(c_in, c_out * 9)


def conv_bwd(dout, cols, w, c_in):
    """Returns (dx, dw, db). dout: (N, Cout, 42)."""
    dw = np.einsum("nol,ncl->oc", dout, cols, optimize=True)
    db = dout.sum(axis=(0, 2))
    dcols = I2C.run(dout)                                # (N, Cout*9, 42)
    dx = np.einsum("ic,ncl->nil", rot_weights(w, c_in), dcols, optimize=True)
    return dx, dw, db


def forward(p, x, want_grads=False):
    """x: (N,2,6,7). Returns (logits (N,7), value (N,), cache)."""
    n = x.shape[0]
    a0 = x.reshape(n, 2, H * W)
    z1, cols1 = conv_fwd(a0, p["c1w"], p["c1b"]); a1 = np.maximum(z1, 0)
    z2, cols2 = conv_fwd(a1, p["c2w"], p["c2b"]); a2 = np.maximum(z2, 0)
    z3, cols3 = conv_fwd(a2, p["c3w"], p["c3b"]); a3 = np.maximum(z3, 0)
    flat = a3.reshape(n, -1)
    logits = flat @ p["pw"].T + p["pb"]
    zv1 = flat @ p["v1w"].T + p["v1b"]; av1 = np.maximum(zv1, 0)
    vraw = av1 @ p["v2w"].T + p["v2b"]
    value = np.tanh(vraw[:, 0])
    cache = None
    if want_grads:
        cache = dict(a0=a0, z1=z1, a1=a1, cols1=cols1, z2=z2, a2=a2, cols2=cols2,
                     z3=z3, a3=a3, cols3=cols3, flat=flat, zv1=zv1, av1=av1,
                     value=value, logits=logits)
    return logits, value, cache


def backward(p, cache, dlogits, dvalue):
    """dlogits: (N,7), dvalue: (N,) upstream grads. Returns grad dict."""
    n = dlogits.shape[0]
    g = {}
    flat = cache["flat"]
    g["pw"] = dlogits.T @ flat
    g["pb"] = dlogits.sum(0)
    dvraw = (dvalue * (1.0 - cache["value"] ** 2))[:, None]
    g["v2w"] = dvraw.T @ cache["av1"]
    g["v2b"] = dvraw.sum(0)
    dav1 = dvraw @ p["v2w"]
    dzv1 = dav1 * (cache["zv1"] > 0)
    g["v1w"] = dzv1.T @ flat
    g["v1b"] = dzv1.sum(0)
    dflat = dlogits @ p["pw"] + dzv1 @ p["v1w"]
    da3 = dflat.reshape(n, -1, H * W)
    dz3 = da3 * (cache["z3"] > 0)
    dx3, g["c3w"], g["c3b"] = conv_bwd(dz3, cache["cols3"], p["c3w"], p["c3w"].shape[1] // 9)
    dz2 = dx3 * (cache["z2"] > 0)
    dx2, g["c2w"], g["c2b"] = conv_bwd(dz2, cache["cols2"], p["c2w"], p["c2w"].shape[1] // 9)
    dz1 = dx2 * (cache["z1"] > 0)
    _, g["c1w"], g["c1b"] = conv_bwd(dz1, cache["cols1"], p["c1w"], p["c1w"].shape[1] // 9)
    return g


def loss_and_grads(p, x, pi_target, z_target, l2=1e-4):
    """Cross-entropy(policy) + MSE(value) + L2. Returns (loss, grads, metrics)."""
    n = x.shape[0]
    logits, value, cache = forward(p, x, want_grads=True)
    m = logits.max(axis=1, keepdims=True)
    e = np.exp(logits - m)
    probs = e / e.sum(axis=1, keepdims=True)
    ce = -(pi_target * np.log(probs + 1e-9)).sum(axis=1).mean()
    mse = ((value - z_target) ** 2).mean()
    loss = ce + mse
    dlogits = (probs - pi_target) / n
    dvalue = 2.0 * (value - z_target) / n
    g = backward(p, cache, dlogits.astype(np.float32), dvalue.astype(np.float32))
    for k in g:
        if k.endswith("w"):
            g[k] += l2 * p[k]
            loss += 0.5 * l2 * float((p[k] ** 2).sum())
    acc = float((probs.argmax(1) == pi_target.argmax(1)).mean())
    vsign = float(((value > 0) == (z_target > 0))[np.abs(z_target) > 0.5].mean()) \
        if (np.abs(z_target) > 0.5).any() else 0.0
    return loss, g, {"ce": float(ce), "mse": float(mse), "acc": acc, "vsign": vsign}


class Adam:
    def __init__(self, params, lr=1e-3):
        self.lr = lr
        self.t = 0
        self.m = {k: np.zeros_like(v) for k, v in params.items()}
        self.v = {k: np.zeros_like(v) for k, v in params.items()}

    def step(self, params, grads):
        self.t += 1
        b1, b2, eps = 0.9, 0.999, 1e-8
        for k in params:
            self.m[k] = b1 * self.m[k] + (1 - b1) * grads[k]
            self.v[k] = b2 * self.v[k] + (1 - b2) * grads[k] ** 2
            mh = self.m[k] / (1 - b1 ** self.t)
            vh = self.v[k] / (1 - b2 ** self.t)
            params[k] -= (self.lr * mh / (np.sqrt(vh) + eps)).astype(np.float32)


def gradcheck():
    """Finite-difference check on a tiny net in float64."""
    global I2C
    rng = np.random.default_rng(1)
    p = init_params(rng, ch=4)
    p = {k: v.astype(np.float64) for k, v in p.items()}
    # randomize biases: at exact zero biases, dead-ReLU patches make deeper
    # pre-activations sit EXACTLY on the ReLU kink, where the loss is genuinely
    # non-differentiable in the bias direction (central differences then disagree
    # with the subgradient by construction, not by bug).
    for k in p:
        if k.endswith("b"):
            p[k] = p[k] + rng.normal(0, 0.05, p[k].shape)
    x = rng.standard_normal((3, 2, H, W))
    pi = rng.random((3, 7))
    pi /= pi.sum(1, keepdims=True)
    z = rng.uniform(-1, 1, 3)

    def f(pp):
        logits, value, _ = forward(pp, x, want_grads=False)
        m = logits.max(axis=1, keepdims=True)
        e = np.exp(logits - m)
        probs = e / e.sum(axis=1, keepdims=True)
        ce = -(pi * np.log(probs + 1e-9)).sum(axis=1).mean()
        return ce + ((value - z) ** 2).mean()

    _, g, _ = loss_and_grads(p, x, pi, z, l2=0.0)
    worst = 0.0
    rng2 = np.random.default_rng(2)
    for k in p:
        flat = p[k].ravel()
        for _ in range(12):
            i = int(rng2.integers(flat.size))
            eps = 1e-6
            old = flat[i]
            flat[i] = old + eps; f1 = f(p)
            flat[i] = old - eps; f2 = f(p)
            flat[i] = old
            num = (f1 - f2) / (2 * eps)
            ana = g[k].ravel()[i]
            rel = abs(num - ana) / max(1e-8, abs(num) + abs(ana))
            worst = max(worst, rel)
    print(f"gradcheck worst rel err: {worst:.3e}")
    assert worst < 1e-4, "GRADCHECK FAILED"
    print("gradcheck OK")


# ---------------------------------------------------------------------------
# Stage A: teacher games -> supervised data (multiprocessed; games are
# independent, each worker keeps a persistent Teacher + TT).
# ---------------------------------------------------------------------------

_WT = None  # per-worker Teacher


def _pool_init(depth):
    global _WT
    _WT = Teacher(depth=depth)


def _gen_game(args):
    seed, eps = args
    rng = np.random.default_rng(seed)
    t = _WT
    moves = []
    pos, mask = 0, 0
    recs = []
    winner = 0
    ply = 0
    while True:
        legal = [c for c in range(W) if can_play(mask, c)]
        if not legal:
            break
        best, _scores = t.best_moves(pos, mask, ply)
        pi = np.full(7, 0.03 / 7, dtype=np.float32)
        for c in best:
            pi[c] += 0.97 / len(best)
        b, _ = moves_to_board(moves)
        recs.append((b, 1 + (ply & 1), pi))
        if rng.random() < eps:
            c = int(rng.choice(legal))
        else:
            c = int(rng.choice(best))
        if is_winning_move(pos, mask, c):
            winner = 1 + (ply & 1)
            moves.append(c)
            break
        pos, mask = play(pos, mask, c)
        moves.append(c)
        ply += 1
    if len(t.tt) > 1_000_000:
        t.tt.clear()
    out = []
    for b, stm, pi in recs:
        z = 0.0 if winner == 0 else (1.0 if winner == stm else -1.0)
        out.append((b, stm, pi, z))
    return out


def gen_data(n_games, depth=8, eps=0.15, seed=0, out="stage_a_data.npz", procs=None):
    import multiprocessing as mp
    os.makedirs(WORKDIR, exist_ok=True)
    procs = procs or max(1, (os.cpu_count() or 4) - 1)
    print(f"generating {n_games} teacher games at depth {depth} on {procs} workers")
    args = [(seed * 1_000_003 + i, eps) for i in range(n_games)]
    boards, stms, pis, zs = [], [], [], []
    t0 = time.time()
    done = 0
    with mp.Pool(procs, initializer=_pool_init, initargs=(depth,)) as pool:
        for recs in pool.imap_unordered(_gen_game, args, chunksize=4):
            for b, stm, pi, z in recs:
                boards.append(b); stms.append(stm); pis.append(pi); zs.append(z)
            done += 1
            if done % 200 == 0:
                el = time.time() - t0
                eta = el / done * (n_games - done)
                print(f"gen {done}/{n_games} games, {len(boards)} positions, "
                      f"{el:.0f}s elapsed, ETA {eta/60:.0f} min", flush=True)
    np.savez_compressed(
        os.path.join(WORKDIR, out),
        boards=np.array(boards, dtype=np.int8),
        stms=np.array(stms, dtype=np.int8),
        pis=np.array(pis, dtype=np.float32),
        zs=np.array(zs, dtype=np.float32),
    )
    print(f"saved {len(boards)} positions -> {os.path.join(WORKDIR, out)}")


def probe(depth=8, games=8):
    """Measure teacher sec/game so long runs are projected, not guessed."""
    _pool_init(depth)
    t0 = time.time()
    n_pos = 0
    for i in range(games):
        n_pos += len(_gen_game((424242 + i, 0.15)))
    per = (time.time() - t0) / games
    procs = max(1, (os.cpu_count() or 4) - 1)
    print(f"probe: depth {depth}: {per:.2f}s/game single-core, ~{n_pos//games} pos/game")
    for target in (6000, 12000):
        print(f"  projected {target} games on {procs} workers: "
              f"~{target * per / procs / 3600:.1f} h")


def mirror_batch(x, pi):
    return x[:, :, :, ::-1].copy(), pi[:, ::-1].copy()


def train_a(epochs=8, batch=256, lr=1e-3, data="stage_a_data.npz",
            out="stage_a.npz", ch=32, seed=3):
    d = np.load(os.path.join(WORKDIR, data))
    boards, stms, pis, zs = d["boards"], d["stms"], d["pis"], d["zs"]
    n = len(boards)
    n_val = min(max(2000, n // 20), max(1, n // 5))
    rng = np.random.default_rng(seed)
    perm = rng.permutation(n)
    val_idx, tr_idx = perm[:n_val], perm[n_val:]
    print(f"training on {len(tr_idx)} positions, validating on {len(val_idx)}")

    p = init_params(rng, ch=ch)
    opt = Adam(p, lr=lr)
    xv = batch_planes(boards[val_idx], stms[val_idx])
    piv, zv = pis[val_idx], zs[val_idx]

    steps_total = epochs * (len(tr_idx) // batch)
    step = 0
    for ep in range(epochs):
        rng.shuffle(tr_idx)
        for i in range(0, len(tr_idx) - batch + 1, batch):
            idx = tr_idx[i:i + batch]
            x = batch_planes(boards[idx], stms[idx])
            pi, z = pis[idx].copy(), zs[idx]
            flip = rng.random(len(idx)) < 0.5
            x[flip] = x[flip][:, :, :, ::-1]
            pi[flip] = pi[flip][:, ::-1]
            opt.lr = lr * (0.5 * (1 + np.cos(np.pi * step / max(1, steps_total)))) \
                * 0.9 + lr * 0.1
            loss, g, met = loss_and_grads(p, x, pi, z)
            opt.step(p, g)
            step += 1
            if step % 200 == 0:
                print(f"ep {ep} step {step} loss {loss:.4f} ce {met['ce']:.4f} "
                      f"acc {met['acc']:.3f}", flush=True)
        lv, _, mv = loss_and_grads(p, xv[:4096], piv[:4096], zv[:4096], l2=0.0)
        print(f"== epoch {ep}: val loss {lv:.4f} acc {mv['acc']:.3f} "
              f"vsign {mv['vsign']:.3f}", flush=True)
    save_ckpt(p, out, {"stage": "A", "epochs": epochs, "positions": int(n)})
    print(f"saved {out}")


def save_ckpt(p, name, meta):
    os.makedirs(WORKDIR, exist_ok=True)
    np.savez(os.path.join(WORKDIR, name), __meta=json.dumps(meta), **p)


def load_ckpt(name):
    d = np.load(os.path.join(WORKDIR, name) if not os.path.isabs(name) else name,
                allow_pickle=False)
    p = {k: d[k].astype(np.float32) for k in d.files if k != "__meta"}
    meta = json.loads(str(d["__meta"])) if "__meta" in d.files else {}
    return p, meta


# ---------------------------------------------------------------------------
# MCTS (Python mirror of the JS spec) - single-game object tree, batched leaf
# evaluation handled by the self-play driver.
# ---------------------------------------------------------------------------

class Node:
    __slots__ = ("P", "N", "W", "kids", "legal", "terminal")

    def __init__(self, legal):
        self.P = None
        self.N = np.zeros(7, np.float32)
        self.W = np.zeros(7, np.float32)
        self.kids = [None] * 7
        self.legal = legal
        self.terminal = [0] * 7  # 0 unknown, 1 win-for-mover, 2 draw


CPUCT = 1.5


class Game:
    """One self-play game: board state + tree + a pending-leaf slot."""

    def __init__(self, rng):
        self.moves = []
        self.pos, self.mask = 0, 0
        self.board = np.zeros((H, W), np.int8)
        self.hgt = np.zeros(W, np.int8)
        self.root = Node(self._legal())
        self.rng = rng
        self.done = False
        self.winner = 0
        self.records = []
        self.path = None  # pending backup path [(node, action)...]
        self.leaf = None  # pending Node awaiting expansion

    def _legal(self):
        return [c for c in range(W) if can_play(self.mask, c)]

    def stm(self):
        return 1 + (len(self.moves) & 1)

    def planes(self):
        return planes_from_board(self.board, self.stm())

    def planes_after_path(self):
        b = self.board.copy()
        stm = self.stm()
        for _, a in self.path:
            hh = int(np.argmax(b[:, a] == 0)) if (b[:, a] == 0).any() else H
            b[hh, a] = stm
            stm = 3 - stm
        return planes_from_board(b, stm)

    def select_to_leaf(self, dirichlet=False):
        """Descend by PUCT until a node needing eval / terminal edge. Sets
        self.path (+ self.leaf if an eval is needed). Returns True if an
        NN eval is required."""
        node = self.root
        pos, mask = self.pos, self.mask
        path = []
        while True:
            if node.P is None:
                self.path, self.leaf = path, node
                self._leaf_pm = (pos, mask)
                return True
            P = node.P
            if dirichlet and node is self.root:
                P = self._root_P
            sq = np.sqrt(node.N.sum() + 1e-8)
            best_a, best_u = -1, -1e30
            for a in node.legal:
                if node.terminal[a] == 1:
                    # immediate win for the mover: always best
                    best_a, best_u = a, 1e30
                    break
                q = node.W[a] / node.N[a] if node.N[a] > 0 else 0.0
                u = q + CPUCT * P[a] * sq / (1.0 + node.N[a])
                if u > best_u:
                    best_a, best_u = a, u
            a = best_a
            path.append((node, a))
            if node.terminal[a] == 0:
                if is_winning_move(pos, mask, a):
                    node.terminal[a] = 1
                elif popcount(mask) + 1 == W * H:
                    node.terminal[a] = 2
            if node.terminal[a] == 1:
                self.path = path
                self._backup(-1.0)  # child position value: mover just lost
                return False
            if node.terminal[a] == 2:
                self.path = path
                self._backup(0.0)
                return False
            pos, mask = play(pos, mask, a)
            if node.kids[a] is None:
                node.kids[a] = Node([c for c in range(W) if can_play(mask, c)])
            node = node.kids[a]

    def expand_and_backup(self, logits, value):
        node = self.leaf
        mask_np = np.full(7, -1e30, np.float32)
        for c in node.legal:
            mask_np[c] = logits[c]
        e = np.exp(mask_np - mask_np.max())
        node.P = (e / e.sum()).astype(np.float32)
        self.leaf = None
        self._backup(float(value))

    def _backup(self, v_child):
        """v_child = value of the position AFTER the last edge in path, from
        that position's side-to-move perspective."""
        v = v_child
        for node, a in reversed(self.path):
            v = -v
            node.N[a] += 1
            node.W[a] += v
        self.path = None

    def new_root_noise(self, rng):
        if self.root.P is None:
            return
        noise = rng.dirichlet([1.0] * len(self.root.legal))
        P = self.root.P.copy()
        for i, a in enumerate(self.root.legal):
            P[a] = 0.75 * P[a] + 0.25 * noise[i]
        self._root_P = P

    def play_move(self, temp_plies=8):
        n = self.root.N
        ply = len(self.moves)
        # record training target: visit distribution
        pi = n / max(1.0, n.sum())
        self.records.append((self.board.copy(), self.stm(), pi.astype(np.float32)))
        if ply < temp_plies:
            if n.sum() > 0:
                # float64 + renormalize: seven float32 quotients routinely miss
                # summing to 1 by ~1e-7, which rng.choice rejects intermittently
                pr = (n / n.sum()).astype(np.float64)
                pr /= pr.sum()
                a = int(self.rng.choice(7, p=pr))
            else:
                a = int(self.rng.choice(self.root.legal))
        else:
            mx = n.max()
            cand = [c for c in self.root.legal if n[c] == mx]
            a = int(self.rng.choice(cand))
        if is_winning_move(self.pos, self.mask, a):
            self.winner = self.stm()
            self.done = True
        self.board[self.hgt[a], a] = self.stm()
        self.hgt[a] += 1
        self.pos, self.mask = play(self.pos, self.mask, a)
        self.moves.append(a)
        if not self.done and popcount(self.mask) == W * H:
            self.done = True
        kid = self.root.kids[a]
        self.root = kid if kid is not None else Node(
            [c for c in range(W) if can_play(self.mask, c)])

    def finalize(self):
        out = []
        for b, stm, pi in self.records:
            z = 0.0 if self.winner == 0 else (1.0 if self.winner == stm else -1.0)
            out.append((b, stm, pi, z))
        return out


def run_sims(active, sims, net_of, dirichlet):
    """Run `sims` batched-leaf simulations for every game in `active`.
    net_of(g) picks the param dict for game g's CURRENT side to move (this is
    what lets the arena batch two different nets)."""
    for _ in range(sims):
        buckets = {}
        for g in active:
            if g.select_to_leaf(dirichlet=(dirichlet and g._root_P is not None)):
                pnet = net_of(g)
                buckets.setdefault(id(pnet), (pnet, []))[1].append(g)
        for _, (pnet, gs) in buckets.items():
            x = np.stack([g.planes_after_path() for g in gs])
            logits, value, _ = forward(pnet, x)
            for i, g in enumerate(gs):
                g.expand_and_backup(logits[i], value[i])
        if dirichlet:
            for g in active:
                if g._root_P is None and g.root.P is not None:
                    g.new_root_noise(g.rng)


def self_play(p, n_games, sims=96, par=512, seed=0, temp_plies=8, quiet=False):
    """Batched-leaf self-play. Returns list of (board, stm, pi, z)."""
    rng = np.random.default_rng(seed)
    data = []
    active = [Game(np.random.default_rng(rng.integers(1 << 62)))
              for _ in range(min(par, n_games))]
    started = len(active)
    finished = 0
    sims_done = 0
    t0 = time.time()
    while active:
        for g in active:
            g._root_P = None
        run_sims(active, sims, lambda g: p, dirichlet=True)
        sims_done += sims * len(active)
        for g in active:
            g.play_move(temp_plies=temp_plies)
        done = [g for g in active if g.done]
        for g in done:
            data.extend(g.finalize())
            finished += 1
        active = [g for g in active if not g.done]
        while started < n_games and len(active) < par:
            active.append(Game(np.random.default_rng(rng.integers(1 << 62))))
            started += 1
        if done and not quiet and finished % 100 < len(done):
            el = time.time() - t0
            print(f"self-play {finished}/{n_games} games, {len(data)} positions, "
                  f"{el:.0f}s, {sims_done/max(1,el):.0f} sims/s", flush=True)
    return data


def arena_batched(p_cand, p_best, n_games, sims=100, par=256, seed=0):
    """Candidate vs best through the same batched-leaf engine. Each game's
    mover searches with their OWN net; colors alternate by game index; the
    first 2 plies sample by visits for opening variety. Returns candidate's
    score (win 1 / draw 0.5)."""
    rng = np.random.default_rng(seed)

    def make(i):
        g = Game(np.random.default_rng(rng.integers(1 << 62)))
        g.cand_first = (i % 2 == 0)
        return g

    started = min(par, n_games)
    active = [make(i) for i in range(started)]
    score = 0.0

    def net_of(g):
        return p_cand if ((g.stm() == 1) == g.cand_first) else p_best

    while active:
        for g in active:
            g._root_P = None
        run_sims(active, sims, net_of, dirichlet=False)
        for g in active:
            g.play_move(temp_plies=2)
        done = [g for g in active if g.done]
        for g in done:
            if g.winner == 0:
                score += 0.5
            elif (g.winner == 1) == g.cand_first:
                score += 1.0
        active = [g for g in active if not g.done]
        while started < n_games and len(active) < par:
            active.append(make(started))
            started += 1
    return score


def _game_from_moves(moves, rng):
    g = Game(rng)
    for c in moves:
        g.board[g.hgt[c], c] = 1 + (len(g.moves) & 1)
        g.hgt[c] += 1
        g.pos, g.mask = play(g.pos, g.mask, c)
        g.moves.append(c)
    g.root = Node([c for c in range(W) if can_play(g.mask, c)])
    return g


def mcts_test():
    """Sign-discipline test: even with a RANDOM net, search must nail forced
    tactics. Catches value/backup sign bugs immediately."""
    p = init_params(np.random.default_rng(5), ch=8)
    # mate in one: after [3,4,3,4,3,4] the side to move wins at col 3
    g = _game_from_moves([3, 4, 3, 4, 3, 4], np.random.default_rng(1))
    run_sims([g], 200, lambda _: p, dirichlet=False)
    q3 = g.root.W[3] / max(1.0, g.root.N[3])
    print(f"mate-in-one: N={g.root.N.astype(int)} Q(col3)={q3:.3f}")
    assert q3 > 0.5, "MCTS SIGN BUG: winning move Q should be strongly positive"
    assert g.root.N[3] == g.root.N.max(), "MCTS should concentrate visits on the win"
    # block-or-lose: after [3,4,3,4,3] the side to move must block col 3
    g2 = _game_from_moves([3, 4, 3, 4, 3], np.random.default_rng(2))
    run_sims([g2], 400, lambda _: p, dirichlet=False)
    print(f"block-or-lose: N={g2.root.N.astype(int)}")
    assert g2.root.N[3] == g2.root.N.max(), "MCTS should find the forced block"
    print("mcts test OK")


# ---------------------------------------------------------------------------
# Head-to-head play (arena / gauntlet)
# ---------------------------------------------------------------------------

def mcts_move(p, board, hgt, moves, sims, rng, cpuct=CPUCT):
    """Fresh-tree MCTS for evaluation matches. Returns column."""
    g = Game(rng)
    g.board = board.copy()
    g.hgt = hgt.copy()
    g.moves = list(moves)
    pos, mask = 0, 0
    for i, c in enumerate(moves):
        pos, mask = play(pos, mask, c)
    g.pos, g.mask = pos, mask
    g.root = Node([c for c in range(W) if can_play(mask, c)])
    if sims <= 0:
        x = g.planes()[None]
        logits, _, _ = forward(p, x)
        lg = logits[0].copy()
        legal = g.root.legal
        best = max(legal, key=lambda c: lg[c])
        return best
    for _ in range(sims):
        if g.select_to_leaf():
            x = g.planes_after_path()[None]
            logits, value, _ = forward(p, x)
            g.expand_and_backup(logits[0], value[0])
    n = g.root.N
    mx = n.max()
    cand = [c for c in g.root.legal if n[c] == mx]
    return int(rng.choice(cand))


def play_match(move_fn_a, move_fn_b, n_games, seed=0):
    """A plays first in even games. Returns (score_a, results list)."""
    rng = np.random.default_rng(seed)
    score = 0.0
    for gi in range(n_games):
        fns = (move_fn_a, move_fn_b) if gi % 2 == 0 else (move_fn_b, move_fn_a)
        board = np.zeros((H, W), np.int8)
        hgt = np.zeros(W, np.int8)
        moves = []
        pos, mask = 0, 0
        winner = 0
        ply = 0
        while True:
            legal = [c for c in range(W) if can_play(mask, c)]
            if not legal:
                break
            c = fns[ply & 1](board, hgt, moves, rng)
            if c not in legal:
                c = int(rng.choice(legal))
            if is_winning_move(pos, mask, c):
                winner = 1 + (ply & 1)
            board[hgt[c], c] = 1 + (ply & 1)
            hgt[c] += 1
            pos, mask = play(pos, mask, c)
            moves.append(c)
            if winner:
                break
            ply += 1
        if winner == 0:
            score += 0.5
        else:
            a_was_first = (gi % 2 == 0)
            a_won = (winner == 1) == a_was_first
            score += 1.0 if a_won else 0.0
    return score


def fn_net(p, sims):
    def f(board, hgt, moves, rng):
        return mcts_move(p, board, hgt, moves, sims, rng)
    return f


def fn_random():
    def f(board, hgt, moves, rng):
        legal = [c for c in range(W) if hgt[c] < H]
        return int(rng.choice(legal))
    return f


def fn_greedy():
    """Win if possible, else block, else random."""
    def f(board, hgt, moves, rng):
        pos, mask = 0, 0
        for i, c in enumerate(moves):
            pos, mask = play(pos, mask, c)
        legal = [c for c in range(W) if can_play(mask, c)]
        for c in legal:
            if is_winning_move(pos, mask, c):
                return c
        opp = pos ^ mask
        for c in legal:
            if has_won(opp | winning_bit(mask, c)):
                return c
        return int(rng.choice(legal))
    return f


def fn_teacher(depth):
    t = Teacher(depth=depth)
    def f(board, hgt, moves, rng):
        pos, mask = 0, 0
        for i, c in enumerate(moves):
            pos, mask = play(pos, mask, c)
        best, _ = t.best_moves(pos, mask, len(moves))
        return int(rng.choice(best))
    return f


def gauntlet(ckpt, sims=200, games=200):
    p, meta = load_ckpt(ckpt)
    print(f"gauntlet for {ckpt} ({meta}) at {sims} sims, {games} games each")
    results = {}
    for si, (name, opp, n) in enumerate([
            ("random", fn_random(), games),
            ("greedy", fn_greedy(), games),
            ("teacher-d6", fn_teacher(6), max(60, games // 3)),
            ("teacher-d8", fn_teacher(8), 60)]):
        s = play_match(fn_net(p, sims), opp, n, seed=1000 + si)
        results[name] = s / n
        print(f"  vs {name}: {s:.1f}/{n} = {100*s/n:.1f}%", flush=True)
    return results


# ---------------------------------------------------------------------------
# Stage B driver
# ---------------------------------------------------------------------------

def stage_b(iters=8, games=1500, sims=96, par=512, start="stage_a.npz",
            buffer_cap=400_000, sample=200_000, lr=2e-4, seed=7):
    p, _ = load_ckpt(start)
    best = {k: v.copy() for k, v in p.items()}
    rng = np.random.default_rng(seed)
    buf_b, buf_s, buf_pi, buf_z = [], [], [], []
    for it in range(iters):
        t0 = time.time()
        print(f"=== Stage B iteration {it} — self-play {games} games "
              f"({sims} sims) ===", flush=True)
        data = self_play(best, games, sims=sims, par=par,
                         seed=int(rng.integers(1 << 30)))
        for b, s, pi, z in data:
            buf_b.append(b); buf_s.append(s); buf_pi.append(pi); buf_z.append(z)
        if len(buf_b) > buffer_cap:
            cut = len(buf_b) - buffer_cap
            buf_b, buf_s = buf_b[cut:], buf_s[cut:]
            buf_pi, buf_z = buf_pi[cut:], buf_z[cut:]
        print(f"buffer {len(buf_b)} positions ({time.time()-t0:.0f}s self-play)",
              flush=True)

        # train the candidate from the current best
        cand = {k: v.copy() for k, v in best.items()}
        opt = Adam(cand, lr=lr)
        n = len(buf_b)
        take = min(sample, n)
        idx_all = rng.permutation(n)[:take]
        bb = np.array([buf_b[i] for i in idx_all], dtype=np.int8)
        ss = np.array([buf_s[i] for i in idx_all], dtype=np.int8)
        pp2 = np.array([buf_pi[i] for i in idx_all], dtype=np.float32)
        zz = np.array([buf_z[i] for i in idx_all], dtype=np.float32)
        batch = 256
        for ep in range(2):
            order = rng.permutation(take)
            for i in range(0, take - batch + 1, batch):
                idx = order[i:i + batch]
                x = batch_planes(bb[idx], ss[idx])
                pi_t, z_t = pp2[idx].copy(), zz[idx]
                flip = rng.random(len(idx)) < 0.5
                x[flip] = x[flip][:, :, :, ::-1]
                pi_t[flip] = pi_t[flip][:, ::-1]
                loss, g, met = loss_and_grads(cand, x, pi_t, z_t)
                opt.step(cand, g)
            print(f"  train ep {ep} done loss {loss:.4f} acc {met['acc']:.3f}",
                  flush=True)

        # arena gate (batched: both nets still get large batched calls)
        n_arena = 300
        s = arena_batched(cand, best, n_arena, sims=100,
                          seed=int(rng.integers(1 << 30)))
        frac = s / n_arena
        print(f"  arena: candidate {100*frac:.1f}% vs best "
              f"({time.time()-t0:.0f}s total)", flush=True)
        if frac >= 0.55:
            best = cand
            print("  PROMOTED", flush=True)
        save_ckpt(best, "stage_b_best.npz", {"stage": "B", "iter": it,
                                             "arena": frac})
        save_ckpt(cand, f"stage_b_iter{it}.npz", {"stage": "B", "iter": it,
                                                  "arena": frac})
    print("stage B complete -> stage_b_best.npz")


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def quantize(w):
    scale = float(np.max(np.abs(w))) / 127.0 if np.max(np.abs(w)) > 0 else 1.0
    q = np.clip(np.round(w / scale), -127, 127).astype(np.int8)
    return q, scale


def dequant_params(p):
    out = {}
    for k, v in p.items():
        if k.endswith("w"):
            q, s = quantize(v)
            out[k] = (q.astype(np.float32) * s).astype(np.float32)
        else:
            out[k] = v.astype(np.float32)
    return out


def export(ckpt, out_path=EXPORT_PATH, gauntlet_note=""):
    p, meta = load_ckpt(ckpt)
    ch = p["c1w"].shape[0]
    obj = {"ch": ch}
    for k, v in p.items():
        if k.endswith("w"):
            q, s = quantize(v)
            obj[k] = {"s": round(s, 10), "shape": list(v.shape),
                      "b64": base64.b64encode(q.tobytes()).decode("ascii")}
        else:
            obj[k] = [round(float(x), 6) for x in v.ravel()]

    # test vectors with the DEQUANTIZED weights (what the JS will reproduce)
    dq = dequant_params(p)
    tests = []
    for moves in ([], [3, 3, 2, 4, 2], [3, 4, 3, 4, 3]):
        b, _ = moves_to_board(moves)
        stm = 1 + (len(moves) & 1)
        x = planes_from_board(b, stm)[None]
        logits, value, _ = forward(dq, x)
        tests.append({"moves": moves,
                      "logits": [round(float(v), 6) for v in logits[0]],
                      "value": round(float(value[0]), 6)})
    obj["testVector"] = tests
    obj["meta"] = {"trained": meta, "note": gauntlet_note}

    body = json.dumps(obj, separators=(",", ":"))
    header = (
        "/* Generated by make_fourinarow_model.py - do not edit by hand.\n"
        "   Four in a Row policy/value net (conv 2->%d->%d->%d 3x3, policy 7 + value),\n"
        "   int8-quantized. Trained: %s. %s\n"
        "   testVector: logits+value for three positions, computed with the\n"
        "   DEQUANTIZED int8 weights; fourinarow-core.js must match within 1e-4. */\n"
        % (ch, ch, ch, json.dumps(meta), gauntlet_note)
    )
    # `self` works in both the page and a Web Worker (window.self / WorkerGlobalScope);
    # `window` would throw a ReferenceError inside the worker. Node tests shim globalThis.
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(header
                + "(typeof self !== 'undefined' ? self : globalThis).C4_MODEL = "
                + body + ";\n")
    print(f"exported -> {out_path} ({os.path.getsize(out_path)//1024} KB)")


# ---------------------------------------------------------------------------
# Smoke test: tiny end-to-end run of every stage
# ---------------------------------------------------------------------------

def smoke():
    print("smoke: gradcheck (tiny)")
    gradcheck()
    print("smoke: teacher basics")
    t = Teacher(depth=5)
    best, scores = t.best_moves(0, 0, 0)
    print(f"  empty-board best={best}")
    # a position with a forced win: [3,4,3,4,3] -> mover threatens col 3
    pos, mask = 0, 0
    for c in [3, 4, 3, 4]:
        pos, mask = play(pos, mask, c)
    assert is_winning_move(pos, mask, 3) is False  # only 3 in a row after this
    print("smoke: tiny data gen + train")
    gen_data(30, depth=5, out="smoke_data.npz")
    train_a(epochs=1, batch=64, data="smoke_data.npz", out="smoke_a.npz", ch=8)
    p, _ = load_ckpt("smoke_a.npz")
    print("smoke: tiny self-play")
    data = self_play(p, 8, sims=24, par=8, quiet=True)
    print(f"  {len(data)} positions")
    print("smoke: tiny arena")
    s = play_match(fn_net(p, 20), fn_random(), 10)
    print(f"  vs random {s}/10")
    print("smoke: export")
    export("smoke_a.npz", out_path=os.path.join(WORKDIR, "smoke-model.js"))
    print("SMOKE OK")


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gradcheck", action="store_true")
    ap.add_argument("--teacher-selftest", action="store_true")
    ap.add_argument("--gen-data", type=int, metavar="GAMES")
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--mcts-test", action="store_true")
    ap.add_argument("--depth", type=int, default=8)
    ap.add_argument("--train-a", action="store_true")
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--stage-b", action="store_true")
    ap.add_argument("--iters", type=int, default=8)
    ap.add_argument("--games", type=int, default=1500)
    ap.add_argument("--sims", type=int, default=96)
    ap.add_argument("--par", type=int, default=512)
    ap.add_argument("--start", default="stage_a.npz")
    ap.add_argument("--gauntlet", metavar="CKPT")
    ap.add_argument("--gauntlet-sims", type=int, default=200)
    ap.add_argument("--export", metavar="CKPT")
    ap.add_argument("--note", default="")
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()

    os.makedirs(WORKDIR, exist_ok=True)
    np.seterr(all="raise", under="ignore")

    if args.gradcheck:
        gradcheck()
    if args.teacher_selftest:
        teacher_selftest()
    if args.probe:
        probe(depth=args.depth)
    if args.mcts_test:
        mcts_test()
    if args.gen_data:
        gen_data(args.gen_data, depth=args.depth)
    if args.train_a:
        train_a(epochs=args.epochs)
    if args.stage_b:
        stage_b(iters=args.iters, games=args.games, sims=args.sims,
                par=args.par, start=args.start)
    if args.gauntlet:
        gauntlet(args.gauntlet, sims=args.gauntlet_sims)
    if args.export:
        export(args.export, gauntlet_note=args.note)
    if args.smoke:
        smoke()
    if len(sys.argv) == 1:
        ap.print_help()


if __name__ == "__main__":
    main()
