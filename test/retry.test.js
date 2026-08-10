import { describe, expect, it } from 'vitest';

import { withRetries, runInBatches } from '../src/retry.js';

describe('withRetries', () => {
    it('returns on first success', async () => {
        let calls = 0;
        const out = await withRetries(async () => {
            calls++;
            return 'ok';
        });
        expect(out).toBe('ok');
        expect(calls).toBe(1);
    });

    it('retries transient failures then succeeds', async () => {
        let calls = 0;
        const out = await withRetries(
            async () => {
                calls++;
                if (calls < 3) throw new Error('transient');
                return 'recovered';
            },
            { attempts: 3, delayMs: 1 },
        );
        expect(out).toBe('recovered');
        expect(calls).toBe(3);
    });

    it('throws the last error after exhausting attempts', async () => {
        let calls = 0;
        await expect(
            withRetries(
                async () => {
                    calls++;
                    throw new Error(`fail ${calls}`);
                },
                { attempts: 3, delayMs: 1 },
            ),
        ).rejects.toThrow('fail 3');
        expect(calls).toBe(3);
    });
});

describe('runInBatches', () => {
    it('preserves order and caps concurrency', async () => {
        let active = 0;
        let maxActive = 0;
        const out = await runInBatches([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return n * 10;
        });
        expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
        expect(maxActive).toBeLessThanOrEqual(3);
        expect(maxActive).toBeGreaterThan(1);
    });
});
