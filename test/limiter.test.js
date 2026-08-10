import { describe, expect, it } from 'vitest';

import { createLimiter } from '../src/retry.js';
import { looksLikeSuffix } from '../src/googleSheets.js';

describe('createLimiter', () => {
    it('never exceeds max in-flight and completes everything', async () => {
        const limit = createLimiter(3);
        let active = 0;
        let peak = 0;
        const job = () =>
            limit(async () => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise((r) => setTimeout(r, 10));
                active -= 1;
                return true;
            });
        const out = await Promise.all(Array.from({ length: 12 }, job));
        expect(out).toHaveLength(12);
        expect(peak).toBeLessThanOrEqual(3);
    });

    it('propagates rejections without stalling the pool', async () => {
        const limit = createLimiter(2);
        const good = limit(async () => 'ok');
        const bad = limit(async () => {
            throw new Error('boom');
        });
        await expect(bad).rejects.toThrow('boom');
        await expect(good).resolves.toBe('ok');
        await expect(limit(async () => 'after')).resolves.toBe('after');
    });
});

describe('looksLikeSuffix (wrong-column guard)', () => {
    it('flags credential strings', () => {
        expect(looksLikeSuffix('MD, MBA, MS, FACS, FRCS')).toBe(true);
        expect(looksLikeSuffix('MD,PhD')).toBe(false); // PhD not all-caps
        expect(looksLikeSuffix('MD, FAAN, FAES')).toBe(true);
    });

    it('never flags real affiliations', () => {
        expect(looksLikeSuffix("Cook Children's Health Care System")).toBe(false);
        expect(looksLikeSuffix('Mayo Clinic')).toBe(false);
        expect(looksLikeSuffix('IU School of Medicine')).toBe(false);
        expect(looksLikeSuffix('UCB')).toBe(true); // all-caps single token: flagged, by design
    });
});
