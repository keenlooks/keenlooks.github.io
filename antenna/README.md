# The Observatory antenna

A small Cloudflare Worker that stands between `keanelucas.com/observatory/` and the four
upstream sources a browser cannot reach directly, because they send no CORS headers:
adsb.lol, adsb.fi, `tfr.faa.gov`, and the FAA NOTAM API.

The Worker runs a ten minute cron (the TFRs and the NOTAM sweep), starts the aircraft collector,
which gathers the aircraft off Cloudflare, from the page's own `/planes` request (every half hour
while someone is watching and on demand when a visit begins after a quiet spell; see "The
collector"), aggregates, and serves small CORS open JSON snapshots. The page works without it: with no antenna deployed, the plane, jamming and TFR
layers report themselves offline and everything else on the page still runs.

Files here: `worker.js` (all the logic), `wrangler.toml` (deploy config), `collect.mjs` (the
aircraft collector that runs outside Cloudflare, see "The collector"), `dev-server.mjs` (a local
preview), this README.
Nothing in this directory is part of the Jekyll site; `antenna` is in the `_config.yml`
exclude list.

## Routes

| Route | Serves | Edge cache | Source |
|---|---|---|---|
| `GET /planes` | KV `snap:planes`, the aircraft sample, plus `refresh` while a requested sample is on its way (that answer `no-store`) | `s-maxage=90` | adsb.lol tiles, adsb.fi per-tile fallback, gathered by the collector (`collect.mjs` on GitHub Actions) every half hour while watched and on demand; the Worker's own cron is the fallback. Each request is a visit and may start the collector (see "On demand") |
| `GET /jam` | KV `agg:jam`, summarized to one row per bin: the newest sample and the last 24 hours, plus `refresh` as on `/planes` (that answer `no-store`) | `s-maxage=120` | derived from the same tiles, rolled by whichever wrote `/planes` |
| `GET /tfrs` | KV `tfrs`, the list plus geometry, with `t` (when it last changed) and `checked` (the last cron that fetched it; the served `ageMs` and `stale` count from it) | `s-maxage=600` | `tfr.faa.gov` list plus per-TFR detail |
| `GET /notams/gps` | KV `notams:gps` | `s-maxage=900` | FAA NOTAM API, needs secrets |
| `GET /health` | computed | `no-store` | per route KV ages (the `/tfrs` entry also `checked`, its age counted from it), tile coverage, the last collector dispatch `{t, status, why}` once there is one (`why` is `visit`; `cron` only in a record from before the fourth pass), and the last visit `{t}` |

The "Edge cache" column is the `Cache-Control` each answer declares. Cloudflare's edge cache and
Cache API do not apply to a `*.workers.dev` Worker (two GETs of `/tfrs` on 2026-10-29 came back with
no `cf-cache-status`), so the Worker keeps its own copy instead; see "Politeness" below.

Every response carries `Access-Control-Allow-Origin: *` (public data, no credentials), and
`OPTIONS` is answered with 204. Nothing here ever returns a 500: if an upstream or KV read
fails, the route serves the last stored value with `stale: true` and an `ageMs`, or answers
503 with `offline: true` and a reason in plain words when there is nothing stored at all.
`/planes` and `/jam` call their value stale at 45 minutes (the half hour, the collector's queue and
its round; `ROUTES` in `worker.js`, the same window as the page's two feeds; it was 75 at the hourly
cadence), `/tfrs` at 6 hours (from its last check, `checked`) and `/notams/gps` at 24 hours. After a quiet spell the stored snapshot
is older than that, and is served as stale until the sample the visit asked for lands.

Two extras on `/planes` that the page uses to stay polite:

- `?since=<t>` where `t` is the `t` of the copy the client already holds. The snapshot changes
  at most every half hour (once per cron only while the Worker's fallback writes it), so a matching
  `since` returns `{ ok, t, unchanged: true }` (plus `refresh` when there is one) instead of the
  whole tile set.
- `?min_alt=<feet>` trims the rows to the altitudes an instrument actually uses (the winds
  instrument only looks above 27,000 ft).

## Politeness (2026-10-29, site audit item 77)

Every route was open to any client at any rate, and nothing was cached, so a request loop could
spend the free plan's 100,000 KV reads a day, which the chat Worker shares (`/planes` reads up to 3
keys a request, `/health` 7). Two guards, both only in the Workers fetch handler (the node dev
server, the collector and every harness that builds its own deps behave exactly as before):

- **The isolate's answer cache** (`ANSWER_CACHE` in `worker.js`). Each cacheable 200 answer (its
  `Cache-Control` is public: never `/health`, a 503, or an answer carrying `refresh`) is kept for the
  route's `s-maxage`, keyed by the path alone, or for `/planes` the path plus `min_alt`, so a junk
  parameter cannot bust it. An entry is the answer's JSON text without its trailing `ageMs` (and
  `stale`), plus the snapshot's `t`. A hit reads no KV, carries `X-Antenna-Cache: hit`, and appends
  `ageMs` as the kept age plus the time since (with `stale` recomputed), so the age the page reads
  stays true. On `/planes`, `since` is answered from the entry exactly as the handler would: equal to
  its `t` gives the few-byte `unchanged` answer, newer than its `t` (a copy another isolate read) goes
  to KV, anything else gets the kept full answer. `since` is never part of the key: the first version
  keyed on it, so 64 junk values held 64 full snapshots (about 2 MB of heap each, against the 128 MB
  isolate limit). The cache holds at most 64 keys and 3,000,000 characters of kept text in all
  (`ANSWER_CACHE_MAX`, `ANSWER_CACHE_MAX_BYTES`). When it is full a new answer is simply not kept
  (evicting for it would let junk `min_alt` values churn kept snapshots into garbage that waits for
  a full collection); entries leave when they expire, and at worst the routes read KV as before. A
  `/planes` poll carrying `loading=1` never reads or fills it. As with the `s-maxage` these routes
  always declared, a `/planes` hit records no visit and starts no dispatch; the next request that
  misses does, so a due dispatch can wait up to 90 s while others poll, and up to a lone visitor's
  next poll (180 s apart). Best effort: each isolate keeps its own copy.
- **A per address limit**: the Workers Rate Limiting binding `ANTENNA_LIMIT` in `wrangler.toml`
  (`[[ratelimits]]`, 60 requests a minute per `CF-Connecting-IP`, counted per Cloudflare location;
  `RATE_LIMIT_PER_MIN` in `worker.js` must match), checked on every cache miss. Over it the answer
  is `429` with `Retry-After: 60` (exposed through `Access-Control-Expose-Headers`, which the page's
  fetcher reads, obs-core.js) and `{ok: false, offline: true, rateLimited: true}`. A page polls a few
  times a minute at most. No binding (a wrangler older than 4.36.0, which does not know the table),
  no address, or a limiter error: the request goes through.

## Deploying

The normal path is automatic: `.github/workflows/deploy-antenna.yml` deploys this Worker
from GitHub Actions whenever a push to master touches `antenna/`, using the same
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repository secrets the chatbot worker
deploy already uses. It creates the `OBS_KV` namespace through the Cloudflare API if it
does not exist, substitutes the id into `wrangler.toml` at deploy time (the repo copy keeps
its placeholder), pushes the FAA secrets and `GH_DISPATCH_TOKEN` when the repo has them (see
"The collector"), and smokes `/health` at
`https://obs-antenna.keenlooks-cloudflare.workers.dev`. If the token lacks the
"Workers KV Storage: Edit" permission the run fails with a message saying so; add that
permission to the token in the Cloudflare dashboard and re-run the workflow.

The first cron fills `/planes` and `/jam` within about ten minutes of the first deploy;
until then those routes answer 503 offline and the page says so honestly.

## The collector

adsb.lol answers 429 and adsb.fi answers 403 to the addresses Cloudflare Workers call out from
(diagnosed 2026-10-11), so the Worker's own cron reached 0 or 1 of its then 24 tiles. From outside
Cloudflare both answer. `collect.mjs` gathers the tiles there and writes them into this Worker's
KV, where the Worker serves them exactly as before.

- **What it runs.** `collect.mjs` (node 20 or newer, no dependencies) imports `runAircraftPhase`
  from `worker.js`, the same function the cron runs: the tiles of `TILES` (21 since the hourly
  trim, below) with the same spacing and the same refusal breaker, the `snap:planes` write, then the `agg:jam` roll. Its snapshot therefore
  has the Worker's shape by construction, plus one field ahead of `tiles`: `writer`
  (`github-actions` from the workflow, `collect.mjs` from a hand run). It writes through the
  Cloudflare KV REST API with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the deploy's
  repository secrets) into the namespace titled `OBS_KV`, or the one named by `OBS_KV_ID` when that
  is set. Off Cloudflare there is no 50 call cap, so every tile may try both sources
  (`COLLECTOR_BUDGET`, two calls a tile plus two: 44 for the 21 tiles). A runner is one address, and adsb.lol refuses one address from about the fourth call at
  the Worker's 250 ms spacing, so the collector alone spaces adsb.lol calls 1,000 ms apart
  (`COLLECTOR_SPACING_MS`, carried on its round's budget); the Worker keeps its own spacing. The
  TFRs and the NOTAM sweep stay the Worker's.
- **When it runs.** `.github/workflows/collect-antenna.yml`, started by the Worker from a page's
  `/planes` request (the next two bullets: every half hour while someone is watching, and once when a
  visit begins after a quiet spell), by hand, and once by a push that changes the collector. It has no
  schedule trigger: GitHub's cron for it never fired in the five hours after the push, and one that
  started firing would double every run against the Worker's dispatch. GitHub queues a dispatched
  run for a while before a runner starts it; the snapshot's own `t`, the age `/planes` serves and the
  page's stale label show that honestly.
- **Who starts it (2026-10-11; hourly that day; every half hour and on demand since 2026-10-12, see
  "On demand" below for what changed and the numbers that are current).** The Worker: it is the
  collector's one scheduler (Keane, 2026-10-11: "Let's make the pull be every 60 mins to be super
  nice"; 2026-10-12: "Let's change the update frequency to every 30 mins then, but yes also make it
  on demand"). Keane's repository secret `GH_DISPATCH_TOKEN` is a
  fine-grained GitHub token limited to this repository with Actions: Read and write (beside the
  read-only Metadata access every fine-grained token carries) and no Contents permission, so the
  Worker uses the workflow's own `workflow_dispatch` endpoint, which that permission covers (GitHub
  refuses a repository dispatch without Contents: Read and write). What the token can do if it ever
  leaks: start, re-run, cancel and disable this repository's workflows (`collect-antenna.yml`,
  `deploy-antenna.yml` and `update-claude-context.yml` carry a `workflow_dispatch` trigger, each
  runs on a ref that already exists) and delete their runs and logs; it cannot change a file or
  push. Rotate it if the Worker is ever compromised. `deploy-antenna.yml` pushes it to the Worker
  with `wrangler secret put` when the repository has it, from its own step's environment, never
  echoed. Until the fourth pass (2026-10-12) each cron also sent it, last, on a call the other
  stages left; since then only a `/planes` request does (see "On demand"). The Worker sends ONE `POST
  https://api.github.com/repos/keenlooks/keenlooks.github.io/actions/workflows/collect-antenna.yml/dispatches`
  with `{"ref":"master"}` (`GH_REPO`, `GH_WORKFLOW` and `GH_REF` in `worker.js`; GitHub answers 204),
  never following a redirect, when the stored snapshot is absent, its own, or a collector's 25
  minutes old or more (`DISPATCH_STALE_MS`), KV `dispatch:last` is absent or 25 minutes old or
  more (`DISPATCH_GAP_MS`). The hourly pass had both at 50 minutes and sent from the cron:
  its 24 hour simulation (`_tests/observatory/antenna-hourly-2026-10-11/`) gave 24 runs a day, the
  snapshot never more than 60.4 minutes old. A refused run writes nothing and the next dispatch
  goes 25 minutes after it. It records `dispatch:last` `{t, status, why}` whatever GitHub answers
  (a redirect is recorded with its 3xx status), so a broken token costs one call per 25 minutes of
  watching and no more, and logs one line: `dispatch: sent, status 204 (on a visit)` or
  `dispatch: sent, status 401, body <the first 120 characters> (on a visit)` (the cron's own
  `dispatch: ...` line went with its stage); `/health` shows `dispatch: {t, status, why}`. The token
  goes to `api.github.com` and nowhere else, and never into a log, a KV value or `/health`. Without
  the secret the Worker makes no call and reads and writes nothing for it; everything else it does is
  byte-for-byte what it did before. Hand dispatches add runs on
  top of the Worker's (two more KV writes each), so they stop once this trigger is live.
- **On demand (2026-10-12).** Keane: "Let's change the update frequency to every 30 mins then, but
  yes also make it on demand, and also change the page to tell the user for those layers that they
  are loading ... My website gets only about 20 visitors a day, and most won't click on the
  observatory". With `GH_DISPATCH_TOKEN` set (without it none of this reads or writes anything, and
  every answer is byte-for-byte what it was):
  1. *Visits.* A `/planes` request (the page polls it every three minutes while it is open) records
     KV `visit:last {t}`, written only when the stored one is absent or 10 minutes old
     (`VISIT_WRITE_GAP_MS`; 5 before the third pass) and (fourth pass) no requested sample is in
     flight, so a watching tab costs one KV write about every twelve minutes, and at most 144 a day
     from one Cloudflare location; the page's 30 s polls while a sample loads only read. `/health`
     shows `visit {t}`.
  2. *The request starts the collector.* When the stored snapshot is absent or 25 minutes old (the
     cron's own rule) and `dispatch:last` is absent or 25 minutes old, the request sends the same ONE
     `workflow_dispatch`, from the request path, WITHOUT delaying its answer: the call and its
     `dispatch:last {t, status, why: 'visit'}` write run in the background (`ctx.waitUntil`; in the node
     dev server a promise with a catch). It logs `dispatch: sent, status 204 (on a visit)`, the token
     redacted as everywhere. Its own answer says the sample is coming only when the previous
     `dispatch:last` is absent or was answered 204 (third pass): after a refused or unanswered one the
     page is never told "loading" for a sample nobody is fetching (the review's probe P2: a token GitHub
     refuses with 401, asked at 0, 27 and 54 minutes, now says loading at the very first poll only).
  3. *`refresh`.* While a dispatch is in flight (`dispatch:last` younger than 4 minutes,
     `REFRESH_INFLIGHT_MS`, answered 204, and no stored snapshot newer than it) the `/planes` and
     `/jam` answers (the full one, the short `since` one and a 503) carry
     `refresh: {requestedAt, snapshotT}`, so the page can say the layers are loading. A refused or
     unanswered dispatch is not in flight. The answer of the request that sent it already carries it.
     Fourth pass (Fable's ruling on the live test, which read "loading" for a full 180 s poll although
     the sample was in KV about 35 s after the dispatch): such an answer is served `no-store`, and the
     page polls `/planes` and `/jam` every 30 s while it carries `refresh` (obs-feeds.js
     `loadingPollMs` through obs-core.js `pollSoonerMs`; the two feeds pull each other's next poll
     forward, `pollPeers`, because on a cold page `/jam` is asked a few ms before the `/planes` request
     that starts the sample), until an answer comes without it or 4 minutes have passed since the
     request, then goes back to its 180 / 300 s grid (the 30 s polls are extra and move none of the
     others; fifth pass: a grid point closer than 30 s is skipped for the next one, so no poll comes
     less than 30 s after the previous one). Fifth pass (Fable's ruling on the review): those polls
     carry `?loading=1` (obs-core.js `soonerQuery`), and a `/planes` request that carries it never
     sends a dispatch and records no visit, whatever KV shows, while it still answers `refresh` when a
     dispatch is in flight. KV takes about 60 s to reach other Cloudflare locations, so a 30 s poll
     could read no `dispatch:last` with the snapshot still old and send a second one (the review's
     probe: 2 POSTs at 60 s of lag; 1 now). On `/jam` the parameter changes nothing. The page asks
     those `/planes` polls with `cache: 'no-store'` (every other `/planes` poll is due 180 s after the
     last, past the 45 s max-age, and is sent as before).
  4. *The cron sends nothing (fourth pass).* Until then its dispatch (`why: 'cron'`) went while
     `visit:last` was younger than 20 minutes (`VISIT_WATCH_MS`, second pass) and, from the third pass,
     not while it was under 13 (`VISIT_SELF_MS`). The live test (2026-10-12,
     `_tests/public-check-2026-10-12/ondemand/REPORT.txt`) found it never sent with a tab open (the
     tab refreshes itself from the request path), so its only sends were runs after a visitor had
     left, fetching for nobody (a third of the day's runs in the third pass's simulation). Fable's
     ruling removed the stage and both windows; `visit:last` stays for the fallback hold and `/health`.
     With the token set, the Worker's own aircraft round (the fallback) waits for a visit in the last
     25 minutes (`VISIT_RECENT_MS`) and for no dispatch in flight (`fallbackHold`; a collector
     snapshot older than 45 minutes is the normal state of a quiet night now, and without this hold
     the fallback would call the two volunteer feeds every ten minutes all night: 124 refused rounds,
     744 calls, a day in the simulation).
  5. *When KV writes fail (2026-10-20, site audit m31).* `dispatch:last` is a KV write, and the free
     plan caps writes at 1,000 a day for the account. Once the cap is hit that write fails, nothing
     recorded the dispatch, and every `/planes` poll sent another one. The Worker's fetch handler now
     keeps an in-memory `ISOLATE_MEMO` `{lastDispatchMs, kvWriteFailedAt}`: the time this isolate last
     decided to send, and the time a `visit:last` or `dispatch:last` write last failed. A request sends
     nothing for 25 minutes after either (`MEMO_HOLD_MS`, `memoHold`), and announces no `refresh`
     from memory (while the cap holds the collector cannot store a sample either). Best effort: each
     Cloudflare isolate keeps its own memory and loses it when recycled, so a capped day costs at
     most one dispatch per isolate per 25 minutes instead of one per poll; the hold lifts 25 minutes
     after the last failed write once writes work again. The memory also stops a second dispatch from
     the same isolate inside KV's one minute propagation lag. Only the fetch handler passes the memo
     (`deps.memo`), so the node dev server, the collector and every test harness that builds its own
     deps behave exactly as before. Test: `_tests/site-fixes-2026-10-20/B9-antenna/tests/t-m31.mjs`
     (capped all hour: 1 dispatch in 21 polls, was 21; cap lifting at 30 minutes: dispatches at 0, 54,
     81 and 108 minutes; healthy KV: 0, 27, 54, 81, 108, as before).
  The simulation (`_tests/observatory/antenna-ondemand-2026-10-12/`, fourth pass, 24 hours, two
  one-hour visits, 120 phase and delay combinations, the collector's delay 10 s as measured live to
  240 s): 4 runs a day in 60 combinations (delays 121 and 240 s) and 6 in 60 (10 and 45 s: a third
  run inside each visit, at minute 54 to 56, while the visitor is still there); no run outside a visit
  and none whose sample lands after the visitor has left; the first poll of every visit starts the run
  whose sample is the first new one the page sees, 1 to 8 minutes in; while the visitor stays the
  stored snapshot is at most 30.0 minutes old at a poll and 30.4 when replaced. The page says
  "loading" for 60 to 360 s per run (median 90 s; with the 180 s polls 180 to 360, median 180) and
  reads a stored sample 4 to 95 s after it lands (median 25 s; was 34 to 145, median 110). In 9 of
  the 120 combinations (all at 240 s, a sample landing after the 4 minute window) the fallback round
  runs once after each visit, its 12 calls a day refused, and `visit:last` takes 12 writes a day
  where 10 are usual. KV is eventually consistent (about a minute), so two dispatches from two
  Cloudflare locations inside that minute are possible (the workflow's concurrency group then runs
  the second after the first).
- **The deferral rule.** Each cron first reads the head of the stored snapshot (the fields before
  `tiles`, without parsing the tile array: `snapHead`, a few microseconds where a full parse of a
  250 to 750 KB snapshot costs 0.5 to 2 ms of a cron's 10 ms). When it names a writer and is younger
  than 45 minutes (`COLLECTOR_FRESH_MS`, the half hour plus the queue and the round, 75 at the hourly
  cadence; a `t` more than 5 minutes in the future is a skewed
  clock and counts as absent, and ages are clamped at 0), the cron makes no tile call and no snapshot or jam
  write, logs `deferred to the collector, age N s` in its log line, and its whole call budget goes
  to the TFRs. When the stored snapshot is older, absent, or the Worker's own (the Worker never
  names a writer), the cron runs its own round as before: that is the fallback (with the token set,
  only while someone visited in the last 25 minutes and no dispatch is in flight; see "On demand"). The fallback
  never replaces a collector snapshot with a DARK round (fewer than a quarter of the tiles, 6 of the 21), whatever that
  snapshot's age: `/planes` serves the age honestly, and a dark overwrite would only erase good
  data. Whoever writes, a stored snapshot with a newer `t` is never overwritten, the Worker also leaves alone a fresh
  collector snapshot that landed during its own round, and a round that leaves the snapshot alone
  leaves the jam ring alone too. KV is eventually consistent (about a minute), which a half hour
  cadence absorbs.
- **When the runner is refused too.** A collection that reaches fewer than a quarter of the tiles
  (under 6 of the 21) writes nothing and exits 0 with one `::warning::` line naming the tile count
  and the statuses seen (a refusal is the upstream's choice, not a fault; red runs would mean a
  failure and an email every hour). Once the last collector snapshot is 45 minutes old the Worker's
  own round runs again (with the token, while someone is watching). Exit 2, a red run, is kept for real faults (missing secrets, a namespace the
  token cannot list, a KV read or write that failed) and says what was and was not written. A
  key whose read failed in the run, including a 200 whose body never arrived, is never written,
  so the jam ring is never rebuilt from nothing.
- **The tile list (hourly pass, 2026-10-11).** Keane: "Yes remove tiles that aren't important if
  that saves a lot of data being pulled." Three of the 24 tiles were dropped by measurement: in
  every sample taken (three dev antenna rounds, the public snapshot, two collector dry runs for the
  share, one fetch of the Highveld tile) each was under 2 percent of the aircraft, fed no GPS cell
  with 5 or more aircraft reporting `nac_p` and fewer than 3 winds cells: Lapland and the Gulf of
  Bothnia (1 to 19 aircraft), Mesopotamia (0) and northern Andes (0 or 1). The Highveld tile was a
  candidate until its 07:13 local sample fed a GPS cell, so it stays; the page's copy names none of
  the regions only the three reached. Their answers weighed 7,036, 101 and 786 bytes at 05:20Z, so
  the trim saves 3 requests a round (72 a day) and about 0.2 MB a day; the hourly cadence is the
  saving. The table and every number: `_tests/observatory/antenna-hourly-2026-10-11/README.md`.
  `TILES` is the one list (the collector and the Worker's fallback both read it), the snapshot
  carries `tilesTotal`, and the page reads its counts from the snapshot. `assets/js/obs-feeds.js`
  `OM_SITES` follows `TILES` (t-feeds checks the two match).
- **Run it by hand.** `gh workflow run collect-antenna.yml --repo keenlooks/keenlooks.github.io --ref master`,
  then `gh run watch` (or `gh run list --workflow collect-antenna.yml --limit 1`). `/health`
  names the writer in its `tiles` summary once the edge serves the new snapshot.
- **Locally, writing nothing.** `node antenna/collect.mjs --dry` fetches the real tiles into an
  in-memory KV, prints one line per tile (a tile the fallback carried also says why the primary
  did not), then one `collect:` line with tilesOk, planes, calls, the writer and the jam roll
  summary. No token is needed and nothing reaches Cloudflare. `--kv-api
  http://127.0.0.1:<port>/client/v4` points the KV calls at a local stub for tests and accepts no
  other address.

## Local preview without wrangler

`wrangler dev` depends on the workerd binary, which crashes on some Windows machines.
`node antenna/dev-server.mjs` runs the same worker.js routes and cron in plain node with an
in-memory KV on 127.0.0.1:8788 (one cron at boot, then every ten minutes). Open the page as
`/observatory/?antenna=http://127.0.0.1:8788` to use it.

## Owner steps (manual fallback)

Prerequisites: node and a Cloudflare account. No install step: `npx` fetches wrangler.

1. Create the KV namespace and paste its id into `wrangler.toml`:

   ```
   cd antenna
   npx wrangler kv namespace create OBS_KV
   ```

   The command prints an id. Replace `PASTE_KV_NAMESPACE_ID_HERE` in `wrangler.toml` with it.

2. Deploy:

   ```
   npx wrangler deploy
   ```

   Wrangler prints the deployed URL, something like
   `https://obs-antenna.<your-subdomain>.workers.dev`.

3. Confirm the URL works and note the subdomain:

   ```
   curl https://obs-antenna.<your-subdomain>.workers.dev/health
   ```

   The first cron runs within ten minutes of deploy; before it does, `/planes` and `/jam`
   answer 503 with `offline: true`, which is expected.

4. If the printed subdomain is not `obs-antenna.keenlooks-cloudflare.workers.dev`, update the default in
   `assets/js/obs-core.js` (`ObsCore.setAntennaBase`) so the page points at the real one.

5. Optional, only once the FAA NOTAM API key exists
   (register at https://api.faa.gov/s/signup):

   ```
   npx wrangler secret put FAA_CLIENT_ID
   npx wrangler secret put FAA_CLIENT_SECRET
   ```

   Until those exist, `/notams/gps` answers 503 with `offline: true` and the jamming card on
   the page says that announced US test windows are not being subtracted yet.

### Local development

`wrangler dev` (checked with wrangler 4.151.3 and 4.156.0 on 2026-10-29) refuses to start on
`worker.js` itself: local workerd rejects its named `export const` values ("Incorrect type for map
entry 'ADSB_FI_BASE'"), although the deployed Worker runs them. Point `main` at a two-line entry that
re-exports only the default (`import W from './worker.js'; export default W;`) in a scratch copy,
or use the node dev server above.

```
cd antenna
npx wrangler dev --port 8788
```

That binds `127.0.0.1:8788` with a local KV namespace. The page accepts
`?antenna=http://127.0.0.1:8788` as a dev override. To fill local KV, trigger the cron once:

```
curl "http://127.0.0.1:8788/__scheduled?cron=*/10+*+*+*+*"
```

### Tests

The Worker's logic is written as functions that take an injected
`{ fetchFn, kv, nowMs, secrets, sleep }`, so the whole file runs in plain node with stubs and
no wrangler. The suite lives outside the repo, in the run directory:

```
node _tests/observatory/run1/tests/node/t-antenna.js
ANT_BREAK=1 node _tests/observatory/run1/tests/node/t-antenna.js   (proves the assertions bite: this run must fail)
node _tests/site-fixes-2026-10-20/B9-antenna/tests/t-m31.mjs   (the KV write cap: the fetch handler's dispatch memory)
node _tests/audit-fixes-2026-10-29/B15-antenna/tests/t-item77.mjs   (the answer cache and the per address limit)
```

## Upstream politeness, licensing and credit

Every upstream request sends
`User-Agent: keanelucas.com-observatory-antenna (keenlooks@gmail.com)` so the operators can
see who is calling and reach the owner. Tile fetches are serialized with at least 250 ms
between them, and any two adsb.fi calls in a cron (fallback or primary) start at least 1 second
apart, its documented rate (`SOURCE_MIN_SPACING_MS` in `worker.js`).

- **adsb.lol** is the primary aircraft source. Data is licensed **ODbL 1.0**, so the derived
  aggregate layers the page publishes are redistributable under the same license, and the
  page credits adsb.lol with a link. Their terms are free to use and ask that you contact
  them for production purposes. If the owner ever wants an API key, that is where to ask.
- **adsb.fi** is the per-tile fallback. Their terms are personal, non commercial use, one
  request per second, and **citation with a link is required**. The page credits adsb.fi with
  a link. The Worker calls their `v3` lat/lon/dist endpoint, which their README names as the
  one to use for new integrations; their `v2` route is deprecated but returns a different
  top-level key (`aircraft` and `resultCount` rather than `ac` and `total`), and the tile
  parser accepts either shape.
- **tfr.faa.gov** and the **FAA NOTAM API** are US federal government sources, not subject to
  copyright. The list endpoint is `tfrapi/exportTfrList`, and the per-TFR detail document is
  `https://tfr.faa.gov/download/detail_<notam id with the slash replaced by an underscore>.xml`,
  verified live on 2026-08-15 against notams 6/5250, 6/4583 and 6/5153.

Bandwidth since the on-demand pass (2026-10-12): the collector runs only while someone is watching
(every half hour) and once when a visit begins after a quiet spell, so the feeds are pulled 2 or 3
times per hour-long visit and not at all on a quiet day or after a visitor has left (fourth pass);
two one-hour visits a day is 4 to 6 runs, about 6 to 20 MB at the per-round sizes below, against 39
to 82 MB at once an hour.

Bandwidth note for the owner, measured on 2026-10-12 (`_tests/observatory/antenna-hourly-2026-10-11/`):
one collector round of the 21 tiles at 05:40Z, a quiet hour with 2,132 aircraft, pulled 1.61 MB of
JSON (gzip on the wire, so less over the network; a tile averaged 77 KB, the busiest 405 KB). At
the busiest round measured (4,519 aircraft, 2026-10-11 14:22Z) a round is about 3.4 MB. Once an
hour that is about 39 to 82 MB a day from a volunteer funded feed network, where a round every ten
minutes was about 230 to 490 MB. If adsb.lol or adsb.fi ever asks for less, the two knobs are the
collector's start (`DISPATCH_STALE_MS` and `DISPATCH_GAP_MS` in `worker.js`) and the tile list at
the top of `worker.js`; the cron interval in `wrangler.toml` paces only the TFRs, the NOTAM sweep
and the Worker's own fallback round (the cron starts no collector run since the fourth pass).

## What the cron does

Steps 1 to 3 are the aircraft phase (`runAircraftPhase`), which the collector runs every half hour
while someone is watching and on demand; the cron skips them while a collector snapshot is younger
than 45 minutes, and (with the token) while nobody has visited in 25 minutes or a dispatch is in
flight (see "The collector").

Every ten minutes (`wrangler.toml`):

1. Fetch the pinned 250 nm tiles (21 since the hourly pass; the snapshot's `tilesTotal` says how
   many), serialized, at least 250 ms apart. adsb.lol first,
   adsb.fi for any tile that fails. Each tile is wrapped in its own try/catch, so a failed
   tile is written with `ok: false` and a reason rather than taking the cron down.
   `alt_baro` is the string `"ground"` for about a tenth of the aircraft in a busy tile;
   those are counted separately and never enter a numeric field.
2. Write KV `snap:planes`: `{ t, distNm, tilesOk, tilesTotal, planes, tiles: [{ clat, clon,
   region, ok, src, planes: [[lat, lon, altFt, gsKt, trackDeg, tasKt, magHeadingDeg, nacP,
   nic, wd, ws], ...] }] }`. Latitude and longitude keep three decimals, everything else one.
3. Bin the same aircraft into 2 by 2 degree cells and roll the rings in KV `agg:jam`: six ten
   minute buckets for the last hour (`JAM_BUCKETS_1H` of `JAM_BUCKET_MS`), twenty four hourly
   buckets for the last day. Each bin holds `[n, nLow]`, where `n` counts aircraft that reported
   `nac_p` and `nLow` counts those reporting 6 or lower. Aircraft that do not report `nac_p` are
   in neither number, so the fraction stays meaningful. With the collector writing at most every
   half hour, each sample opens its own ten minute bucket, so the six buckets hold the last six samples. A
   repeated write inside one ten minute slot (a hand run beside a scheduled one) replaces that
   bucket, so a bucket is always one sample; the hourly bucket still sums its hour.
   `/jam`'s hour column (`n1h`, `nLow1h`) is the NEWEST sample only: the bucket within
   `JAM_LATEST_SPAN_MS` (one bucket) of the aggregate's own `t` (second pass, 2026-10-12). It used
   to sum every bucket of the last 70 minutes on the request clock, which at the hourly cadence
   emptied the column 70 minutes after a sample's cron while `/jam` still called it fresh (the
   page then said no cell had five aircraft), and for up to ten minutes after each new sample
   summed two samples an hour apart (cells 137, 212, 129 and clusters neither sample had). Ageing
   is left to the stale windows (45 minutes since 2026-10-12): an old aggregate serves its last sample marked stale.
   At either cadence `n` is the aircraft of one snapshot; at the ten minute cadence (the dev
   antenna, the Worker's fallback) the column used to sum six or seven. Measured on 2026-10-12,
   one snapshot gives 129 to 157 cells with 5 or more aircraft reporting `nac_p` (the page judges
   those), where the dev antenna's six-sample hour gave 303 to 306: the jamming layer judges about
   half as many cells, and its counts are distinct aircraft of one reading, dated exactly by that
   reading's own `t` ("in the latest reading, N min ago").
4. Fetch the TFR list. For new TFRs of type VIP, SECURITY, HAZARDS or SPACE, fetch the detail
   document (at most `MAX_TFR_DETAIL_PER_CRON`, eight, per cron) and parse the polygon and circle geometry out of it,
   caching the result under `tfrgeo:<notam id>`. Anything without geometry falls back to the
   state centroid with `approx: true`, which the page shows as an approximate location rather
   than a precise one. When the enriched payload is identical to the stored one (most crons) its
   `t` stays where it was (when the list last changed), and since the fourth pass (2026-10-12,
   Fable's ruling on the live test) the same value is rewritten with `checked` set to this cron's
   time, at most once per `TFR_CHECK_GAP_MS` (5 minutes, so once per cron); a changed list is written
   with `t` and `checked` both this cron's. Before this an unchanged list kept a `t` hours old, so the
   page called the airspace restriction feed stale 25 minutes after its last change and the Jamming
   chip showed "1 input stale: the airspace restriction feed" to every visitor while `/health` said
   fresh. A field and not a key of its own: either costs one write per cron, but a `tfrs:checked` key
   would take a second write on every cron whose list changed and a second KV read on every `/tfrs`
   and `/health` request. A cron whose list call fails writes nothing, so `checked` stays at the last
   real check.
5. Every six hours, if the FAA secrets are configured, sweep a slice of a pinned CONUS and
   Alaska grid for FDC NOTAMs, keep the ones whose text mentions GPS, GNSS or WAAS, and parse
   their `coordinates` and `radius` into circles. The FAA API has no free text search and caps
   `locationRadius` at 100 nm, so this sweep is coarser than its own footprint: coverage is
   partial by construction, and only US NOTAMs exist at all. The page says both.
6. (Until the fourth pass, 2026-10-12: with `GH_DISPATCH_TOKEN`, start the collector. Since then
   only a page's `/planes` request does; see "The collector".)

## Budgets

Cloudflare's free plan allows 1,000 KV writes a day and 50 subrequests per invocation. The
Worker counts its own subrequests (`MAX_SUBREQUESTS`, 44) and stops rather than blowing the
cap, and the cron caps detail fetches and sweep points per run.

| Key | Writes per day | Notes |
|---|---|---|
| `snap:planes` | 0 to about 6 | one per collector round, about 3 per hour-long visit and none on a quiet day (through the KV REST API, which counts here too); up to 144 only while the collector is down, someone is watching and the Worker's own fallback rounds reach 6 or more tiles |
| `agg:jam` | 0 to about 6 | rolled with each snapshot write, so the same count as `snap:planes` (up to 144 with the fallback, as above) |
| `tfrs` | about 144 | one per cron whose FAA list call answers (fourth pass: an unchanged list rewrites its `checked` time; before, roughly 10 to 60), never two in one cron |
| `tfrgeo:<id>` | roughly 10 to 30 | only new TFRs, plus a backfill of about 95 on the first day |
| `notams:gps` | 4 | one per six hour sweep |
| `dispatch:last` | 0 to about 6 | one per collector dispatch (a page's `/planes` request only, since the fourth pass), at most one per 25 minutes from one Cloudflare location (58 a day), only with `GH_DISPATCH_TOKEN` and a visit |
| `visit:last` | about 5 per hour watched | at most one per 10 minutes from one location (144 a day), none while a requested sample is in flight, only with `GH_DISPATCH_TOKEN` |
| **Typical total** | **roughly 180 to 210** | two one-hour visits a day (simulated, fourth pass): visit:last 10 to 12, dispatch:last, snap:planes and agg:jam 4 to 6 each, tfrs 144, tfrgeo 10 to 30, notams 4. Each extra collector run (a hand dispatch, a push) adds 2. The rise from the third pass's 46 to 122 is the TFR list's `checked` time (one write per cron) |
| **Worst case, one location** | **about 591** | a page open all day in one Cloudflare location: visit:last 144, dispatch:last, snap:planes and agg:jam 58 each, tfrs 144, a first-day tfrgeo backfill of about 125, notams 4. If the collector were down and Cloudflare's egress let the Worker's own fallback through, snap:planes and agg:jam could reach 144 each: about 763 |
| **The cap, honestly** | **1,000 a day** | the visit and dispatch caps are per Cloudflare location (KV takes about a minute to carry a write between them), so each further location with a page open all day adds up to 144 visit writes and its own dispatches: measured (the review's probe P8, fourth pass, `tfrs` at its 144) 5 such locations reach about 740 to 840 a day and 8 about 1,030 to 1,130, over the cap. Past it KV refuses writes until 00:00 UTC: the routes go on serving the last values, the collector's run fails red, and `dispatch:last` can no longer hold the 25 minute gap. Twenty visitors a day who mostly do not open the observatory are far from it |

Payload sizes, measured against the live fixtures (24 tiles, about 12,500 aircraft; the list is 21 tiles since 2026-10-11, and the live snapshots measured on 2026-10-11 and 12 were 114 to 254 KB):

| Route | Uncompressed | Notes |
|---|---|---|
| `/planes` | about 650 KB | roughly 250 KB over the wire once compressed. Use `?since=` between crons. |
| `/jam` | about 1 KB | one row per populated bin |
| `/tfrs` | about 40 KB | 116 TFRs with geometry |
| `/notams/gps` | a few KB | however many GPS NOTAMs are current |

## Known limits

- A tile is a 250 nm circle around a pinned center. Between the circles there is no coverage,
  and outside the volunteer receiver network there is no coverage either. An empty area means
  unknown, not clean, and the page says so on the jamming card.
- The jamming rings live entirely in KV. If the Worker is redeployed the rings survive, but
  if the namespace is recreated the last hour starts empty again.
- TFR detail times are passed through exactly as the FAA publishes them, with the document's
  own time zone field alongside. Nothing here converts or guesses a time zone.
- The GPS NOTAM sweep covers the United States only. Non US announced jamming is not
  subtracted anywhere on the page, and the jamming card's honesty line says exactly that.
