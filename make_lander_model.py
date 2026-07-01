"""Train the rocket-lander policy behind /lander/ and export it to
assets/js/lander-model.js (int8-quantized).

    python make_lander_model.py

The environment is an original, simplified 2D lander (own physics, NOT Box2D).
The task, four-action layout, and reward shaping are inspired by the classic
LunarLander environment from OpenAI Gym, now maintained by the Farama Foundation
as Gymnasium (https://gymnasium.farama.org/environments/box2d/lunar_lander/) —
the page credits them.

The policy is a 6->H->4 tanh MLP trained from scratch with the Cross-Entropy
Method (CEM): each generation samples a population of weight vectors, evaluates
each on a shared batch of randomized episodes (random gravity, wind, and pad
position — domain randomization, so the agent copes when the visitor changes
those at runtime), keeps the elite, and refits. The whole population is rolled
out in lockstep with vectorized numpy physics, so it trains in a couple of
minutes.

IMPORTANT: the physics, landing tolerances, and observation scaling here MUST
match assets/js/lander.js EXACTLY, or the policy won't behave the same in the
browser. Keep them in sync.

Requires numpy.
"""

import base64
import json
import numpy as np

RNG = np.random.default_rng(0)

# ---- environment constants (MUST match lander.js) ----
DT = 0.02
TM = 0.95          # strong thrust: the agent can abort, climb, and chase a pad that moves
TT = 4.5
GROUND_Y = 0.05
PAD_HALF = 0.03        # ~60% smaller landing zone than before (was 0.07)
MAXS = 500
# landing tolerances (MUST match lander.js)
TOL_X = 0.03
TOL_VX = 0.17
TOL_VY = 0.20
TOL_TH = 0.28
TOL_W = 0.85
# domain-randomization ranges. The pad range is slightly WIDER than the runtime
# slider (0.20–0.80) so the slider extremes are in-distribution and never "fly off".
G_LO, G_HI = 0.16, 0.36
WIND_LO, WIND_HI = -0.12, 0.12
PAD_LO, PAD_HI = 0.18, 0.82

H = 16             # hidden units (lander.js reads this from the model)
N_PARAMS = 6 * H + H + H * 4 + 4


def unpack(theta):
    i = 0
    W1 = theta[i:i + 6 * H].reshape(6, H); i += 6 * H
    b1 = theta[i:i + H]; i += H
    W2 = theta[i:i + H * 4].reshape(H, 4); i += H * 4
    b2 = theta[i:i + 4]
    return W1, b1, W2, b2


# ---------- vectorized rollout of a whole CEM population ----------
def rollout_population(pop, n_eps, rng):
    """pop: (P, N_PARAMS). Evaluate each individual on the SAME n_eps randomized
    episodes (common random numbers). Returns mean shaped return per individual
    (P,) and landing rate per individual (P,)."""
    P = pop.shape[0]
    B = P * n_eps                                  # total parallel rollouts

    # per-individual weights (P, ...)
    W1 = pop[:, 0:6 * H].reshape(P, 6, H)
    b1 = pop[:, 6 * H:6 * H + H].reshape(P, 1, H)
    o2 = 6 * H + H
    W2 = pop[:, o2:o2 + H * 4].reshape(P, H, 4)
    b2 = pop[:, o2 + H * 4:o2 + H * 4 + 4].reshape(P, 1, 4)

    # shared episode configs, tiled across the population dim -> (P, n_eps)
    g = np.tile(rng.uniform(G_LO, G_HI, n_eps), (P, 1))
    wind = np.tile(rng.uniform(WIND_LO, WIND_HI, n_eps), (P, 1))
    # WIDE initial states — including fast, tilted, spinning, off-centre starts — so the
    # agent learns to recover from a bad state (e.g. the visitor flinging the rocket).
    x = np.tile(0.5 + rng.uniform(-0.34, 0.34, n_eps), (P, 1))
    y = np.tile(rng.uniform(0.70, 0.95, n_eps), (P, 1))
    vx = np.tile(rng.uniform(-0.32, 0.32, n_eps), (P, 1))
    vy = np.tile(rng.uniform(-0.24, 0.08, n_eps), (P, 1))
    th = np.tile(rng.uniform(-0.45, 0.45, n_eps), (P, 1))
    w = np.tile(rng.uniform(-0.7, 0.7, n_eps), (P, 1))

    # The pad can jump to a new spot up to TWICE per episode (one early, one mid), then
    # stays put long enough to land, so the agent learns to abort and chase a target that
    # keeps moving. Since the policy is purely reactive to the pad offset, this generalizes
    # to the visitor dragging the pad around repeatedly at runtime.
    pad = rng.uniform(PAD_LO, PAD_HI, n_eps)
    j1_t = np.where(rng.random(n_eps) < 0.6, rng.integers(30, 110, n_eps), MAXS + 5)
    pad1 = rng.uniform(PAD_LO, PAD_HI, n_eps)
    j2_t = np.where(rng.random(n_eps) < 0.4, rng.integers(150, 270, n_eps), MAXS + 5)
    pad2 = rng.uniform(PAD_LO, PAD_HI, n_eps)

    active = np.ones((P, n_eps), bool)
    ret = np.zeros((P, n_eps))
    landed = np.zeros((P, n_eps), bool)

    def shaping(x, y, vx, vy, th, w, padX):
        return -(130 * np.hypot(x - padX, y - GROUND_Y) + 100 * np.hypot(vx, vy) + 80 * np.abs(th) + 15 * np.abs(w))

    prev_shape = shaping(x, y, vx, vy, th, w, pad[None, :])

    for t in range(MAXS):
        if not active.any():
            break
        # apply the scheduled pad jumps; rebase the shaping after each so the jump itself
        # gives no reward (the agent is only rewarded for then closing the new gap)
        for jt, pp in ((j1_t, pad1), (j2_t, pad2)):
            jump = t == jt
            if jump.any():
                pad = np.where(jump, pp, pad)
                prev_shape = shaping(x, y, vx, vy, th, w, pad[None, :])
        padX = pad[None, :]
        # observation (P, n_eps, 6)
        o = np.stack([(x - padX) * 1.6, (y - GROUND_Y) * 2.0, vx * 2.5, vy * 2.5, th * 1.2, w * 0.5], axis=-1)
        h = np.tanh(np.einsum('pei,pij->pej', o, W1) + b1)        # (P,n_eps,H)
        z = np.einsum('peh,phj->pej', h, W2) + b2                  # (P,n_eps,4)
        a = z.argmax(axis=-1)                                      # greedy (P,n_eps)

        main = (a == 2); left = (a == 1); right = (a == 3)
        ax = wind + np.where(main, TM * np.sin(th), 0.0)   # thrust pushes along the nose direction
        ay = -g + np.where(main, TM * np.cos(th), 0.0)
        nw = w + np.where(left, TT * DT, 0.0) - np.where(right, TT * DT, 0.0)
        nvx = vx + ax * DT; nvy = vy + ay * DT
        nx = x + nvx * DT; ny = y + nvy * DT; nth = th + nw * DT

        # only advance active rollouts
        x = np.where(active, nx, x); y = np.where(active, ny, y)
        vx = np.where(active, nvx, vx); vy = np.where(active, nvy, vy)
        th = np.where(active, nth, th); w = np.where(active, nw, w)

        # terminal checks
        oob = (x < 0) | (x > 1) | (y > 1.12)
        ground = y <= GROUND_Y
        ok = ground & (np.abs(x - padX) < TOL_X) & (np.abs(vx) < TOL_VX) & (np.abs(vy) < TOL_VY) & (np.abs(th) < TOL_TH) & (np.abs(w) < TOL_W)
        done_now = active & (oob | ground)

        sh = shaping(x, y, vx, vy, th, w, padX)
        r = (sh - prev_shape)
        r += np.where(main, -0.30, 0.0) + np.where(left | right, -0.03, 0.0)
        r += np.where(done_now & ok, 100.0, 0.0)
        r += np.where(done_now & ~ok, -100.0, 0.0)
        ret += np.where(active, r, 0.0)
        prev_shape = sh

        landed |= done_now & ok
        active = active & ~done_now
        y = np.clip(y, GROUND_Y, None)

    fitness = ret.mean(axis=1)
    land_rate = landed.mean(axis=1)
    return fitness, land_rate


def eval_rate(theta, N=2000, seed=123):
    """Greedy landing rate of a single individual on fresh random episodes."""
    f, lr = rollout_population(theta[None, :], N, np.random.default_rng(seed))
    return float(lr[0] * 100.0)


def export(theta, wr):
    W1, b1, W2, b2 = unpack(theta)
    def q(w):
        sc = float(np.abs(w).max()) / 127.0
        return np.clip(np.round(w / sc), -127, 127).astype(np.int8), round(sc, 8)
    def b64(a): return base64.b64encode(a.tobytes()).decode("ascii")
    def jsf(a): return json.dumps([round(float(v), 6) for v in a])
    q1, s1 = q(W1.astype(np.float32)); q2, s2 = q(W2.astype(np.float32))
    js = (
        "/* Generated by make_lander_model.py - do not edit by hand.\n"
        "   A 6->{h}->4 tanh policy (int8-quantized) for the /lander/ rocket demo, trained\n"
        "   from scratch with the Cross-Entropy Method under domain randomization.\n"
        "   Greedy landing rate ~{wr:.0f}%. Physics + obs scaling MUST match lander.js. */\n"
        "window.LANDER_MODEL = {{ hidden: {h}, s1: {s1}, s2: {s2},\n"
        "  w1: \"{w1}\", w2: \"{w2}\", b1: {b1}, b2: {b2} }};\n"
    ).format(wr=wr, h=H, s1=s1, s2=s2, w1=b64(q1), w2=b64(q2),
             b1=jsf(b1.astype(np.float32)), b2=jsf(b2.astype(np.float32)))
    with open("assets/js/lander-model.js", "w") as f:
        f.write(js)


def main():
    POP, ELITE, K, GENS = 180, 26, 12, 340
    mean = np.zeros(N_PARAMS)
    std = np.full(N_PARAMS, 0.8)
    best = None; best_rate = -1

    for gen in range(1, GENS + 1):
        pop = mean[None, :] + std[None, :] * RNG.standard_normal((POP, N_PARAMS))
        fit, lr = rollout_population(pop, K, RNG)
        idx = np.argsort(fit)[-ELITE:]
        elite = pop[idx]
        mean = elite.mean(axis=0)
        std = elite.std(axis=0) + 0.02                 # noise floor keeps exploring
        if gen % 10 == 0 or gen == 1:
            # evaluate the current mean greedily on a held-out set
            rate = eval_rate(mean, N=1500, seed=999)
            print(f"gen {gen:3d}: elite fit {fit[idx].mean():7.1f}  mean-policy landing {rate:5.1f}%", flush=True)
            if rate > best_rate:
                best_rate = rate; best = mean.copy(); export(best, best_rate)
                print(f"  -> new best {rate:.1f}% exported", flush=True)

    if best is None:
        best = mean; best_rate = eval_rate(mean, N=2000)
    final = eval_rate(best, N=4000, seed=7)
    print(f"FINAL greedy landing rate: {final:.1f}%", flush=True)
    export(best, final)
    print("wrote assets/js/lander-model.js", flush=True)


if __name__ == "__main__":
    main()
