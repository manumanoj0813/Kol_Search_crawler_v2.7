import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import {
    relativeToDays,
    parseAbsoluteDate,
    isCandidateResult,
    filterRecentResults,
} from '../src/dateFilter.js';

describe('relativeToDays', () => {
    it('parses simple relatives', () => {
        expect(relativeToDays('today')).toBe(0);
        expect(relativeToDays('Yesterday')).toBe(1);
        expect(relativeToDays('3 days ago')).toBe(3);
        expect(relativeToDays('5 hours ago')).toBe(0);
    });

    it('parses weeks/months/years', () => {
        expect(relativeToDays('2 weeks ago')).toBe(14);
        expect(relativeToDays('a month ago')).toBe(30);
        expect(relativeToDays('3 years ago')).toBe(1095);
    });

    it('returns null for unknown text', () => {
        expect(relativeToDays('Conference 2026')).toBeNull();
    });
});

describe('isCandidateResult (permissive pre-filter)', () => {
    it('passes unknown/empty dates through to the crawler', () => {
        expect(isCandidateResult('', 7)).toBe(true);
        expect(isCandidateResult('some junk', 7)).toBe(true);
    });

    it('drops definitely-old relatives', () => {
        expect(isCandidateResult('2 weeks ago', 7)).toBe(false);
        expect(isCandidateResult('3 days ago', 7)).toBe(true);
    });

    it('respects daysBack=0 (today only)', () => {
        expect(isCandidateResult('today', 0)).toBe(true);
        expect(isCandidateResult('yesterday', 0)).toBe(false);
    });
});

describe('filterRecentResults (strict final filter)', () => {
    it('removes undated results', () => {
        expect(filterRecentResults([{ publishedDate: '', url: 'u' }], 7)).toHaveLength(0);
    });

    it('keeps in-window absolute dates, removes old ones', () => {
        const recent = dayjs().subtract(2, 'day').format('MMM D, YYYY');
        const old = dayjs().subtract(30, 'day').format('MMM D, YYYY');
        const out = filterRecentResults(
            [
                { publishedDate: recent, url: 'a' },
                { publishedDate: old, url: 'b' },
            ],
            7,
        );
        expect(out.map((r) => r.url)).toEqual(['a']);
    });

    it('removes future dates beyond today', () => {
        const future = dayjs().add(10, 'day').format('YYYY-MM-DD');
        expect(filterRecentResults([{ publishedDate: future, url: 'f' }], 7)).toHaveLength(0);
    });

    it('handles ISO timestamps from meta tags', () => {
        const iso = dayjs().subtract(1, 'day').toISOString();
        expect(filterRecentResults([{ publishedDate: iso, url: 'i' }], 7)).toHaveLength(1);
    });
});

describe('per-class date policy', () => {
    it('Conference keeps undated; Press/SMA/Other undated removed', () => {
        const out = filterRecentResults(
            [
                { publishedDate: '', url: 'c', activityType: 'Conference' },
                { publishedDate: '', url: 'p', activityType: 'Press' },
                { publishedDate: '', url: 's', activityType: 'SMA' },
                { publishedDate: '', url: 'o', activityType: 'Other' },
            ],
            7,
        );
        expect(out.map((r) => r.url)).toEqual(['c']);
    });

    it('Pubs/Trials keep undated pages (registry/publisher pattern)', () => {
        const out = filterRecentResults(
            [
                { publishedDate: '', url: 'pub', activityType: 'Pubs' },
                { publishedDate: '', url: 'tr', activityType: 'Trials' },
            ],
            7,
        );
        expect(out.map((r) => r.url)).toEqual(['pub', 'tr']);
    });

    it('Conference accepts FUTURE dates in horizon, rejects 2-years-out', () => {
        const soon = dayjs().add(3, 'month').format('MMM D, YYYY');
        const far = dayjs().add(24, 'month').format('MMM D, YYYY');
        const out = filterRecentResults(
            [
                { publishedDate: soon, url: 'soon', activityType: 'Conference' },
                { publishedDate: far, url: 'far', activityType: 'Conference' },
            ],
            7,
        );
        expect(out.map((r) => r.url)).toEqual(['soon']);
    });

    it('Pubs dated must be in-window (no future leniency)', () => {
        const future = dayjs().add(2, 'month').format('YYYY-MM-DD');
        const old = dayjs().subtract(60, 'day').format('YYYY-MM-DD');
        const recent = dayjs().subtract(2, 'day').format('YYYY-MM-DD');
        const out = filterRecentResults(
            [
                { publishedDate: future, url: 'f', activityType: 'Pubs' },
                { publishedDate: old, url: 'o', activityType: 'Pubs' },
                { publishedDate: recent, url: 'r', activityType: 'Pubs' },
            ],
            7,
        );
        expect(out.map((r) => r.url)).toEqual(['r']);
    });

    it('isCandidateResult respects class policy in the pre-filter', () => {
        const soon = dayjs().add(2, 'month').format('YYYY-MM-DD');
        expect(isCandidateResult(soon, 7, 'Conference')).toBe(true);
        expect(isCandidateResult(soon, 7, 'Press')).toBe(false);
    });
});

describe('parseAbsoluteDate', () => {
    it('parses house formats', () => {
        expect(parseAbsoluteDate('Aug 5, 2026')).not.toBeNull();
        expect(parseAbsoluteDate('2026-08-05')).not.toBeNull();
        expect(parseAbsoluteDate('8/5/2026')).not.toBeNull();
    });

    it('rejects garbage', () => {
        expect(parseAbsoluteDate('press release')).toBeNull();
    });
});
