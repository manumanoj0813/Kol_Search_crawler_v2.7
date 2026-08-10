/**
 * KOL Search Crawler — entry point.
 *
 * Weekly no-miss operating contract:
 *   - Every KOL processed every run; per-KOL failures never kill the
 *     run, per-query failures retry 3x before counting as failed.
 *   - Nothing degrades silently: RUN_SUMMARY (key-value store) counts
 *     failed KOLs, failed queries, and zero-result KOLs; if the KOL
 *     failure rate exceeds maxFailureRatePct, the run FAILS *after*
 *     promoting its results, so alerts fire while no data is lost.
 *   - KOL-level parallelism (kolConcurrency) makes fleet-scale weekly
 *     cadence feasible; it is safe because staging-tab writes use the
 *     atomic values.append API.
 *
 * Pipeline per KOL:
 *   queries -> SERP search (retried) -> normalize -> date pre-filter
 *   -> page crawl (social skipped) -> enrich -> strict date filter
 *   -> dedupe/blocklist -> append to staging tab + Apify dataset
 *
 * Safety model:
 *   - Previous Output untouched until the whole run succeeds
 *     (staging tab -> promote on success).
 *   - Fatal errors call Actor.fail() so monitoring alerts.
 */

import { Actor } from 'apify';
import { HttpsProxyAgent } from 'https-proxy-agent';

import { CONFIG } from './config.js';
import {
    initSheets,
    readKOLs,
    createStaging,
    appendResults,
    promoteStaging,
    dropStaging,
} from './googleSheets.js';
import { generateQueries } from './queryGenerator.js';
import { searchGoogle } from './googleSearch.js';
import { crawlPage } from './pageCrawler.js';
import { processSerpResults, enrichWithPageData } from './resultProcessor.js';
import { isCandidateResult, filterRecentResults } from './dateFilter.js';
import { filterResults } from './resultFilter.js';
import { assessIdentity } from './identityGate.js';
import { buildWorkbookBuffer } from './exporter.js';
import { detectPlatform } from './platformDetector.js';
import { createLimiter, runInBatches } from './retry.js';

await Actor.init();

let stagingTitle = null;

try {
    // ------------------------------------------------------------
    // INPUT
    // ------------------------------------------------------------
    const input = (await Actor.getInput()) || {};

    const daysBack = Number.isFinite(Number(input.daysBack))
        ? Number(input.daysBack)
        : CONFIG.DAYS_BACK;

    const resultsPerQuery =
        Number(input.resultsPerQuery) || CONFIG.RESULTS_PER_QUERY;

    const pageConcurrency =
        Number(input.pageConcurrency) || CONFIG.PAGE_CONCURRENCY;

    const kolConcurrency = Math.max(
        1,
        Number(input.kolConcurrency) || 1
    );

    const serpConcurrency = Math.min(
        10,
        Math.max(1, Number(input.serpConcurrency) || 4)
    );

    const queriesPerRun = Math.min(
        30,
        Math.max(1, Number(input.queriesPerRun) || 6)
    );

    const queryClusters =
        Array.isArray(input.queryClusters) && input.queryClusters.length > 0
            ? input.queryClusters
            : null;

    // ------------------------------------------------------------
    // Local-run preflight
    // ------------------------------------------------------------
    // On Apify platform, APIFY_IS_AT_HOME is available.
    // For local runs, APIFY_TOKEN must be present.
    if (!process.env.APIFY_IS_AT_HOME) {
        const token = process.env.APIFY_TOKEN || '';

        if (!token) {
            await Actor.fail(
                'APIFY_TOKEN is not set in this shell. Fix (same PowerShell ' +
                    'window as the run): $env:APIFY_TOKEN="apify_api_..." ; ' +
                    '($env:APIFY_TOKEN).Length -> expect 46, then npm start.'
            );

            // IMPORTANT:
            // No "return" here because this is top-level code.
            // Actor.fail() handles the failed Actor run.
        }

        console.log(
            `Local run: APIFY_TOKEN present (length ${token.length}).`
        );
    }

    // Shared across ALL KOLs: caps concurrent scraperlink actor runs at
    // serpConcurrency regardless of kolConcurrency.
    const serpLimiter = createLimiter(serpConcurrency);

    const maxFailureRatePct = Number.isFinite(
        Number(input.maxFailureRatePct)
    )
        ? Number(input.maxFailureRatePct)
        : 10;

    const actorId =
        input.googleActorId || CONFIG.GOOGLE_ACTOR_ID;

    const crawlSocialPlatforms =
        Boolean(input.crawlSocialPlatforms);

    const includeSocialResults =
        input.includeSocialResults !== false;

    const identityGate = ['off', 'tag', 'drop'].includes(
        input.identityGate
    )
        ? input.identityGate
        : 'tag';

    const promoteEmptyRun =
        Boolean(input.promoteEmptyRun);

    console.log('========================================');
    console.log('KOL SEARCH CRAWLER STARTED');
    console.log('========================================');

    console.log(
        `Days back: ${daysBack} | results/query: ${resultsPerQuery} | ` +
            `page concurrency: ${pageConcurrency} | KOL concurrency: ${kolConcurrency} | ` +
            `SERP concurrency: ${serpConcurrency} | queries/run: ${queriesPerRun}` +
            (queryClusters
                ? ` | clusters: [${queryClusters}]`
                : '')
    );

    // ------------------------------------------------------------
    // GOOGLE SHEETS INITIALIZATION
    // ------------------------------------------------------------
    initSheets({
        spreadsheetId:
            input.spreadsheetId ||
            '1XCq1jKKbXvWxamLgl9IxqoXJJxsIakgClszIG09AlxQ',

        inputSheet:
            input.inputSheet || 'Input',

        outputSheet:
            input.outputSheet || 'Output',

        serviceAccountJson:
            input.serviceAccountJson,
    });

    // ------------------------------------------------------------
    // APIFY PROXY
    // ------------------------------------------------------------
    let proxyConfiguration = null;

    if (input.useApifyProxy) {
        proxyConfiguration =
            await Actor.createProxyConfiguration();

        console.log(
            'Apify proxy enabled for page crawls.'
        );
    }

    // ------------------------------------------------------------
    // READ KOLS
    // ------------------------------------------------------------
    const kols = await readKOLs();

    if (kols.length === 0) {
        console.log(
            'No KOLs found in the Input sheet. Nothing to do.'
        );

        await Actor.exit();
    }

    // ------------------------------------------------------------
    // STAGING TAB
    // Output stays intact until success
    // ------------------------------------------------------------
    const runTag = (
        process.env.APIFY_ACTOR_RUN_ID ||
        String(Date.now())
    ).slice(0, 12);

    stagingTitle = await createStaging(runTag);

    const allResults = [];

    const health = {
        totalKols: kols.length,
        kolsFailed: 0,
        failedKolNames: [],
        queriesFailed: 0,
        failedQuerySamples: [],
        kolsZeroResults: 0,
        reviewRows: 0,
        droppedByGate: 0,
        totalResults: 0,
    };

    // ------------------------------------------------------------
    // PER-KOL PIPELINE
    // ------------------------------------------------------------
    async function processKol(kol, index) {
        console.log('========================================');

        console.log(
            `KOL ${index + 1}/${kols.length}: ` +
                `${kol.kolName} (${kol.kolId})`
        );

        try {
            // ----------------------------------------------------
            // 1. Generate search queries
            // ----------------------------------------------------
            const queries = generateQueries(
                kol.kolName,
                kol.affiliation,
                queryClusters
            );

            if (queries.length === 0) {
                console.log(
                    `Empty name after cleaning, skipping: ${kol.kolName}`
                );

                return;
            }

            // ----------------------------------------------------
            // 2. SERP SEARCH
            // Each query retried 3x inside searchGoogle()
            // ----------------------------------------------------
            const {
                results: googleResults,
                failedQueries,
            } = await searchGoogle(queries, {
                daysBack,
                actorId,
                resultsPerQuery,
                includeMerged: CONFIG.INCLUDE_MERGED,
                limiter: serpLimiter,
                queriesPerRun,
            });

            if (failedQueries.length > 0) {
                health.queriesFailed +=
                    failedQueries.length;

                if (
                    health.failedQuerySamples.length < 20
                ) {
                    health.failedQuerySamples.push(
                        ...failedQueries.slice(0, 3)
                    );
                }
            }

            if (googleResults.length === 0) {
                console.log(
                    `No Google results for ${kol.kolName}`
                );

                health.kolsZeroResults++;

                return;
            }

            // ----------------------------------------------------
            // 3. Normalize SERP items
            // ----------------------------------------------------
            const serpProcessed =
                processSerpResults(
                    kol,
                    googleResults
                );

            // ----------------------------------------------------
            // 4. Permissive date pre-filter
            // Saves crawl cost
            // ----------------------------------------------------
            const candidates =
                serpProcessed.filter((r) =>
                    isCandidateResult(
                        r.publishedDate,
                        daysBack,
                        r.activityType
                    )
                );

            if (candidates.length === 0) {
                health.kolsZeroResults++;

                return;
            }

            // ----------------------------------------------------
            // 5. Unique URLs
            // Minus platforms we will not crawl
            // ----------------------------------------------------
            const uniqueUrls = [
                ...new Set(
                    candidates
                        .map((r) => r.url)
                        .filter(Boolean)
                ),
            ];

            const urlsToCrawl =
                crawlSocialPlatforms
                    ? uniqueUrls
                    : uniqueUrls.filter(
                          (u) =>
                              detectPlatform(u) ===
                              'Website'
                      );

            // ----------------------------------------------------
            // 6. Crawl in batches
            // ----------------------------------------------------
            const pageData = new Map();

            for (
                let i = 0;
                i < urlsToCrawl.length;
                i += pageConcurrency
            ) {
                const batch = urlsToCrawl.slice(
                    i,
                    i + pageConcurrency
                );

                let agent;

                if (proxyConfiguration) {
                    const proxyUrl =
                        await proxyConfiguration.newUrl();

                    agent =
                        new HttpsProxyAgent(proxyUrl);
                }

                const crawled = await Promise.all(
                    batch.map(async (url) => ({
                        url,
                        metadata:
                            await crawlPage(url, {
                                agent,
                            }),
                    }))
                );

                for (const item of crawled) {
                    pageData.set(
                        item.url,
                        item.metadata
                    );
                }
            }

            // ----------------------------------------------------
            // 7-9. Enrich, strict date filter,
            // dedupe + blocklist
            // ----------------------------------------------------
            const enriched =
                enrichWithPageData(
                    candidates,
                    pageData
                );

            const recent =
                filterRecentResults(
                    enriched,
                    daysBack
                );

            let kolFinalResults =
                filterResults(recent);

            // ----------------------------------------------------
            // Remove social results when disabled
            // ----------------------------------------------------
            if (!includeSocialResults) {
                const before =
                    kolFinalResults.length;

                kolFinalResults =
                    kolFinalResults.filter(
                        (r) =>
                            r.platform ===
                            'Website'
                    );

                if (
                    before -
                        kolFinalResults.length >
                    0
                ) {
                    console.log(
                        `Dropped ${
                            before -
                            kolFinalResults.length
                        } social-platform result(s).`
                    );
                }
            }

            console.log(
                `Final results for ${kol.kolName}: ${kolFinalResults.length}`
            );

            // ----------------------------------------------------
            // 10. Persist
            // Staging tab + Apify dataset
            // ----------------------------------------------------
            if (kolFinalResults.length > 0) {
                await appendResults(
                    stagingTitle,
                    kolFinalResults
                );

                await Actor.pushData(
                    kolFinalResults
                );

                allResults.push(
                    ...kolFinalResults
                );
            } else {
                health.kolsZeroResults++;
            }
        } catch (error) {
            console.error(
                `FAILED KOL: ${kol.kolName} | ${error.message}`
            );

            health.kolsFailed++;

            if (
                health.failedKolNames.length <
                50
            ) {
                health.failedKolNames.push(
                    kol.kolName
                );
            }

            // Continue — one KOL must never kill
            // the weekly run.
        }
    }

    // ------------------------------------------------------------
    // PROCESS ALL KOLS
    // ------------------------------------------------------------
    await runInBatches(
        kols,
        kolConcurrency,
        processKol
    );

    // ------------------------------------------------------------
    // PROMOTE + EXCEL BACKUP + HEALTH GATE
    // ------------------------------------------------------------
    health.totalResults =
        allResults.length;

    console.log('========================================');

    console.log(
        `ALL KOLS FINISHED — results: ${health.totalResults} | ` +
            `KOLs failed: ${health.kolsFailed}/${health.totalKols} | ` +
            `queries failed: ${health.queriesFailed} | zero-result KOLs: ${health.kolsZeroResults} | ` +
            `review rows: ${health.reviewRows}` +
            (identityGate === 'drop'
                ? ` (dropped ${health.droppedByGate})`
                : '')
    );

    // ------------------------------------------------------------
    // PROMOTE STAGING RESULTS
    // ------------------------------------------------------------
    if (
        allResults.length > 0 ||
        promoteEmptyRun
    ) {
        await promoteStaging(
            stagingTitle
        );

        stagingTitle = null;
    } else {
        console.log(
            'Zero results this run — previous Output left untouched.'
        );

        await dropStaging(
            stagingTitle
        );

        stagingTitle = null;
    }

    // ------------------------------------------------------------
    // EXCEL BACKUP
    // ------------------------------------------------------------
    if (allResults.length > 0) {
        const buffer =
            buildWorkbookBuffer(
                allResults
            );

        await Actor.setValue(
            'KOL_Search_Report.xlsx',
            buffer,
            {
                contentType:
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            }
        );
    }

    // ------------------------------------------------------------
    // RUN SUMMARY
    // ------------------------------------------------------------
    await Actor.setValue(
        'RUN_SUMMARY',
        health
    );

    console.log(
        'Run summary saved to the key-value store as RUN_SUMMARY.'
    );

    // ------------------------------------------------------------
    // NO-SILENT-DEGRADATION GATE
    // Results are already promoted;
    // degraded run must still alert monitoring.
    // ------------------------------------------------------------
    const failureRate =
        health.totalKols > 0
            ? (health.kolsFailed /
                  health.totalKols) *
              100
            : 0;

    if (
        failureRate >
        maxFailureRatePct
    ) {
        await Actor.fail(
            `DEGRADED RUN: ${health.kolsFailed}/${health.totalKols} KOLs failed ` +
                `(${failureRate.toFixed(1)}% > ${maxFailureRatePct}% threshold). ` +
                `Results WERE promoted to the Output sheet; see RUN_SUMMARY. ` +
                `Investigate before the next weekly run.`
        );
    }

    // ------------------------------------------------------------
    // SUCCESSFUL EXIT
    // ------------------------------------------------------------
    await Actor.exit();
} catch (error) {
    console.error(
        '========================================'
    );

    console.error('FATAL ERROR');

    console.error(
        '========================================'
    );

    console.error(error);

    if (stagingTitle) {
        console.error(
            `Previous Output is INTACT. Partial results are in staging tab "${stagingTitle}".`
        );
    }

    await Actor.fail(
        `FATAL: ${error.message}`
    );
}