"""Train the tiny char-level transformer behind the in-browser demo and export
it to assets/js/transformer-model.js (weights int8-quantized + base64).

    python make_transformer_model.py --gradcheck   # verify manual backprop vs finite differences
    python make_transformer_model.py --smoke       # 250-step sanity run (PASS if final loss < 3.0)
    python make_transformer_model.py --train       # full run (default 7000 steps; --steps N to override)

Architecture (~115k params): char-level, context T=96, d_model=64, 4 heads
(head dim 16), 2 pre-LN transformer blocks — x = x + MHA(LN1(x)); x = x +
MLP(LN2(x)) — with GELU (tanh approximation) and a 4x (256) MLP hidden, final
LN, untied 64x65 output head, learned positional embeddings, causal mask.
Trained with manual-backprop Adam on Tiny Shakespeare (downloaded to the
system temp dir, cached). Everything is plain numpy — the browser JS
re-implements the forward pass and asserts parity against the bundled
testVector (which is computed with the DEQUANTIZED int8 weights, so it
reflects exactly what ships).

Requires numpy.
"""

import argparse
import base64
import json
import math
import os
import tempfile
import time
import urllib.request

import numpy as np

DATA_URL = ("https://raw.githubusercontent.com/karpathy/char-rnn/"
            "master/data/tinyshakespeare/input.txt")
CACHE = os.path.join(tempfile.gettempdir(), "tinyshakespeare.txt")
OUT = os.path.join("assets", "js", "transformer-model.js")

# training hyperparameters
PEAK_LR = 3e-3
MIN_LR = 3e-4
WARMUP = 200
BATCH = 40
CLIP = 1.0          # global grad-norm clip
ADAM_B1, ADAM_B2, ADAM_EPS = 0.9, 0.99, 1e-8
LN_EPS = 1e-5
GELU_C = math.sqrt(2.0 / math.pi)
GELU_A = 0.044715


class Cfg:
    def __init__(self, V, T, d, nH, nL, dff, dtype):
        self.V, self.T, self.d, self.nH, self.nL, self.dff = V, T, d, nH, nL, dff
        self.dh = d // nH
        self.dtype = dtype


def full_cfg(V, dtype=np.float32):
    return Cfg(V, 96, 64, 4, 2, 256, dtype)


def param_names(cfg):
    """Canonical tensor order, also used for the export."""
    names = ["tok_emb", "pos_emb"]
    for l in range(cfg.nL):
        p = "blocks.%d." % l
        names += [p + "ln1.g", p + "ln1.b",
                  p + "attn.wqkv", p + "attn.bqkv", p + "attn.wo", p + "attn.bo",
                  p + "ln2.g", p + "ln2.b",
                  p + "mlp.w1", p + "mlp.b1", p + "mlp.w2", p + "mlp.b2"]
    names += ["lnf.g", "lnf.b", "head.w", "head.b"]
    return names


def init_params(cfg, rng):
    dt = cfg.dtype
    d, dff, V, T = cfg.d, cfg.dff, cfg.V, cfg.T

    def norm(*shape, std=0.02):
        return (rng.standard_normal(shape) * std).astype(dt)

    resid_std = 0.02 / math.sqrt(2 * cfg.nL)  # GPT-2-style downscale of residual-writing mats
    p = {"tok_emb": norm(V, d), "pos_emb": norm(T, d)}
    for l in range(cfg.nL):
        pre = "blocks.%d." % l
        p[pre + "ln1.g"] = np.ones(d, dt)
        p[pre + "ln1.b"] = np.zeros(d, dt)
        p[pre + "attn.wqkv"] = norm(d, 3 * d)
        p[pre + "attn.bqkv"] = np.zeros(3 * d, dt)
        p[pre + "attn.wo"] = norm(d, d, std=resid_std)
        p[pre + "attn.bo"] = np.zeros(d, dt)
        p[pre + "ln2.g"] = np.ones(d, dt)
        p[pre + "ln2.b"] = np.zeros(d, dt)
        p[pre + "mlp.w1"] = norm(d, dff)
        p[pre + "mlp.b1"] = np.zeros(dff, dt)
        p[pre + "mlp.w2"] = norm(dff, d, std=resid_std)
        p[pre + "mlp.b2"] = np.zeros(d, dt)
    p["lnf.g"] = np.ones(d, dt)
    p["lnf.b"] = np.zeros(d, dt)
    p["head.w"] = norm(d, V)
    p["head.b"] = np.zeros(V, dt)
    return p


# ---------------- forward / backward primitives ----------------

def gelu(x):
    u = GELU_C * (x + GELU_A * x ** 3)
    return 0.5 * x * (1.0 + np.tanh(u))


def dgelu(x):
    u = GELU_C * (x + GELU_A * x ** 3)
    t = np.tanh(u)
    return 0.5 * (1.0 + t) + 0.5 * x * (1.0 - t * t) * GELU_C * (1.0 + 3.0 * GELU_A * x * x)


def ln_fwd(x, g, b):
    mu = x.mean(-1, keepdims=True)
    xc = x - mu
    var = (xc * xc).mean(-1, keepdims=True)
    istd = 1.0 / np.sqrt(var + LN_EPS)
    xhat = xc * istd
    return g * xhat + b, (xhat, istd, g)


def ln_bwd(dy, cache):
    xhat, istd, g = cache
    red = tuple(range(dy.ndim - 1))
    dg = (dy * xhat).sum(axis=red)
    db = dy.sum(axis=red)
    dxh = dy * g
    dx = istd * (dxh - dxh.mean(-1, keepdims=True)
                 - xhat * (dxh * xhat).mean(-1, keepdims=True))
    return dx, dg, db


def run_forward(params, cfg, ids):
    """Forward pass. Returns (logits, cache-for-backward)."""
    B, T = ids.shape
    dt = cfg.dtype
    d, nH, dh = cfg.d, cfg.nH, cfg.dh
    scale = 1.0 / math.sqrt(dh)
    x = (params["tok_emb"][ids] + params["pos_emb"][:T]).astype(dt)
    mask = np.triu(np.full((T, T), -1e9, dtype=dt), k=1)
    blocks = []
    for l in range(cfg.nL):
        pre = "blocks.%d." % l
        x0 = x
        h1, c1 = ln_fwd(x0, params[pre + "ln1.g"], params[pre + "ln1.b"])
        qkv = h1 @ params[pre + "attn.wqkv"] + params[pre + "attn.bqkv"]
        q = qkv[..., 0 * d:1 * d].reshape(B, T, nH, dh).transpose(0, 2, 1, 3)
        k = qkv[..., 1 * d:2 * d].reshape(B, T, nH, dh).transpose(0, 2, 1, 3)
        v = qkv[..., 2 * d:3 * d].reshape(B, T, nH, dh).transpose(0, 2, 1, 3)
        s = (q @ k.swapaxes(-1, -2)) * scale + mask
        s -= s.max(-1, keepdims=True)
        p_att = np.exp(s)
        p_att /= p_att.sum(-1, keepdims=True)
        o = (p_att @ v).transpose(0, 2, 1, 3).reshape(B, T, d)
        attn = o @ params[pre + "attn.wo"] + params[pre + "attn.bo"]
        x1 = x0 + attn
        h2, c2 = ln_fwd(x1, params[pre + "ln2.g"], params[pre + "ln2.b"])
        a1 = h2 @ params[pre + "mlp.w1"] + params[pre + "mlp.b1"]
        g1 = gelu(a1)
        mlp = g1 @ params[pre + "mlp.w2"] + params[pre + "mlp.b2"]
        x = x1 + mlp
        blocks.append((h1, c1, q, k, v, p_att, o, h2, c2, a1, g1))
    xf, cf = ln_fwd(x, params["lnf.g"], params["lnf.b"])
    logits = xf @ params["head.w"] + params["head.b"]
    return logits, (ids, xf, cf, blocks)


def xent(logits, targets):
    """Mean next-char cross-entropy over all positions. Returns (loss, dlogits)."""
    B, T, V = logits.shape
    zmax = logits.max(-1, keepdims=True)
    ez = np.exp(logits - zmax)
    zsum = ez.sum(-1, keepdims=True)
    logz = (np.log(zsum) + zmax)[..., 0]
    tlog = np.take_along_axis(logits, targets[..., None], axis=-1)[..., 0]
    loss = float((logz - tlog).mean())
    dlogits = ez / zsum
    bi = np.arange(B)[:, None]
    ti = np.arange(T)[None, :]
    dlogits[bi, ti, targets] -= 1.0
    dlogits /= (B * T)
    return loss, dlogits


def xent_loss(logits, targets):
    zmax = logits.max(-1, keepdims=True)
    logz = (np.log(np.exp(logits - zmax).sum(-1, keepdims=True)) + zmax)[..., 0]
    tlog = np.take_along_axis(logits, targets[..., None], axis=-1)[..., 0]
    return float((logz - tlog).mean())


def backward(params, cfg, cache, dlogits):
    ids, xf, cf, blocks = cache
    B, T = ids.shape
    d, nH, dh = cfg.d, cfg.nH, cfg.dh
    scale = 1.0 / math.sqrt(dh)
    g = {}

    def mm_back(xin, w, dy):
        dw = xin.reshape(-1, xin.shape[-1]).T @ dy.reshape(-1, dy.shape[-1])
        db = dy.sum(axis=(0, 1))
        return dw, db, dy @ w.T

    g["head.w"], g["head.b"], dxf = mm_back(xf, params["head.w"], dlogits)
    dx, g["lnf.g"], g["lnf.b"] = ln_bwd(dxf, cf)

    for l in reversed(range(cfg.nL)):
        h1, c1, q, k, v, p_att, o, h2, c2, a1, g1 = blocks[l]
        pre = "blocks.%d." % l
        # MLP branch (residual: dx flows to both the branch and the skip)
        dw2, db2, dg1 = mm_back(g1, params[pre + "mlp.w2"], dx)
        da1 = dg1 * dgelu(a1)
        dw1, db1, dh2 = mm_back(h2, params[pre + "mlp.w1"], da1)
        dx1_ln, dg2g, dg2b = ln_bwd(dh2, c2)
        dx1 = dx + dx1_ln
        # attention branch
        dwo, dbo, do_flat = mm_back(o, params[pre + "attn.wo"], dx1)
        do = do_flat.reshape(B, T, nH, dh).transpose(0, 2, 1, 3)
        dp = do @ v.swapaxes(-1, -2)
        dv = p_att.swapaxes(-1, -2) @ do
        ds = p_att * (dp - (dp * p_att).sum(-1, keepdims=True))
        dq = (ds @ k) * scale
        dk = (ds.swapaxes(-1, -2) @ q) * scale
        dqkv = np.concatenate(
            [dq.transpose(0, 2, 1, 3).reshape(B, T, d),
             dk.transpose(0, 2, 1, 3).reshape(B, T, d),
             dv.transpose(0, 2, 1, 3).reshape(B, T, d)], axis=-1)
        dwqkv, dbqkv, dh1 = mm_back(h1, params[pre + "attn.wqkv"], dqkv)
        dx0_ln, dg1g, dg1b = ln_bwd(dh1, c1)
        dx = dx1 + dx0_ln

        g[pre + "mlp.w2"], g[pre + "mlp.b2"] = dw2, db2
        g[pre + "mlp.w1"], g[pre + "mlp.b1"] = dw1, db1
        g[pre + "ln2.g"], g[pre + "ln2.b"] = dg2g, dg2b
        g[pre + "attn.wo"], g[pre + "attn.bo"] = dwo, dbo
        g[pre + "attn.wqkv"], g[pre + "attn.bqkv"] = dwqkv, dbqkv
        g[pre + "ln1.g"], g[pre + "ln1.b"] = dg1g, dg1b

    dtok = np.zeros_like(params["tok_emb"])
    np.add.at(dtok, ids.reshape(-1), dx.reshape(-1, d))
    g["tok_emb"] = dtok
    dpos = np.zeros_like(params["pos_emb"])
    dpos[:T] = dx.sum(0)
    g["pos_emb"] = dpos
    return g


# ---------------- optimizer / schedule ----------------

class Adam:
    def __init__(self, params):
        self.m = {k: np.zeros_like(v) for k, v in params.items()}
        self.v = {k: np.zeros_like(v) for k, v in params.items()}
        self.t = 0

    def step(self, params, grads, lr):
        self.t += 1
        bc1 = 1.0 - ADAM_B1 ** self.t
        bc2 = 1.0 - ADAM_B2 ** self.t
        for k in params:
            gk = grads[k]
            self.m[k] = ADAM_B1 * self.m[k] + (1 - ADAM_B1) * gk
            self.v[k] = ADAM_B2 * self.v[k] + (1 - ADAM_B2) * gk * gk
            params[k] -= lr * (self.m[k] / bc1) / (np.sqrt(self.v[k] / bc2) + ADAM_EPS)


def clip_grads(grads):
    total = math.sqrt(sum(float((gv * gv).sum()) for gv in grads.values()))
    if total > CLIP:
        s = CLIP / (total + 1e-12)
        for k in grads:
            grads[k] *= s
    return total


def lr_at(step, total):
    """step is 0-based. Linear warmup to PEAK_LR then cosine decay to MIN_LR."""
    if step < WARMUP:
        return PEAK_LR * (step + 1) / WARMUP
    prog = (step - WARMUP) / max(1, total - WARMUP)
    return MIN_LR + 0.5 * (PEAK_LR - MIN_LR) * (1.0 + math.cos(math.pi * prog))


# ---------------- data ----------------

def load_text():
    if not os.path.exists(CACHE):
        print("downloading tinyshakespeare ->", CACHE, flush=True)
        urllib.request.urlretrieve(DATA_URL, CACHE)
    with open(CACHE, "r", encoding="utf-8") as f:
        return f.read()


def get_batch(data, bsz, T, rng):
    ix = rng.integers(0, len(data) - T - 1, bsz)
    idx = ix[:, None] + np.arange(T)[None, :]
    return data[idx], data[idx + 1]


def generate(params, cfg, vocab, prompt, n, temp, rng):
    stoi = {c: i for i, c in enumerate(vocab)}
    ids = [stoi[c] for c in prompt]
    out = []
    for _ in range(n):
        ctx = np.array([ids[-cfg.T:]], dtype=np.int64)
        logits, _ = run_forward(params, cfg, ctx)
        z = logits[0, -1].astype(np.float64) / temp
        z -= z.max()
        p = np.exp(z)
        p /= p.sum()
        nxt = int(rng.choice(cfg.V, p=p))
        ids.append(nxt)
        out.append(vocab[nxt])
    return "".join(out)


# ---------------- export ----------------

def export_model(params, cfg, vocab, train_steps, val_loss):
    weights = {}
    dq = {}
    for name in param_names(cfg):
        w = np.asarray(params[name], dtype=np.float32)
        s = float(np.abs(w).max()) / 127.0
        if s <= 0.0:
            s = 1e-8
        qw = np.clip(np.round(w / s), -127, 127).astype(np.int8)
        weights[name] = {"shape": list(w.shape), "scale": s,
                         "b64": base64.b64encode(qw.tobytes()).decode("ascii")}
        dq[name] = qw.astype(np.float32) * np.float32(s)

    cfg32 = Cfg(cfg.V, cfg.T, cfg.d, cfg.nH, cfg.nL, cfg.dff, np.float32)
    stoi = {c: i for i, c in enumerate(vocab)}
    prompt = "ROMEO: "
    missing = [c for c in prompt if c not in stoi]
    if missing:
        raise RuntimeError("test prompt chars missing from vocab: %r" % missing)
    pids = [stoi[c] for c in prompt]
    logits, _ = run_forward(dq, cfg32, np.array([pids], dtype=np.int64))
    test_vector = {"promptIds": pids,
                   "logits": [round(float(v), 5) for v in logits[0, -1]]}
    sample = generate(dq, cfg32, vocab, "\n", 200, 0.8, np.random.default_rng(42))
    param_count = int(sum(params[n].size for n in param_names(cfg)))

    obj = {
        "config": {"vocabSize": cfg.V, "T": cfg.T, "d": cfg.d, "nHeads": cfg.nH,
                   "nLayers": cfg.nL, "dff": cfg.dff, "paramCount": param_count,
                   "trainSteps": int(train_steps), "valLoss": round(float(val_loss), 4)},
        "vocab": vocab,
        "weights": weights,
        "testVector": test_vector,
        "sample": sample,
    }
    body = json.dumps(obj, separators=(",", ":"))
    header = (
        "/* Generated by make_transformer_model.py - do not edit by hand.\n"
        "   Tiny char-level transformer (context 96, width 64, 4 heads, 2 pre-LN blocks,\n"
        "   ~115k params) trained on Tiny Shakespeare, int8-quantized per tensor.\n"
        "   testVector holds the final-position logits for the prompt \"ROMEO: \", computed\n"
        "   with the DEQUANTIZED int8 weights (float32 forward), so the browser forward\n"
        "   pass can assert parity against exactly what ships here. */\n"
    )
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(header + "window.TRANSFORMER_MODEL = " + body + ";\n")
    print("wrote %s (%.0f KB)" % (OUT, os.path.getsize(OUT) / 1024), flush=True)


# ---------------- gradcheck ----------------

def gradcheck():
    src = "the quick brown fox jumps over the lazy dog?!\n" * 3
    vocab = "".join(sorted(set(src)))
    cfg = Cfg(len(vocab), 8, 16, 2, 1, 64, np.float64)
    rng = np.random.default_rng(0)
    params = init_params(cfg, rng)
    stoi = {c: i for i, c in enumerate(vocab)}
    data = np.array([stoi[c] for c in src], dtype=np.int64)
    ids, tg = get_batch(data, 2, cfg.T, rng)

    logits, cache = run_forward(params, cfg, ids)
    loss, dlogits = xent(logits, tg)
    grads = backward(params, cfg, cache, dlogits)
    print("gradcheck: tiny config vocab %d, loss %.6f" % (cfg.V, loss), flush=True)

    eps = 1e-5
    all_ok = True
    for name in param_names(cfg):
        flat = params[name].reshape(-1)
        ga = grads[name].reshape(-1)
        n = min(10, flat.size)
        idxs = rng.choice(flat.size, size=n, replace=False)
        max_rel = 0.0
        for i in idxs:
            old = flat[i]
            flat[i] = old + eps
            lp = xent_loss(run_forward(params, cfg, ids)[0], tg)
            flat[i] = old - eps
            lm = xent_loss(run_forward(params, cfg, ids)[0], tg)
            flat[i] = old
            num = (lp - lm) / (2 * eps)
            ana = float(ga[i])
            rel = abs(ana - num) / max(1e-8, abs(ana) + abs(num))
            max_rel = max(max_rel, rel)
        ok = max_rel < 1e-4
        all_ok &= ok
        print("  %-20s max rel err %.3e  %s" % (name, max_rel, "ok" if ok else "FAIL"),
              flush=True)
    print("GRADCHECK %s" % ("PASS" if all_ok else "FAIL"), flush=True)
    return all_ok


# ---------------- training ----------------

def eval_val(params, cfg, va, batches=8):
    r = np.random.default_rng(1234)
    tot = 0.0
    for _ in range(batches):
        ids, tg = get_batch(va, BATCH, cfg.T, r)
        tot += xent_loss(run_forward(params, cfg, ids)[0], tg)
    return tot / batches


def train_loop(steps, mode):
    text = load_text()
    vocab = "".join(sorted(set(text)))
    stoi = {c: i for i, c in enumerate(vocab)}
    data = np.array([stoi[c] for c in text], dtype=np.int64)
    n_tr = int(len(data) * 0.95)
    tr, va = data[:n_tr], data[n_tr:]

    cfg = full_cfg(len(vocab))
    rng = np.random.default_rng(1)
    params = init_params(cfg, rng)
    opt = Adam(params)
    n_params = sum(params[n].size for n in param_names(cfg))
    print("data %d chars (train %d / val %d), vocab %d, params %d"
          % (len(data), n_tr, len(va), cfg.V, n_params), flush=True)

    print_every = 25 if mode == "smoke" else 50
    t0 = time.time()
    last_loss = float("nan")
    for step in range(steps):
        lr = lr_at(step, steps)
        ids, tg = get_batch(tr, BATCH, cfg.T, rng)
        logits, cache = run_forward(params, cfg, ids)
        loss, dlogits = xent(logits, tg)
        if not np.isfinite(loss):
            print("ABORT: non-finite loss at step %d" % (step + 1), flush=True)
            return False
        grads = backward(params, cfg, cache, dlogits)
        clip_grads(grads)
        opt.step(params, grads, lr)
        last_loss = loss

        if (step + 1) % print_every == 0 or step == 0:
            print("step %5d/%d  loss %.4f  lr %.2e"
                  % (step + 1, steps, loss, lr), flush=True)
        if mode == "train":
            if (step + 1) % 500 == 0:
                vl = eval_val(params, cfg, va)
                print("  val loss %.4f" % vl, flush=True)
                samp = generate(params, cfg, vocab, "\n", 300, 0.8,
                                np.random.default_rng(step))
                print("---- sample @ step %d ----" % (step + 1), flush=True)
                print(samp, flush=True)
                print("---- end sample ----", flush=True)
            if (step + 1) % 250 == 0:
                vl = eval_val(params, cfg, va, batches=4)
                export_model(params, cfg, vocab, step + 1, vl)
                print("  checkpoint exported at step %d (val %.4f)"
                      % (step + 1, vl), flush=True)

    per_step = (time.time() - t0) / max(1, steps)
    print("avg %.0f ms/step (%.1f s per 100 steps)"
          % (per_step * 1000, per_step * 100), flush=True)

    if mode == "smoke":
        ok = last_loss < 3.0
        print("SMOKE %s (final loss %.4f, threshold 3.0)"
              % ("PASS" if ok else "FAIL", last_loss), flush=True)
        return ok

    vl = eval_val(params, cfg, va)
    print("final val loss %.4f" % vl, flush=True)
    export_model(params, cfg, vocab, steps, vl)
    return True


def main():
    ap = argparse.ArgumentParser(description="Tiny char-level transformer trainer/exporter")
    ap.add_argument("--gradcheck", action="store_true",
                    help="finite-difference check of the manual backprop (float64, tiny config)")
    ap.add_argument("--smoke", action="store_true", help="250-step sanity run at full config")
    ap.add_argument("--train", action="store_true", help="full training run + export")
    ap.add_argument("--steps", type=int, default=7000, help="training steps for --train")
    args = ap.parse_args()
    if args.gradcheck:
        raise SystemExit(0 if gradcheck() else 1)
    if args.smoke:
        raise SystemExit(0 if train_loop(250, "smoke") else 1)
    if args.train:
        raise SystemExit(0 if train_loop(args.steps, "train") else 1)
    ap.print_help()


if __name__ == "__main__":
    main()
