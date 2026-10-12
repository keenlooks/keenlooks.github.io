# The Observatory antenna

A small Cloudflare Worker that stands between `keanelucas.com/observatory/` and the four
upstream sources a browser cannot reach directly, because they send no CORS headers:
adsb.lol, adsb.fi, `tfr.faa.gov`, and the FAA NOTAM API.

The Worker runs a ten minute cron (the TFRs, the NOTAM sweep, and the start of the aircraft
collector, which gathers the aircraft off Cloudflare every half hour while someone is watching the
page and on demand when a visit begins after a quiet spell; see "The collector"),
aggregates, and serves small CORS open JSON snapshots. The page works without it: with no antenna deployed, the plane, jamming and TFR
layers report themselves offline and everything else on the page still runs.

Files here: `worker.js` (all the logic), `wrangler.toml` (deploy config), `collect.mjs` (the
aircraft collector that runs outside Cloudflare, see "The collector"), `dev-server.mjs` (a local
preview), this README.
Nothing in this directory is part of the Jekyll site; `antenna` is in the `_config.yml`
exclude list.

## Routes

| Route | Serves | Edge cache | Source |
|---|---|---|---|
| `GET /planes` | KV `snap:planes`, the aircraft sample, plus `refresh` while a requested sample is on its way | `s-maxage=90` | adsb.lol tiles, adsb.fi per-tile fallback, gathered by the collector (`collect.mjs` on GitHub Actions) every half hour while watched and on demand; the Worker's own cron is the fallback. Each request is a visit and may start the collector (see "On demand") |
| `GET /jam` | KV `agg:jam`, summarized to one row per bin: the newest sample and the last 24 hours, plus `refresh` as on `/planes` | `s-maxage=120` | derived from the same tiles, rolled by whichever wrote `/planes` |
| `GET /tfrs` | KV `tfrs`, the list plus geometry | `s-maxage=600` | `tfr.faa.gov` list plus per-TFR detail |
| `GET /notams/gps` | KV `notams:gps` | `s-maxage=900` | FAA NOTAM API, needs secrets |
| `GET /health` | computed | `no-store` | per route KV ages, tile coverage, the last collector dispatch `{t, status, why}` once there is one (`why` is `visit` or `cron`), and the last visit `{t}` |

Every response carries `Access-Control-Allow-Origin: *` (public data, no credentials), and
`OPTIONS` is answered with 204. Nothing here ever returns a 500: if an upstream or KV read
fails, the route serves the last stored value with `stale: true` and an `ageMs`, or answers
503 with `offline: true` and a reason in plain words when there is nothing stored at all.
`/planes` and `/jam` call their value stale at 45 minutes (the half hour, the collector's queue and
its round; `ROUTES` in `worker.js`, the same window as the page's two feeds; it was 75 at the hourly
cadence), `/tfrs` at 6 hours and `/notams/gps` at 24 hours. After a quiet spell the stored snapshot
is older than that, and is served as stale until the sample the visit asked for lands.

Two extras on `/planes` that the page uses to stay polite:

- `?since=<t>` where `t` is the `t` of the copy the client already holds. The snapshot changes
  at most every half hour (once per cron only while the Worker's fallback writes it), so a matching
  `since` returns `{ ok, t, unchanged: true }` (plus `refresh` when there is one) instead of the
  whole tile set.
- `?min_alt=<feet>` trims the rows to the altitudes an instrument actually uses (the winds
  instrument only looks above 27,000 ft).

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
- **When it runs.** `.github/workflows/collect-antenna.yml`, started by the Worker (the next two
  bullets: on a visit, and by the cron every half hour while someone is watching), by hand, and once
  by a push that changes the collector. It has no
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
  echoed. Each cron, after the deferral decision and after every other stage (so it spends a call
  the others leave in the 44 call budget and none of them loses one; the 21 tiles spend at most 42,
  so it always has its call, and with no call left it would skip with `no subrequest left`), the
  Worker sends ONE `POST
  https://api.github.com/repos/keenlooks/keenlooks.github.io/actions/workflows/collect-antenna.yml/dispatches`
  with `{"ref":"master"}` (`GH_REPO`, `GH_WORKFLOW` and `GH_REF` in `worker.js`; GitHub answers 204),
  never following a redirect, when the stored snapshot is absent, its own, or a collector's 25
  minutes old or more (`DISPATCH_STALE_MS`), KV `dispatch:last` is absent or 25 minutes old or
  more (`DISPATCH_GAP_MS`), and (since 2026-10-12) someone visited in the last 20 minutes
  (`VISIT_WATCH_MS`, KV `visit:last`). The hourly pass had both at 50 minutes and no visit gate:
  its 24 hour simulation (`_tests/observatory/antenna-hourly-2026-10-11/`) gave 24 runs a day, the
  snapshot never more than 60.4 minutes old. A refused run writes nothing and the next dispatch
  goes 25 minutes after it. It records `dispatch:last` `{t, status, why}` whatever GitHub answers
  (a redirect is recorded with its 3xx status), so a broken token costs one call per 25 minutes of
  watching and no more, and logs one line after the cron line: `dispatch: sent, status 204`,
  `dispatch: sent, status 401, body <the first 120 characters>`, or `dispatch: skipped, <why>`
  (`skipped, no visit in the last 20 minutes` on a quiet night); `/health` shows
  `dispatch: {t, status, why}`. The token goes
  to `api.github.com` and nowhere else, and never into a log, a KV value or `/health`. Without the
  secret the Worker makes no call, reads and writes nothing for it, and logs `dispatch: skipped, no
  token`; everything else it does is byte-for-byte what it did before. Hand dispatches add runs on
  top of the Worker's (two more KV writes each), so they stop once this trigger is live.
- **On demand (2026-10-12).** Keane: "Let's change the update frequency to every 30 mins then, but
  yes also make it on demand, and also change the page to tell the user for those layers that they
  are loading ... My website gets only about 20 visitors a day, and most won't click on the
  observatory". With `GH_DISPATCH_TOKEN` set (without it none of this reads or writes anything, and
  every answer is byte-for-byte what it was):
  1. *Visits.* A `/planes` request (the page polls it every three minutes while it is open) records
     KV `visit:last {t}`, written only when the stored one is absent or 10 minutes old
     (`VISIT_WRITE_GAP_MS`; 5 before the third pass), so a watching tab costs one KV write about every
     twelve minutes, and at most 144 a day from one Cloudflare location. `/health` shows `visit {t}`.
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
  4. *The cron waits for a visit.* Its dispatch (`why: 'cron'`) goes only while `visit:last` is
     younger than 20 minutes (Fable's ruling in the second pass; it was 35), so an open tab is
     refreshed every half hour and a quiet night costs nothing. An open page polls `/planes` every
     three minutes and asks for itself, so the cron's window only has to cover a tab between polls.
     Third pass: while `visit:last` is younger than `VISIT_SELF_MS` (13 minutes, the write gap plus one
     poll, so an open tab is always inside it) the cron leaves the dispatch to the page (`skipped, a
     page polled N s ago and asks for itself`); before this a tab and the cron in two Cloudflare
     locations could both ask inside KV's propagation (the review's probe P9: up to 95 runs a day
     where 48 were due; now 48 at every lag). With the token set, its own aircraft round (the fallback) waits for a visit too, and
     for a dispatch in flight (`fallbackHold`; a collector snapshot older than 45 minutes is the
     normal state of a quiet night now, and without this hold the fallback would call the two
     volunteer feeds every ten minutes all night: 124 refused rounds, 744 calls, a day in the
     simulation).
  The simulation (`_tests/observatory/antenna-ondemand-2026-10-12/`, third pass, 24 hours, two
  one-hour visits, 90 phase and delay combinations): 6 runs a day in 72 combinations and 4 in 18;
  none outside a visit and its 20 minute window, and in 42 combinations two runs (one per visit) are
  the cron's, 1 to 9 minutes after the visitor left (the last `visit:last` written then is up to about
  12 minutes old), in place of a third run inside the visit; the first poll of every visit starts the
  run whose sample is the first new one the page sees, 3 to 8 minutes in; while the visitor stays the
  stored snapshot is at most 29.0 minutes old at a poll and 30.4 when replaced. With the first pass's
  35 minute window the same days had 6 or 8 runs, with the second pass's 20 minutes 6. KV is eventually
  consistent (about a minute), so two dispatches from two Cloudflare locations inside that minute
  are possible (the workflow's concurrency group then runs the second after the first).
- **The deferral rule.** Each cron first reads the head of the stored snapshot (the fields before
  `tiles`, without parsing the tile array: `snapHead`, a few microseconds where a full parse of a
  250 to 750 KB snapshot costs 0.5 to 2 ms of a cron's 10 ms). When it names a writer and is younger
  than 45 minutes (`COLLECTOR_FRESH_MS`, the half hour plus the queue and the round, 75 at the hourly
  cadence; a `t` more than 5 minutes in the future is a skewed
  clock and counts as absent, and ages are clamped at 0), the cron makes no tile call and no snapshot or jam
  write, logs `deferred to the collector, age N s` in its log line, and its whole call budget goes
  to the TFRs. When the stored snapshot is older, absent, or the Worker's own (the Worker never
  names a writer), the cron runs its own round as before: that is the fallback (with the token set,
  only while someone visited in the last 20 minutes and no dispatch is in flight; see "On demand"). The fallback
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
(every half hour) and once when a visit begins after a quiet spell, so the feeds are pulled about 3
times per hour-long visit and not at all on a quiet day; two one-hour visits a day is 6 runs, about
10 to 20 MB at the per-round sizes below, against 39 to 82 MB at once an hour.

Bandwidth note for the owner, measured on 2026-10-12 (`_tests/observatory/antenna-hourly-2026-10-11/`):
one collector round of the 21 tiles at 05:40Z, a quiet hour with 2,132 aircraft, pulled 1.61 MB of
JSON (gzip on the wire, so less over the network; a tile averaged 77 KB, the busiest 405 KB). At
the busiest round measured (4,519 aircraft, 2026-10-11 14:22Z) a round is about 3.4 MB. Once an
hour that is about 39 to 82 MB a day from a volunteer funded feed network, where a round every ten
minutes was about 230 to 490 MB. If adsb.lol or adsb.fi ever asks for less, the two knobs are the
collector's start (`DISPATCH_STALE_MS` and `DISPATCH_GAP_MS` in `worker.js`) and the tile list at
the top of `worker.js`; the cron interval in `wrangler.toml` paces only the TFRs, the NOTAM sweep
and the Worker's own fallback round.

## What the cron does

Steps 1 to 3 are the aircraft phase (`runAircraftPhase`), which the collector runs every half hour
while someone is watching and on demand; the cron skips them while a collector snapshot is younger
than 45 minutes, and (with the token) while nobody has visited in 20 minutes or a dispatch is in
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
   than a precise one. The `tfrs` write is skipped whenever the enriched payload is identical
   to the stored one, which is most crons.
5. Every six hours, if the FAA secrets are configured, sweep a slice of a pinned CONUS and
   Alaska grid for FDC NOTAMs, keep the ones whose text mentions GPS, GNSS or WAAS, and parse
   their `coordinates` and `radius` into circles. The FAA API has no free text search and caps
   `locationRadius` at 100 nm, so this sweep is coarser than its own footprint: coverage is
   partial by construction, and only US NOTAMs exist at all. The page says both.
6. With `GH_DISPATCH_TOKEN`, start the collector when its snapshot is 25 minutes old and someone
   visited in the last 20 minutes (see "The
   collector"), last, on a call the stages above leave.

## Budgets

Cloudflare's free plan allows 1,000 KV writes a day and 50 subrequests per invocation. The
Worker counts its own subrequests (`MAX_SUBREQUESTS`, 44) and stops rather than blowing the
cap, and the cron caps detail fetches and sweep points per run.

| Key | Writes per day | Notes |
|---|---|---|
| `snap:planes` | 0 to about 6 | one per collector round, about 3 per hour-long visit and none on a quiet day (through the KV REST API, which counts here too); up to 144 only while the collector is down, someone is watching and the Worker's own fallback rounds reach 6 or more tiles |
| `agg:jam` | 0 to about 6 | rolled with each snapshot write, so the same count as `snap:planes` (up to 144 with the fallback, as above) |
| `tfrs` | roughly 10 to 60 | skipped when the payload is unchanged, 144 in the worst case |
| `tfrgeo:<id>` | roughly 10 to 30 | only new TFRs, plus a backfill of about 95 on the first day |
| `notams:gps` | 4 | one per six hour sweep |
| `dispatch:last` | 0 to about 6 | one per collector dispatch, at most one per 25 minutes from one Cloudflare location (58 a day), only with `GH_DISPATCH_TOKEN` and a visit |
| `visit:last` | about 5 per hour watched | at most one per 10 minutes from one location (144 a day), only with `GH_DISPATCH_TOKEN` |
| **Typical total** | **roughly 46 to 122** | two one-hour visits a day (simulated): visit:last 10, dispatch:last, snap:planes and agg:jam 4 to 6 each, tfrs 10 to 60, tfrgeo 10 to 30, notams 4. Each extra collector run (a hand dispatch, a push) adds 2 |
| **Worst case, one location** | **about 591** | a page open all day in one Cloudflare location: visit:last 144, dispatch:last, snap:planes and agg:jam 58 each, tfrs 144, a first-day tfrgeo backfill of about 125, notams 4. If the collector were down and Cloudflare's egress let the Worker's own fallback through, snap:planes and agg:jam could reach 144 each: about 763 |
| **The cap, honestly** | **1,000 a day** | the visit and dispatch caps are per Cloudflare location (KV takes about a minute to carry a write between them), so each further location with a page open all day adds up to 144 visit writes and its own dispatches: measured (the review's probe P8, third pass) 5 such locations reach about 750 to 850 a day and 8 about 1,040 to 1,140, over the cap. Past it KV refuses writes until 00:00 UTC: the routes go on serving the last values, the collector's run fails red, and `dispatch:last` can no longer hold the 25 minute gap. Twenty visitors a day who mostly do not open the observatory are far from it |

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
