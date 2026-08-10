import { describe, expect, it } from 'vitest';

import { filterResults, normalizeUrl } from '../src/resultFilter.js';

const r = (url) => ({ url, title: 't' });

describe('normalizeUrl', () => {
    it('strips tracking params and trailing slash', () => {
        expect(normalizeUrl('https://ex.com/a/?utm_source=x&id=1')).toBe('https://ex.com/a?id=1');
    });
});

describe('filterResults', () => {
    it('dedupes URLs that normalize identically', () => {
        const out = filterResults([r('https://ex.com/a?utm_source=tw'), r('https://ex.com/a/')]);
        expect(out).toHaveLength(1);
    });

    it('blocks directory domains and their subdomains', () => {
        expect(filterResults([r('https://www.healthgrades.com/physician/x')])).toHaveLength(0);
        expect(filterResults([r('https://es.doximity.com/pub/x')])).toHaveLength(0);
    });

    it('blocks directory paths but not the rest of the domain', () => {
        expect(filterResults([r('https://www.webmd.com/doctor/john-smith')])).toHaveLength(0);
        expect(
            filterResults([r('https://www.webmd.com/multiple-sclerosis/news/some-article')]),
        ).toHaveLength(1);
    });

    it('does not substring-block lookalikes', () => {
        // md.com is blocked; webmd.com news is not (previous test) and
        // genedx.com must survive despite containing "x.com".
        expect(filterResults([r('https://md.com/profile/x')])).toHaveLength(0);
        expect(filterResults([r('https://www.genedx.com/news')])).toHaveLength(1);
    });

    it('drops PDFs, google cache, and search links', () => {
        expect(filterResults([r('https://ex.com/paper.pdf')])).toHaveLength(0);
        expect(filterResults([r('https://webcache.googleusercontent.com/x')])).toHaveLength(0);
        expect(filterResults([r('https://google.com/search?q=x')])).toHaveLength(0);
    });
});

// (author derivation lives in resultProcessor; grouped here to keep suites lean)
