"""Train the tiny MNIST classifier behind /adversarial/ and export it to
assets/js/adversarial-model.js (weights int8-quantized + a set of demo digits).

    python make_adversarial_model.py

Architecture: 784 -> 64 (ReLU) -> 10, plain numpy SGD. Small on purpose — the
browser re-implements the forward pass AND the input gradient (for FGSM) in
~50 lines of JS, and the whole model ships in ~70 KB of base64.

MNIST is fetched from the CVDF mirror into the system temp dir (not the repo).
Requires numpy.
"""

import base64
import gzip
import json
import os
import struct
import tempfile
import urllib.request

import numpy as np

MIRROR = "https://storage.googleapis.com/cvdf-datasets/mnist/"
CACHE = os.path.join(tempfile.gettempdir(), "mnist")
OUT = os.path.join("assets", "js", "adversarial-model.js")

HIDDEN = 64
EPOCHS = 14
BATCH = 128
LR = 0.1  # decayed ×0.7 per epoch from epoch 8
N_DEMO = 60  # demo digits bundled with the page (6 per class)
RNG = np.random.default_rng(7)


def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print("downloading", name)
        urllib.request.urlretrieve(MIRROR + name, path)
    return path


def load_images(name):
    with gzip.open(fetch(name), "rb") as f:
        _, n, rows, cols = struct.unpack(">IIII", f.read(16))
        return np.frombuffer(f.read(), dtype=np.uint8).reshape(n, rows * cols)


def load_labels(name):
    with gzip.open(fetch(name), "rb") as f:
        struct.unpack(">II", f.read(8))
        return np.frombuffer(f.read(), dtype=np.uint8)


def forward(x, w1, b1, w2, b2):
    h = np.maximum(0, x @ w1 + b1)
    logits = h @ w2 + b2
    e = np.exp(logits - logits.max(axis=1, keepdims=True))
    return h, e / e.sum(axis=1, keepdims=True)


def input_grad(x, y, w1, b1, w2, b2):
    """d(cross-entropy)/dx — what FGSM needs."""
    h, p = forward(x, w1, b1, w2, b2)
    d = p.copy()
    d[np.arange(len(y)), y] -= 1
    dh = d @ w2.T
    dh[h <= 0] = 0
    return dh @ w1.T


ADV_TRAIN_EPS = 0.15  # FGSM strength used DURING adversarial training


def _grads(x, y, w1, b1, w2, b2):
    """Cross-entropy gradients for one (already-perturbed) batch."""
    h, p = forward(x, w1, b1, w2, b2)
    d = p.copy()
    d[np.arange(len(y)), y] -= 1
    d /= len(y)
    gw2 = h.T @ d
    gb2 = d.sum(axis=0)
    dh = d @ w2.T
    dh[h <= 0] = 0
    gw1 = x.T @ dh
    gb1 = dh.sum(axis=0)
    return gw1, gb1, gw2, gb2


def train(xtr, ytr, xte, yte, adv_eps=0.0, tag=""):
    """Train the MLP. If adv_eps>0, use Goodfellow-style adversarial training:
    each step averages the loss on the clean batch AND on an FGSM-perturbed copy
    (generated against the current weights). The 50/50 mix keeps clean accuracy
    high while making the model much harder to fool, which is the point of the demo."""
    w1 = (RNG.standard_normal((784, HIDDEN)) * np.sqrt(2 / 784)).astype(np.float32)
    b1 = np.zeros(HIDDEN, np.float32)
    w2 = (RNG.standard_normal((HIDDEN, 10)) * np.sqrt(2 / HIDDEN)).astype(np.float32)
    b2 = np.zeros(10, np.float32)

    n = len(xtr)
    for epoch in range(EPOCHS):
        lr = LR * (0.7 ** max(0, epoch - 7))
        order = RNG.permutation(n)
        for s in range(0, n, BATCH):
            idx = order[s:s + BATCH]
            x, y = xtr[idx], ytr[idx]
            gw1, gb1, gw2, gb2 = _grads(x, y, w1, b1, w2, b2)
            if adv_eps > 0:
                g = input_grad(x, y, w1, b1, w2, b2)
                xa = np.clip(x + adv_eps * np.sign(g), 0, 1).astype(np.float32)
                aw1, ab1, aw2, ab2 = _grads(xa, y, w1, b1, w2, b2)
                gw1 = 0.5 * gw1 + 0.5 * aw1; gb1 = 0.5 * gb1 + 0.5 * ab1
                gw2 = 0.5 * gw2 + 0.5 * aw2; gb2 = 0.5 * gb2 + 0.5 * ab2
            w1 -= lr * gw1; b1 -= lr * gb1
            w2 -= lr * gw2; b2 -= lr * gb2
        _, p = forward(xte, w1, b1, w2, b2)
        acc = (p.argmax(axis=1) == yte).mean()
        print(f"[{tag}] epoch {epoch + 1}: test acc {acc:.4f}")
    return w1, b1, w2, b2


def quantize(w):
    s = float(np.abs(w).max()) / 127.0
    q = np.clip(np.round(w / s), -127, 127).astype(np.int8)
    return q, s


def flip_rate(w1, b1, w2, b2, xte, yte, eps=0.15):
    _, p = forward(xte, w1, b1, w2, b2)
    pred = p.argmax(axis=1)
    g = input_grad(xte, yte, w1, b1, w2, b2)
    xadv = np.clip(xte + eps * np.sign(g), 0, 1)
    _, padv = forward(xadv, w1, b1, w2, b2)
    correct = pred == yte
    flipped = (padv.argmax(axis=1) != yte) & correct
    return correct.mean(), flipped.sum() / max(1, correct.sum())


def b64(arr):
    return base64.b64encode(arr.tobytes()).decode("ascii")


def jsf(arr):  # compact float list
    return json.dumps([round(float(v), 6) for v in arr])


def pack(w1, b1, w2, b2):
    """Quantize one model's weights and return the JS-serializable fields."""
    q1, s1 = quantize(w1)
    q2, s2 = quantize(w2)
    return {
        "s1": round(s1, 8), "s2": round(s2, 8),
        "w1": b64(q1), "w2": b64(q2), "b1": jsf(b1), "b2": jsf(b2),
    }


def main():
    xtr = load_images("train-images-idx3-ubyte.gz").astype(np.float32) / 255.0
    ytr = load_labels("train-labels-idx1-ubyte.gz")
    xte = load_images("t10k-images-idx3-ubyte.gz").astype(np.float32) / 255.0
    yte = load_labels("t10k-labels-idx1-ubyte.gz")

    std = train(xtr, ytr, xte, yte, adv_eps=0.0, tag="standard")
    rob = train(xtr, ytr, xte, yte, adv_eps=ADV_TRAIN_EPS, tag="robust")

    acc_s, flip_s = flip_rate(*std, xte, yte)
    acc_r, flip_r = flip_rate(*rob, xte, yte)
    print(f"standard: acc {acc_s:.3f}, FGSM flip {flip_s:.1%}")
    print(f"robust:   acc {acc_r:.3f}, FGSM flip {flip_r:.1%}")

    # demo digits chosen against the STANDARD model: confidently correct and flippable
    _, p = forward(xte, *std)
    pred = p.argmax(axis=1)
    g = input_grad(xte, yte, *std)
    xadv = np.clip(xte + 0.15 * np.sign(g), 0, 1)
    _, padv = forward(xadv, *std)
    flipped = padv.argmax(axis=1) != yte
    conf = p[np.arange(len(yte)), yte]
    picks = []
    for digit in range(10):
        cand = np.where((yte == digit) & (pred == yte) & (conf > 0.9) & flipped)[0]
        if len(cand) < N_DEMO // 10:
            cand = np.where((yte == digit) & (pred == yte) & (conf > 0.9))[0]
        picks.extend(cand[: N_DEMO // 10].tolist())
    picks = np.array(picks)
    imgs = (xte[picks] * 255).round().astype(np.uint8)

    ps = pack(*std)
    pr = pack(*rob)

    js = (
        "/* Generated by make_adversarial_model.py - do not edit by hand.\n"
        "   Two 784->64->10 MLPs trained on MNIST (int8-quantized): a STANDARD model\n"
        "   (acc {accs:.1%}, FGSM flip {flips:.0%}) and an ADVERSARIALLY-TRAINED model\n"
        "   (acc {accr:.1%}, FGSM flip {flipr:.0%}), plus {n} demo digits. adversarial.js\n"
        "   runs the forward pass and the FGSM input gradient against whichever is active. */\n"
        "window.ADV_MODEL = {{\n"
        "  hidden: {hidden},\n"
        "  standard: {{ s1: {ss1}, s2: {ss2}, w1: \"{sw1}\", w2: \"{sw2}\", b1: {sb1}, b2: {sb2} }},\n"
        "  robust:   {{ s1: {rs1}, s2: {rs2}, w1: \"{rw1}\", w2: \"{rw2}\", b1: {rb1}, b2: {rb2} }},\n"
        "  n: {n},\n"
        "  labels: {labels},\n"
        "  images: \"{images}\"\n"
        "}};\n"
    ).format(
        hidden=HIDDEN, accs=acc_s, flips=flip_s, accr=acc_r, flipr=flip_r,
        ss1=ps["s1"], ss2=ps["s2"], sw1=ps["w1"], sw2=ps["w2"], sb1=ps["b1"], sb2=ps["b2"],
        rs1=pr["s1"], rs2=pr["s2"], rw1=pr["w1"], rw2=pr["w2"], rb1=pr["b1"], rb2=pr["b2"],
        n=len(picks), labels=json.dumps(yte[picks].tolist()), images=b64(imgs),
    )
    with open(OUT, "w") as f:
        f.write(js)
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
