/**
 * Retry with linear backoff. A transient SERP-actor failure must not
 * silently cost a query's weekly coverage — that violates the
 * no-silent-degradation guarantee the weekly no-miss cadence rests on.
 */
export async function withRetries(fn, { attempts = 3, delayMs = 2000, label = 'operation' } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < attempts) {
                console.log(`Retry ${attempt}/${attempts - 1} for ${label}: ${error.message}`);
                await new Promise((r) => setTimeout(r, delayMs * attempt));
            }
        }
    }
    throw lastError;
}

/**
 * Process items in fixed-size concurrent batches, preserving order.
 * Used for KOL-level parallelism — safe because staging-tab writes
 * use the atomic values.append API.
 */
export async function runInBatches(items, batchSize, worker) {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const settled = await Promise.all(batch.map((item, j) => worker(item, i + j)));
        results.push(...settled);
    }
    return results;
}

/**
 * Minimal promise-pool limiter: at most `max` wrapped calls in
 * flight at once, shared across all callers (used to cap concurrent
 * scraperlink actor runs against the Apify account limit).
 */
export function createLimiter(max) {
    let active = 0;
    const waiting = [];

    const next = () => {
        if (active >= max || waiting.length === 0) return;
        active += 1;
        const { fn, resolve, reject } = waiting.shift();
        fn()
            .then(resolve, reject)
            .finally(() => {
                active -= 1;
                next();
            });
    };

    return (fn) =>
        new Promise((resolve, reject) => {
            waiting.push({ fn, resolve, reject });
            next();
        });
}
