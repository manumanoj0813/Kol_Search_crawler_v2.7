/**
 * Single source of truth for ALL date logic.
 *
 * Two consumers with different philosophies:
 *  - isCandidateResult(): permissive PRE-filter before page crawling.
 *    Unknown/unparseable dates pass, so the page crawler can try to
 *    find a real date. Saves crawl cost on definitely-old results.
 *  - filterRecentResults(): strict FINAL filter. No parseable date in
 *    the window => removed (precision over recall).
 */

import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParseFormat);

const STRICT_FORMATS = [
    'MMM D, YYYY',
    'MMMM D, YYYY',
    'MMM DD, YYYY',
    'MMMM DD, YYYY',
    'YYYY-MM-DD',
    'MM/DD/YYYY',
    'M/D/YYYY',
    'MM-DD-YYYY',
    'M-D-YYYY',
    'D MMM YYYY',
    'D MMMM YYYY',
];

/**
 * "3 days ago" -> 3, "today" -> 0, "2 weeks ago" -> 14,
 * "a month ago" -> 30, "5 hours ago" -> 0. Unknown -> null.
 */
export function relativeToDays(text) {
    const t = String(text || '')
        .trim()
        .toLowerCase();
    if (!t) return null;

    if (t === 'today' || t === 'just now') return 0;
    if (t === 'yesterday') return 1;
    if (/^(\d+)\s+(minute|minutes|hour|hours)\s+ago$/.test(t)) return 0;

    let m = t.match(/^(\d+)\s+days?\s+ago$/);
    if (m) return Number(m[1]);

    if (t === 'a week ago' || t === '1 week ago') return 7;
    m = t.match(/^(\d+)\s+weeks?\s+ago$/);
    if (m) return Number(m[1]) * 7;

    if (t === 'a month ago' || t === '1 month ago') return 30;
    m = t.match(/^(\d+)\s+months?\s+ago$/);
    if (m) return Number(m[1]) * 30;

    if (t === 'a year ago' || t === '1 year ago') return 365;
    m = t.match(/^(\d+)\s+years?\s+ago$/);
    if (m) return Number(m[1]) * 365;

    return null;
}

/** Parse an absolute date string. Returns a dayjs or null. */
export function parseAbsoluteDate(text) {
    const value = String(text || '').trim();
    if (!value) return null;

    // Loose first: handles ISO timestamps from meta tags.
    let parsed = dayjs(value);
    if (!parsed.isValid()) {
        parsed = dayjs(value, STRICT_FORMATS, true);
    }
    return parsed.isValid() ? parsed : null;
}

function inWindow(parsed, daysBack) {
    const cutoff = dayjs().startOf('day').subtract(Number(daysBack), 'day');
    // endOf('day') tolerates timezone-ahead meta timestamps.
    const upper = dayjs().endOf('day');
    return (
        (parsed.isAfter(cutoff) || parsed.isSame(cutoff, 'day')) &&
        (parsed.isBefore(upper) || parsed.isSame(upper))
    );
}

/** Upcoming-event horizon for Conference results (days ahead). */
export const EVENT_HORIZON_DAYS = 365;

/**
 * Date policy per activity class:
 *   strict          — Press / SMA / Other: parseable in-window date
 *                     required (the evergreen-junk guard).
 *   lenient-undated — Pubs / Trials: registry and publisher pages are
 *                     often dateless in SERPs; undated KEPT, dated
 *                     must be in-window.
 *   event           — Conference: undated KEPT, absolute dates
 *                     accepted out to EVENT_HORIZON_DAYS ahead.
 */
export function datePolicyFor(activityType) {
    if (activityType === 'Conference') return 'event';
    if (activityType === 'Pubs' || activityType === 'Trials') return 'lenient-undated';
    return 'strict';
}

function inEventWindow(parsed, daysBack) {
    const cutoff = dayjs().startOf('day').subtract(Number(daysBack), 'day');
    const horizon = dayjs().add(EVENT_HORIZON_DAYS, 'day').endOf('day');
    return (
        (parsed.isAfter(cutoff) || parsed.isSame(cutoff, 'day')) &&
        (parsed.isBefore(horizon) || parsed.isSame(horizon))
    );
}

/** Permissive pre-filter: only drop results that are DEFINITELY old. */
export function isCandidateResult(dateText, daysBack, activityType = 'Press') {
    if (!dateText) return true;

    const rel = relativeToDays(dateText);
    if (rel !== null) return rel <= Number(daysBack);

    const parsed = parseAbsoluteDate(dateText);
    if (!parsed) return true; // unknown format: let the page crawler decide

    if (datePolicyFor(activityType) === 'event') return inEventWindow(parsed, daysBack);
    return inWindow(parsed, daysBack);
}

/**
 * Strict final filter. PRESS results must carry a parseable in-window
 * date (evergreen-junk guard). EVENT results (CME / grand rounds /
 * faculty pages) get event semantics: undated pages KEPT, absolute
 * dates accepted from the recency cutoff out to EVENT_HORIZON_DAYS in
 * the future (event dates are announcements of upcoming activity),
 * stale past dates removed.
 */
export function filterRecentResults(results, daysBack = 7) {
    return results.filter((result) => {
        const publishedDate = String(result.publishedDate || '').trim();
        const policy = datePolicyFor(result.activityType);
        if (!publishedDate) {
            if (policy !== 'strict') {
                console.log(`KEEP - undated ${result.activityType} page: ${result.url || ''}`);
                return true;
            }
            console.log(`REMOVE - no published date: ${result.url || ''}`);
            return false;
        }

        const rel = relativeToDays(publishedDate);
        if (rel !== null) {
            const keep = rel <= Number(daysBack);
            console.log(`${keep ? 'KEEP' : 'REMOVE'} - ${publishedDate} - ${result.url || ''}`);
            return keep;
        }

        const parsed = parseAbsoluteDate(publishedDate);
        if (!parsed) {
            if (policy !== 'strict') {
                console.log(
                    `KEEP - ${result.activityType} page, unparseable date: ${publishedDate}`,
                );
                return true;
            }
            console.log(`REMOVE - unknown date format: ${publishedDate}`);
            return false;
        }

        const keep =
            policy === 'event' ? inEventWindow(parsed, daysBack) : inWindow(parsed, daysBack);
        console.log(`${keep ? 'KEEP' : 'REMOVE'} - ${publishedDate} - ${result.url || ''}`);
        return keep;
    });
}
