# CLAUDE.md — kol-search-crawler

Project invariants for AI-assisted edits. Violating any of these is a regression.

1. **No secrets in the repo or image.** No `*service-account*.json` anywhere; both
   `.gitignore` and `.dockerignore` block it. Credentials come only from the
   `GOOGLE_SERVICE_ACCOUNT_JSON` env var or the `serviceAccountJson` secret input.
2. **scraperlink `limit` must be a STRING.** `limit: String(resultsPerQuery)` in
   `googleSearch.js`. Sending a number silently misbehaves.
3. **Never clear Output at run start.** All writes go to the run-stamped staging tab via
   atomic `values.append`; `promoteStaging()` runs only after the loop completes. Do not
   reintroduce read-A:A row arithmetic.
4. **Fatal path must call `Actor.fail()`**, never a bare exit — schedules alert on FAILED.
5. **Excel backup goes to the key-value store**, never the container filesystem.
6. **Hostname matching only** in `platformDetector.js` / `resultFilter.js` — never
   substring `includes()` on URLs (`"genedx.com".includes("x.com")` is the canonical bug).
7. **All date logic lives in `dateFilter.js`.** Pre-filter is permissive (unknown passes),
   final filter is strict (no parseable in-window date = removed). One parser, two policies.
8. **Page metadata overlays SERP data only when non-empty** (`enrichWithPageData`), and
   block pages ("Just a moment...", "Attention Required!") return empty metadata.
9. **`usesStandbyMode` stays `false`** — this is a batch actor with no HTTP server.
10. **Weekly no-miss contract:** SERP queries retry 3x (src/retry.js); per-KOL
    failures continue; RUN_SUMMARY health metrics always written; KOL failure
    rate above maxFailureRatePct fails the run AFTER promoting results. Never
    remove the retry, the summary, or the post-promote gate.
11. Column-C affiliation = ANCHORED PRECISION MODE: anchor on ALL five queries,
    name expression trimmed to full+short, 6-word affiliation cap. Never anchor
    by default — it is the operator's per-KOL ambiguity flag.
12. Identity gate (src/identityGate.js) shares name forms with the query
    generator via buildNameForms — never fork that logic. Verdicts: strong form
    = VALID; short-only needs affiliation/specialty/credential corroboration.
    Output columns Validity + Validity_Signals are part of the schema; Sheets
    ranges derive from OUTPUT_HEADERS length, never hardcode A:K.
13. Activity_Type is part of the schema (SMA | Press | Conference | Pubs |
    Trials | Other), classified in resultProcessor.classifyActivityType with SMA
    first (channel wins). Date policy per class lives in dateFilter.datePolicyFor:
    strict (Press/SMA/Other), lenient-undated (Pubs/Trials), event (Conference,
    future horizon EVENT_HORIZON_DAYS). Press-class undated pages are ALWAYS
    removed — never merge the policies.
14. Input columns are A=KOL_ID, B=KOL_Name, C=Suffix, D=Affiliation,
    E=Specialty (operator sheet order — never reorder). Roster suffix drives
    suffix-match (strong signal) and suffix-conflict (adjacent CLINICAL_PRIMARY
    degree not in roster => REVIEW). Conflict only fires between primary
    clinical credentials; PhD/fellowships never conflict.
15. SERP calls go through ONE global createLimiter(serpConcurrency) shared
    across KOLs — concurrent scraperlink runs are capped at serpConcurrency
    regardless of kolConcurrency. Local runs fail fast without APIFY_TOKEN;
    .env is never read.
16. SERP batching (queriesPerRun) packs queries into one scraperlink run
    with per-item keyword demux (attributeItems) and a module-level
    auto-fallback to per-query mode on first failure — never let a batching
    assumption kill a run. queryClusters subsets are 1-based.
17. Query set is 6 clusters per KOL with credential-cleaned names; directory exclusions
    live in code, not in `-site:` operators; every query stays under 32 words (tested).
