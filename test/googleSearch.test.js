import { describe, expect, it } from 'vitest';

import { attributeItems, chunkQueries } from '../src/googleSearch.js';

describe('chunkQueries', () => {
    it('packs into chunks with remainder', () => {
        const chunks = chunkQueries(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 6);
        expect(chunks).toEqual([['a', 'b', 'c', 'd', 'e', 'f'], ['g']]);
    });
    it('size 1 keeps per-query behaviour and drops empties', () => {
        expect(chunkQueries(['a', '', 'b'], 1)).toEqual([['a'], ['b']]);
    });
});

describe('attributeItems', () => {
    const chunk = ['q one', 'q two'];
    it('routes by keyword echo, case-insensitive', () => {
        const { byQuery, unattributed } = attributeItems(
            [
                { keyword: 'Q ONE', results: [{ url: 'u1' }] },
                { query: 'q two', results: [{ url: 'u2' }] },
            ],
            chunk,
        );
        expect(byQuery.get('q one')[0].results[0].url).toBe('u1');
        expect(byQuery.get('q two')[0].results[0].url).toBe('u2');
        expect(unattributed).toBe(false);
    });
    it('single-query chunks attribute even without echo', () => {
        const { byQuery, unattributed } = attributeItems([{ results: [{ url: 'u' }] }], ['only']);
        expect(byQuery.get('only')).toHaveLength(1);
        expect(unattributed).toBe(false);
    });
    it('multi-query chunks without echo flag imprecision but keep results', () => {
        const { byQuery, unattributed } = attributeItems([{ results: [{ url: 'u' }] }], chunk);
        expect(unattributed).toBe(true);
        expect(byQuery.get('q one')).toHaveLength(1);
    });
});
