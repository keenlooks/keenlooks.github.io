# The Observatory antenna

A small Cloudflare Worker that stands between `keanelucas.com/observatory/` and the four
upstream sources a browser cannot reach directly, because they send no CORS headers:
adsb.lol, adsb.fi, `tfr.faa.gov`, and the FAA NOTAM API.

The Worker fetches on a five minute cron, aggregates, and serves small CORS open JSON
snapshots. The page works without it: with no antenna deployed, the plane, jamming and TFR
layers report themselves offline and everything else on the page still runs.

Files here: `worker.js` (all the logic), `wrangler.toml` (deploy config), this README.
Nothing in this directory is part of the Jekyll site; `antenna` is in the `_config.yml`
exclude list.

## Routes

| Route | Serves | Edge cache | Source |
|---|---|---|---|
| `GET /planes` | KV `snap:planes`, the cron's aircraft sample | `s-maxage=90` | adsb.lol tiles, adsb.fi per-tile fallback |
| `GET /jam` | KV `agg:jam`, summarized to one row per bin | `s-maxage=120` | derived from the same tiles |
| `GET /tfrs` | KV `tfrs`, the list plus geometry | `s-maxage=600` | `tfr.faa.gov` list plus per-TFR detail |
| `GET /notams/gps` | KV `notams:gps` | `s-maxage=900` | FAA NOTAM API, needs secrets |
| `GET /health` | computed | `no-store` | per route KV ages and tile coverage |

Every response carries `Access-Control-Allow-Origin: *` (public data, no credentials), and
`OPTIONS` is answered with 204. Nothing here ever returns a 500: if an upstream or KV read
fails, the route serves the last stored value with `stale: true` and an `ageMs`, or answers
503 with `offline: true` and a reason in plain words when there is nothing stored at all.

Two extras on `/planes` that the page uses to stay polite:

- `?since=<t>` where `t` is the `t` of the copy the client already holds. The snapshot only
  changes once per cron, so a matching `since` returns `{ ok, t, unchanged: true }` instead of
  the whole tile set.
- `?min_alt=<feet>` trims the rows to the altitudes an instrument actually uses (the winds
  instrument only looks above 27,000 ft).

## Deploying

The normal path is automatic: `.github/workflows/deploy-antenna.yml` deploys this Worker
from GitHub Actions whenever a push to master touches `antenna/`, using the same
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repository secrets the chatbot worker
deploy already uses. It creates the `OBS_KV` namespace through the Cloudflare API if it
does not exist, substitutes the id into `wrangler.toml` at deploy time (the repo copy keeps
its placeholder), pushes the FAA secrets when the repo has them, and smokes `/health` at
`https://obs-antenna.keenlooks-cloudflare.workers.dev`. If the token lacks the
"Workers KV Storage: Edit" permission the run fails with a message saying so; add that
permission to the token in the Cloudflare dashboard and re-run the workflow.

The first cron fills `/planes` and `/jam` within about ten minutes of the first deploy;
until then those routes answer 503 offline and the page says so honestly.

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

   The first cron runs within five minutes of deploy; before it does, `/planes` and `/jam`
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
curl "http://127.0.0.1:8788/__scheduled?cron=*/5+*+*+*+*"
```

### Tests

The Worker's logic is written as functions that take an injected
`{ fetchFn, kv, nowMs, secrets, sleep }`, so the whole file runs in plain node with stubs and
no wrangler. The suite lives outside the repo, in the run directory:

```
node %LOCALAPPDATA%\Temp\observatory\run1\tests\node\t-antenna.js
ANT_BREAK=1 node ...\t-antenna.js     (proves the assertions bite: this run must fail)
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

Bandwidth note for the owner: 24 tiles at roughly 370 KB each, every five minutes, is about
2.5 GB a day pulled from a volunteer funded feed network. If adsb.lol or adsb.fi ever asks
for less, the two knobs are the cron interval in `wrangler.toml` and the tile list at the top
of `worker.js`, and both can be changed without touching anything else.

## What the cron does

Every five minutes:

1. Fetch the 24 pinned 250 nm tiles, serialized, at least 250 ms apart. adsb.lol first,
   adsb.fi for any tile that fails. Each tile is wrapped in its own try/catch, so a failed
   tile is written with `ok: false` and a reason rather than taking the cron down.
   `alt_baro` is the string `"ground"` for about a tenth of the aircraft in a busy tile;
   those are counted separately and never enter a numeric field.
2. Write KV `snap:planes`: `{ t, distNm, tilesOk, tilesTotal, planes, tiles: [{ clat, clon,
   region, ok, src, planes: [[lat, lon, altFt, gsKt, trackDeg, tasKt, magHeadingDeg, nacP,
   nic, wd, ws], ...] }] }`. Latitude and longitude keep three decimals, everything else one.
3. Bin the same aircraft into 2 by 2 degree cells and roll the rings in KV `agg:jam`: twelve
   five minute buckets for the last hour, twenty four hourly buckets for the last day. Each
   bin holds `[n, nLow]`, where `n` counts aircraft that reported `nac_p` and `nLow` counts
   those reporting 6 or lower. Aircraft that do not report `nac_p` are in neither number, so
   the fraction stays meaningful.
4. Fetch the TFR list. For new TFRs of type VIP, SECURITY, HAZARDS or SPACE, fetch the detail
   document (at most four per cron) and parse the polygon and circle geometry out of it,
   caching the result under `tfrgeo:<notam id>`. Anything without geometry falls back to the
   state centroid with `approx: true`, which the page shows as an approximate location rather
   than a precise one. The `tfrs` write is skipped whenever the enriched payload is identical
   to the stored one, which is most crons.
5. Every six hours, if the FAA secrets are configured, sweep a slice of a pinned CONUS and
   Alaska grid for FDC NOTAMs, keep the ones whose text mentions GPS, GNSS or WAAS, and parse
   their `coordinates` and `radius` into circles. The FAA API has no free text search and caps
   `locationRadius` at 100 nm, so this sweep is coarser than its own footprint: coverage is
   partial by construction, and only US NOTAMs exist at all. The page says both.

## Budgets

Cloudflare's free plan allows 1,000 KV writes a day and 50 subrequests per invocation. The
Worker counts its own subrequests (`MAX_SUBREQUESTS`, 44) and stops rather than blowing the
cap, and the cron caps detail fetches and sweep points per run.

| Key | Writes per day | Notes |
|---|---|---|
| `snap:planes` | 288 | one per cron |
| `agg:jam` | 288 | one per cron |
| `tfrs` | roughly 10 to 60 | skipped when the payload is unchanged, 288 in the worst case |
| `tfrgeo:<id>` | roughly 10 to 30 | only new TFRs, plus a backfill of about 95 on the first day |
| `notams:gps` | 4 | one per six hour sweep |
| **Typical total** | **roughly 620** | worst case about 900, cap 1,000 |

Payload sizes, measured against the live fixtures (24 tiles, about 12,500 aircraft):

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
