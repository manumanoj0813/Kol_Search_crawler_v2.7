import { describe, expect, it } from 'vitest';

import { detectPlatform } from '../src/platformDetector.js';

describe('detectPlatform', () => {
    it('detects exact platform domains', () => {
        expect(detectPlatform('https://x.com/some/post')).toBe('X');
        expect(detectPlatform('https://twitter.com/user')).toBe('X');
        expect(detectPlatform('https://www.linkedin.com/in/someone')).toBe('LinkedIn');
        expect(detectPlatform('https://youtu.be/abc')).toBe('YouTube');
    });

    it('detects subdomains', () => {
        expect(detectPlatform('https://mobile.x.com/post')).toBe('X');
        expect(detectPlatform('https://m.facebook.com/page')).toBe('Facebook');
    });

    it('does NOT match substring lookalikes (the genedx bug)', () => {
        expect(detectPlatform('https://www.genedx.com/tests')).toBe('Website');
        expect(detectPlatform('https://xerox.com')).toBe('Website');
        expect(detectPlatform('https://notx.com')).toBe('Website');
    });

    it('falls back to Website for invalid input', () => {
        expect(detectPlatform('')).toBe('Website');
        expect(detectPlatform('not a url')).toBe('Website');
    });
});
