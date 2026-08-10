import { describe, expect, it } from 'vitest';

import { deriveSocialAuthor, processSerpResults } from '../src/resultProcessor.js';

describe('deriveSocialAuthor', () => {
    it('takes the poster name before a pipe', () => {
        expect(
            deriveSocialAuthor(
                'https://www.instagram.com/p/DbieNDME6OV/',
                "Cassie Shields | And that's a wrap on the 2026 World TSC Conference",
                'Instagram',
            ),
        ).toBe('Cassie Shields');
    });

    it('parses "X on Instagram" titles', () => {
        expect(
            deriveSocialAuthor(
                'https://instagram.com/p/x/',
                'AACP on Instagram: "When I chose..."',
                'Instagram',
            ),
        ).toBe('AACP');
    });

    it('falls back to the facebook page slug', () => {
        expect(
            deriveSocialAuthor(
                'https://www.facebook.com/autismsciencefd/posts/congratulations',
                'Congratulations to the Broad Institute of MIT and Harvard',
                'Facebook',
            ),
        ).toBe('autismsciencefd');
    });

    it('never fires for websites and ignores platform-word pipes', () => {
        expect(deriveSocialAuthor('https://news.com/a', 'Cassie Shields | story', 'Website')).toBe(
            '',
        );
        expect(
            deriveSocialAuthor(
                'https://facebook.com/watch/x/',
                'Facebook Watch | video',
                'Facebook',
            ),
        ).toBe('');
    });

    it('is applied by processSerpResults when SERP author is empty', () => {
        const [r] = processSerpResults({ kolId: 'K', kolName: 'Elizabeth Anne Thiele' }, [
            { url: 'https://www.instagram.com/p/x/', title: 'Cassie Shields | wrap', snippet: '' },
        ]);
        expect(r.author).toBe('Cassie Shields');
    });
});
