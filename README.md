# KOL Search Crawler

Reads a KOL roster from a Google Sheet, runs 5 clustered Google queries per KOL through a
SERP actor, verifies publish dates by crawling result pages, filters to a recency window,
and writes results back to the sheet — with a safety model that never destroys the previous
Output on a failed run.

## Pipeline (per KOL)

```
Input sheet (A: KOL_ID, B: KOL_Name, C: Affiliation optional)
  -> generateQueries()        5 clusters: broad / quotes / conference / press / publications
  -> searchGoogle()           SERP actor, tbs recency filter, limit passed as STRING
  -> processSerpResults()     normalize once
  -> isCandidateResult()      permissive date pre-filter (saves crawl cost)
  -> crawlPage()              batched; social platforms skipped by default; block-page guard
  -> enrichWithPageData()     page metadata overlays SERP only when non-empty
  -> filterRecentResults()    strict: no parseable in-window date => removed
  -> filterResults()          normalized-URL dedupe + directory/profile blocklist
  -> staging tab append       atomic values.append (no row math, no race)
  -> Actor.pushData()         Apify dataset
Run end -> promoteStaging()   staging replaces Output, staging tab deleted
        -> Excel backup       KOL_Search_Report.xlsx in the key-value store
```

## Credentials — read this first

There is **no credentials file** in this repo and none may ever be added. The old
committed `src/google-service-account.json` must be treated as compromised:
**rotate that key in GCP IAM before deploying this build.**

Provide credentials one of two ways:

1. Actor **environment variable** `GOOGLE_SERVICE_ACCOUNT_JSON` (Apify Console ->
   Actor -> Settings -> Environment variables -> add as **secret**), value = the full
   service-account JSON, or
2. the `serviceAccountJson` **secret input field** on each run/task.

The service account needs edit access to the spreadsheet (share the sheet with its
`client_email`).

## Safety model

- **Output survives failures.** Results append to a run-stamped `_staging_<runId>` tab.
  Only after the whole run completes does the staging content replace `Output`. A crash
  leaves the previous Output intact and the partial staging tab available for inspection.
- **Atomic appends.** `values.append` — no read-A:A-then-write row arithmetic, so two
  overlapping runs cannot overwrite each other's rows.
- **Empty runs don't wipe data.** Zero results leaves Output untouched (usually an
  upstream failure); override with the `promoteEmptyRun` input.
- **Fatal errors fail the run.** `Actor.fail()` sets FAILED status so schedule
  monitoring/alerts actually fire.

## Inputs

| Field                        | Default                | Notes                                                             |
| ---------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `daysBack`                   | 7                      | 0 = today only                                                    |
| `spreadsheetId`              | (current sheet)        |                                                                   |
| `inputSheet` / `outputSheet` | `Input` / `Output`     | Input columns: A id, B name, C affiliation (optional)             |
| `serviceAccountJson`         | —                      | secret; or use the env var                                        |
| `resultsPerQuery`            | 10                     | passed to the SERP actor as a STRING (scraperlink requirement)    |
| `pageConcurrency`            | 10                     |                                                                   |
| `useApifyProxy`              | false                  | route page crawls through Apify proxy                             |
| `crawlSocialPlatforms`       | false                  | LinkedIn/X/etc. block plain crawls; SERP metadata is used instead |
| `promoteEmptyRun`            | false                  | see safety model                                                  |
| `googleActorId`              | scraperlink SERP actor | advanced                                                          |

## Query design

Five queries per KOL (was 10 — the MD/DR split doubled cost for near-identical results):

1. `NAME (MD OR Dr OR PhD) ["Affiliation"]` — broad net, `tbs` does the recency work
2. `... (said OR says OR told OR noted OR "according to")` — media quotes
3. `... (presented OR presentation OR conference OR congress OR "annual meeting")`
4. `... ("press release" OR announced OR named OR award OR recognized OR grant)`
5. `... (study OR trial OR published OR findings OR journal OR research)`
6. `... ("grand rounds" OR CME OR faculty OR speaker OR webinar OR symposium)` — events/faculty lane

Cluster terms and the name-variant design are validated against 14,820 unique press
articles from two live NotifyMe corpora (Alexion Neurology + Ferring Uro-Onco); the
evidence percentages are documented in `src/queryGenerator.js`. Parenthetical roster
names (`Benjamin (Ben) Joseph Osborne`, `Ericka Portley Greene (Simpson)`) yield an
extra nickname / alternate-surname variant.

Names are cleaned first (`Dr.` prefix, trailing credentials, parentheticals).
Directory spam (Healthgrades, Doximity, Zocdoc, NPI registries, `webmd.com/doctor`, ...)
is excluded in `resultFilter.js`, not with `-site:` operators, keeping every query under
Google's 32-word limit.

## Local development

```bash
npm install
export GOOGLE_SERVICE_ACCOUNT_JSON="$(cat /path/to/key.json)"   # never commit this file
echo '{"daysBack": 7}' > storage/key_value_stores/default/INPUT.json
npm start
npm test        # vitest: queryGenerator, dateFilter, platformDetector, resultFilter
```

## Activity taxonomy (`Activity_Type` column)

Every result is classified into the NotifyMe activity lanes, with precedence:

1. **SMA** — social-platform posts, by channel (an Instagram conference post is SMA)
2. **Trials** — trial registry domains (clinicaltrials.gov etc.) or NCT identifiers
3. **Pubs** — journal / publisher / PubMed domains, DOI-style paths
4. **Conference** — CME, grand rounds, faculty, speaker, symposium, webinar signals
5. **Press** — newsy language (announcements, quotes, approvals, awards)
6. **Other** — nothing matched (directories, evergreen archives, unclear pages)

Date policy follows the class: **strict** for Press / SMA / Other (parseable
in-window date required — the evergreen-junk guard); **lenient-undated** for Pubs /
Trials (registry and publisher pages are often dateless in SERPs; dated ones must be
in-window); **event** for Conference (undated kept, absolute dates accepted up to 365
days in the FUTURE — an upcoming grand rounds is exactly the wanted signal). All
classes pass the same identity gate.

## Local runs & parallelism

- **Local runs need APIFY_TOKEN in the same shell** — the platform injects
  it, your PowerShell does not, and `.env` is NOT read. The actor now
  fails fast with the fix: `$env:APIFY_TOKEN="apify_api_..."` then verify
  `($env:APIFY_TOKEN).Length` is 46, then `npm start`.
  ("User was not found or authentication token is not valid" = this, not
  the Google service account — Sheets reading fine proves Google auth is OK.)
- **queriesPerRun** (default 6): batches a KOL's queries into ONE
  scraperlink run — the ~25s actor overhead is paid once per KOL instead
  of six times. Auto-falls back to per-query mode (with a loud log line)
  if the actor rejects keyword arrays. 368 KOLs: ~2,208 runs -> 368.
- **queryClusters** (optional): weekly-lean subset like [1,3,4,6] when
  dedicated pubs/trials pipelines already cover those lanes.
- **serpConcurrency** (default 4): each KOL's 6 queries now run in
  parallel through one global limiter shared across all KOLs, capping
  concurrent scraperlink runs at exactly serpConcurrency. Combine with
  kolConcurrency to overlap crawling/gating. Recommended: serpConcurrency
  4, kolConcurrency 2.
- Affiliations that look like credential strings ("MD, MBA, FACS") are
  warned about and ignored for anchoring — that is the Suffix column in
  the wrong place (Input order: C=Suffix, D=Affiliation).

## Weekly no-miss operation

The weekly contract is: every KOL, every week, no silent gaps. Three mechanisms serve it:

1. **Retries.** Every SERP query retries 3x with backoff before counting as failed.
2. **Health gate.** `RUN_SUMMARY` in the key-value store counts failed KOLs, failed
   queries, and zero-result KOLs. If KOL failures exceed `maxFailureRatePct`
   (default 10%), the run is marked FAILED _after_ promoting its results — data
   lands, monitoring alerts, someone investigates before the next cycle.
3. **KOL concurrency.** `kolConcurrency: 3-5` for large rosters. Safe because
   staging writes are atomic appends. Weekly throughput math at ~30s per SERP
   sub-run, 5 queries/KOL: 635 KOLs sequential ~26h, at concurrency 4 ~7h;
   1,247 KOLs sequential ~52h, at concurrency 4 ~13h.

Operating recommendations:

- **Run weekly with `daysBack: 9`, not 7.** Google indexes some articles 1-2 days
  late, and schedules slip; a strict 7-day window run weekly leaks items at the
  boundary. The 2-day overlap re-captures them; downstream NotifyMe history
  dedupe absorbs the repeats.
- **Stagger project schedules** across the week rather than one consolidated
  roster: the consolidated Bio_KOLs sheet carries ~1,375 duplicate rows across
  projects (same physician, two projects) that a single run would pay for twice,
  and per-project sheets keep client separation.
- **Verify whether the scraperlink actor accepts multiple keywords per run.** If
  it does, batching the 5 queries into one call cuts cost and wall time 5x.
- **Common-name KOLs need column C.** Pilot run: unanchored, "Michael Scott
  Perry" returned 20/20 wrong-person rows; distinctive "Ingo Helbig" returned
  15/16 clean. A populated affiliation switches that KOL to ANCHORED PRECISION
  MODE: the phrase is appended to all five queries and the name expression trims
  to full + short. Leave column C blank for distinctive names — anchoring costs
  recall (only 22.7% of real coverage mentions the affiliation).
- **Social results are a flood risk.** 74% of pilot rows were social platforms,
  mostly wrong-person; set `includeSocialResults: false` for press-article
  deliverables.
- **Identity gate (`identityGate: tag | drop | off`, default `tag`).** Every
  surviving row must prove it is about THIS KOL: a strong name form (full /
  initial / alternate), or the short name plus affiliation-token, specialty-stem,
  or credential-adjacency evidence from the snippet and crawled page body.
  Measured on 14,153 ground-truth pairs: 99.6% (Alexion) / 97.5% (Ferring)
  true-positive retention — excerpt-based, so live retention is higher. Rollout:
  run `tag` for the first cycle, review the Validity / Validity_Signals columns,
  then switch to `drop`. Treat `credential-adjacent`-only rows with care: a
  wrong person can be quoted next to a doctor on a medical page.
- Known accepted losses (measured across 110,616 KOL-article pairs, 9 projects):
  ~1-4% of coverage names the KOL only as "Dr. Lastname", plus rare misspellings.
  Everything else in the miss bucket is wrong-person/junk/drug-lane content the
  per-KOL crawl correctly excludes.

## Deploy

Push to the Apify actor, set the secret env var, **trigger a build manually** (no
auto-build is wired), and run. Verify the first run against a 2–3 KOL test Input.
