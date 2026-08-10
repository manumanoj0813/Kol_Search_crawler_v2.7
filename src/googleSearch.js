/**
 * Run the query set through the SERP actor and return deduplicated raw
 * results tagged with the query that found them.
 *
 * NOTE: the scraperlink actor requires `limit` as a STRING.
 *
 * v2.6: queries run IN PARALLEL through a shared limiter
 * (serpConcurrency) instead of sequentially — the dominant wall-clock
 * cost per KOL was 6 sequential actor calls.
 */

import { Actor } from 'apify';

import { withRetries } from './retry.js';

/** Split queries into chunks of at most `size` (size<=1 disables batching). */
export function chunkQueries(queries, size) {
    const clean = queries.map((q) => String(q || '').trim()).filter(Boolean);
    const n = Math.max(1, Number(size) || 1);
    const chunks = [];
    for (let i = 0; i < clean.length; i += n) chunks.push(clean.slice(i, i + n));
    return chunks;
}

/**
 * Attribute batched dataset items back to their originating query.
 * scraperlink-style items echo the keyword on each item; when the echo
 * is missing we can still attribute safely for single-query chunks,
 * otherwise we tag with the first query and warn once (results still
 * flow; only the Search_Query column loses precision).
 */
export function attributeItems(items, chunk) {
    const byQuery = new Map(chunk.map((q) => [q.toLowerCase(), []]));
    let unattributed = false;
    for (const item of items || []) {
        const echo = String(item.keyword || item.query || item.searchQuery || '')
            .trim()
            .toLowerCase();
        if (echo && byQuery.has(echo)) {
            byQuery.get(echo).push(item);
        } else if (chunk.length === 1) {
            byQuery.get(chunk[0].toLowerCase()).push(item);
        } else {
            unattributed = true;
            byQuery.get(chunk[0].toLowerCase()).push(item);
        }
    }
    return { byQuery, unattributed };
}

// Module-level switch: flips off automatically if the SERP actor
// rejects keyword arrays, so one failed probe degrades gracefully to
// the proven per-query mode for the rest of the run.
let batchSupported = true;

function tbsFor(daysBack) {
    if (daysBack <= 1) return 'qdr:d';
    if (daysBack <= 7) return 'qdr:w';
    if (daysBack <= 30) return 'qdr:m';
    return 'qdr:y';
}

function extractQueryResults(items) {
    const merged = (items || []).find((item) => item.page_number === 'all' || item.page === 'all');
    if (merged && Array.isArray(merged.results)) return merged.results;
    const out = [];
    for (const item of items || []) {
        if (Array.isArray(item.results)) out.push(...item.results);
    }
    return out;
}

export async function searchGoogle(
    queries,
    { daysBack, actorId, resultsPerQuery, includeMerged, limiter, queriesPerRun = 1 },
) {
    const client = Actor.apifyClient;
    const failedQueries = [];
    const allBatched = [];

    const tbs = tbsFor(daysBack);
    console.log(`Google time filter: ${tbs}`);

    const run = limiter || ((fn) => fn());

    // ---- BATCHED MODE: several queries per actor run ------------------
    // The dominant per-query cost is actor-run overhead (~25s of
    // container + dataset I/O around a ~2s search). Packing a KOL's
    // queries into ONE run deletes that overhead instead of dividing it.
    let pending = queries.map((q) => String(q || '').trim()).filter(Boolean);

    if (batchSupported && queriesPerRun > 1 && pending.length > 1) {
        const chunks = chunkQueries(pending, queriesPerRun);
        const stillPending = [];

        await Promise.all(
            chunks.map((chunk) =>
                run(async () => {
                    console.log(
                        `Searching (batched x${chunk.length}): ${chunk[0].slice(0, 60)}...`,
                    );
                    try {
                        const items = await withRetries(
                            async () => {
                                const actorRun = await client.actor(actorId).call({
                                    keyword: chunk.length === 1 ? chunk[0] : chunk,
                                    include_merged: includeMerged,
                                    limit: String(resultsPerQuery),
                                    tbs,
                                });
                                const { items: out } = await client
                                    .dataset(actorRun.defaultDatasetId)
                                    .listItems();
                                return out;
                            },
                            { attempts: 2, delayMs: 3000, label: `batch x${chunk.length}` },
                        );

                        if (!items || items.length === 0) {
                            throw new Error('batched run returned no items');
                        }

                        const { byQuery, unattributed } = attributeItems(items, chunk);
                        if (unattributed) {
                            console.warn(
                                'Batched items missing per-query echo; Search_Query column ' +
                                    'may be imprecise for this chunk.',
                            );
                        }
                        for (const [queryLower, queryItems] of byQuery) {
                            const original = chunk.find((q) => q.toLowerCase() === queryLower);
                            for (const result of extractQueryResults(queryItems)) {
                                const url = result.url || result.link || '';
                                if (!url) continue;
                                allBatched.push({ ...result, url, searchQuery: original });
                            }
                        }
                    } catch (error) {
                        console.warn(
                            `Batched SERP failed (${error.message}); ` +
                                'falling back to per-query mode for these and all later queries.',
                        );
                        batchSupported = false;
                        stillPending.push(...chunk);
                    }
                }),
            ),
        );
        pending = batchSupported ? [] : [...stillPending];
        if (batchSupported && allBatched.length > 0) {
            console.log(`Batched SERP mode ACTIVE (${queriesPerRun} queries/run).`);
        }
    }

    // ---- PER-QUERY MODE (default / fallback) --------------------------
    const perQuery = await Promise.all(
        pending.map((cleanQuery) =>
            run(async () => {
                console.log(`Searching: ${cleanQuery}`);
                try {
                    const { items } = await withRetries(
                        async () => {
                            const actorRun = await client.actor(actorId).call({
                                keyword: cleanQuery,
                                include_merged: includeMerged,
                                limit: String(resultsPerQuery),
                                tbs,
                            });
                            return client.dataset(actorRun.defaultDatasetId).listItems();
                        },
                        {
                            attempts: 3,
                            delayMs: 3000,
                            label: `query "${cleanQuery.slice(0, 40)}"`,
                        },
                    );
                    if (!items || items.length === 0) return [];

                    const merged = items.find(
                        (item) => item.page_number === 'all' || item.page === 'all',
                    );

                    let queryResults = [];
                    if (merged && Array.isArray(merged.results)) {
                        queryResults = merged.results;
                    } else {
                        for (const item of items) {
                            if (Array.isArray(item.results)) {
                                queryResults.push(...item.results);
                            }
                        }
                    }

                    const tagged = [];
                    for (const result of queryResults) {
                        const url = result.url || result.link || '';
                        if (!url) continue;
                        tagged.push({ ...result, url, searchQuery: cleanQuery });
                    }
                    return tagged;
                } catch (error) {
                    console.error(
                        `Failed Google query after retries: ${cleanQuery} | ${error.message}`,
                    );
                    failedQueries.push(cleanQuery);
                    return [];
                }
            }),
        ),
    );

    const allResults = [...allBatched, ...perQuery.flat()];

    const uniqueResults = [];
    const seen = new Set();
    for (const result of allResults) {
        const url = String(result.url || '').trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        uniqueResults.push(result);
    }

    console.log(`Google results: ${allResults.length} raw, ${uniqueResults.length} unique`);
    return { results: uniqueResults, failedQueries };
}
