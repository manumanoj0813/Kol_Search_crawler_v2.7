import { describe, expect, it } from 'vitest';

import { cleanKolName, generateQueries } from '../src/queryGenerator.js';

describe('cleanKolName', () => {
    it('strips Dr. prefix and comma credentials', () => {
        expect(cleanKolName('Dr. John A. Smith, MD, PhD')).toBe('John A. Smith');
    });

    it('strips trailing credentials without commas', () => {
        expect(cleanKolName('Jane Doe MD FACC')).toBe('Jane Doe');
        expect(cleanKolName('Robert Paul Jones MSN APRN')).toBe('Robert Paul Jones');
    });

    it('strips comma suffixes like Jr / III', () => {
        expect(cleanKolName('Bertrand Marquess Anz, III')).toBe('Bertrand Marquess Anz');
        expect(cleanKolName('Dennis F Moore, Jr')).toBe('Dennis F Moore');
    });

    it('does NOT strip credential-lookalike SURNAMES (case gate)', () => {
        expect(cleanKolName('Hai C Do')).toBe('Hai C Do');
        expect(cleanKolName('Cynthia Xiuguang Ma')).toBe('Cynthia Xiuguang Ma');
        expect(cleanKolName('Yuen Tat So')).toBe('Yuen Tat So');
    });

    it('strips the same tokens when written UPPERCASE', () => {
        expect(cleanKolName('John Alan Smith DO')).toBe('John Alan Smith');
        expect(cleanKolName('Jane Ann Doe PhD')).toBe('Jane Ann Doe');
    });

    it('strips parentheticals from the base name', () => {
        expect(cleanKolName('Benjamin (Ben) Joseph Osborne')).toBe('Benjamin Joseph Osborne');
        expect(cleanKolName('Ericka Portley Greene (Simpson)')).toBe('Ericka Portley Greene');
    });

    it('leaves Last, First order untouched', () => {
        expect(cleanKolName('Smith, John')).toBe('Smith, John');
    });

    it('never strips below two tokens', () => {
        expect(cleanKolName('John MD')).toBe('John MD');
    });

    it('handles empty input', () => {
        expect(cleanKolName('')).toBe('');
        expect(cleanKolName(null)).toBe('');
    });
});

describe('generateQueries — name variants', () => {
    it('returns exactly 6 clustered queries', () => {
        expect(generateQueries('John A Smith')).toHaveLength(6);
    });

    it('events/faculty cluster carries CME, grand rounds, faculty, speaker', () => {
        const q = generateQueries('John Smith')[5];
        for (const t of ['"grand rounds"', 'CME', 'faculty', 'speaker', 'webinar', 'symposium']) {
            expect(q).toContain(t);
        }
    });

    it('quotes name variants and dedupes them', () => {
        const [broad] = generateQueries('John A Smith');
        expect(broad).toContain('"John A Smith"');
        expect(broad).toContain('"John Smith"');
        expect(broad.match(/"John/g)).toHaveLength(2);
    });

    it('builds full + short + initial variants for full middle names', () => {
        const [broad] = generateQueries('Jennifer Anne Linehan');
        expect(broad).toContain('"Jennifer Anne Linehan"');
        expect(broad).toContain('"Jennifer Linehan"');
        expect(broad).toContain('"Jennifer A Linehan"');
    });

    it('adds a nickname variant for "First (Nick) ... Last"', () => {
        const [broad] = generateQueries('Benjamin (Ben) Joseph Osborne');
        expect(broad).toContain('"Ben Osborne"');
        expect(broad).toContain('"Benjamin Joseph Osborne"');
        expect(broad).toContain('"Benjamin Osborne"');
    });

    it('adds an alternate-surname variant for trailing "(Surname)"', () => {
        const [broad] = generateQueries('Ericka Portley Greene (Simpson)');
        expect(broad).toContain('"Ericka Simpson"');
        expect(broad).toContain('"Ericka Greene"');
    });

    it('handles maiden name just before the last name', () => {
        const [broad] = generateQueries('Amanda Lee (Rowlands) Piquet');
        expect(broad).toContain('"Amanda Rowlands"');
        expect(broad).toContain('"Amanda Piquet"');
    });

    it('handles DOUBLE parentheticals (real roster case)', () => {
        const [broad] = generateQueries('Ghulam Rehman (Manni) Mohy-Ud-Din (Mohyuddin)');
        expect(broad).toContain('"Ghulam Mohyuddin"');
        expect(broad).toContain('"Ghulam Mohy-Ud-Din"');
    });

    it('treats a multi-word trailing paren as a standalone alternate name', () => {
        const [broad] = generateQueries('Carlyn Rose Co Tan (Chun-Pin Chen)');
        expect(broad).toContain('"Chun-Pin Chen"');
        expect(broad).toContain('"Carlyn Tan"');
    });

    it('caps the affiliation anchor at its first 6 words on every query', () => {
        const queries = generateQueries(
            'John Smith',
            'University of Maryland Marlene and Stewart Greenebaum Comprehensive Cancer Center',
        );
        for (const q of queries) {
            expect(q).toContain('"University of Maryland Marlene and Stewart"');
            expect(q).not.toContain('Greenebaum');
        }
    });

    it('handles DOUBLE-QUOTED nicknames (second roster convention)', () => {
        const [broad] = generateQueries('Jijun "Jane" Liu');
        expect(broad).toContain('"Jijun Liu"');
        expect(broad).toContain('"Jane Liu"');
    });

    it('keeps particle surnames whole (Van Horne, not Horne)', () => {
        const [broad] = generateQueries('Bethanie "Beth" Shannon Van Horne');
        expect(broad).toContain('"Bethanie Van Horne"');
        expect(broad).toContain('"Beth Van Horne"');
        expect(broad).not.toContain('"Bethanie Horne"');
    });

    it('does not misread a particle-like FIRST name', () => {
        const [broad] = generateQueries('Van Minh Nguyen');
        expect(broad).toContain('"Van Nguyen"');
    });

    it('ignores single-letter parentheticals', () => {
        const [broad] = generateQueries('Ghazala S (R) Hayat');
        expect(broad).not.toContain('"Ghazala R"');
        expect(broad).toContain('"Ghazala S Hayat"');
    });

    it('never emits a parenthesis inside a quoted phrase', () => {
        for (const q of generateQueries('Benjamin (Ben) Joseph Osborne')) {
            const phrases = q.match(/"[^"]*"/g) || [];
            for (const phrase of phrases) {
                expect(phrase).not.toMatch(/[()]/);
            }
        }
    });

    it('cleans credentials before building name variants', () => {
        const [broad] = generateQueries('Dr. Jane Doe, MD');
        expect(broad).not.toMatch(/"MD /);
        expect(broad).toContain('"Jane Doe"');
    });

    it('returns [] for empty names', () => {
        expect(generateQueries('')).toEqual([]);
    });
});

describe('generateQueries — clusters (corpus-validated terms)', () => {
    it('includes the honorific group on every query', () => {
        for (const q of generateQueries('John Smith')) {
            expect(q).toContain('(MD OR Dr OR PhD)');
        }
    });

    it('quotes cluster gained "noted"', () => {
        const q = generateQueries('John Smith')[1];
        expect(q).toContain('noted');
        expect(q).toContain('"according to"');
    });

    it('conference cluster uses bare "presented" (dominates "presented at")', () => {
        const q = generateQueries('John Smith')[2];
        expect(q).toContain('presented');
        expect(q).toContain('presentation');
        expect(q).not.toContain('"presented at"');
        expect(q).not.toMatch(/\bpresents\b/);
    });

    it('press cluster swapped dead terms for award/recognized/grant', () => {
        const q = generateQueries('John Smith')[3];
        for (const t of ['award', 'recognized', 'grant', 'announced', '"press release"']) {
            expect(q).toContain(t);
        }
        expect(q).not.toContain('appointed');
        expect(q).not.toMatch(/\bjoins\b/);
    });

    it('publication cluster uses bare "published" and adds "research"', () => {
        const q = generateQueries('John Smith')[4];
        expect(q).toContain('published');
        expect(q).toContain('research');
        expect(q).not.toContain('"published in"');
    });

    it('ANCHORED MODE: affiliation applies to ALL six queries', () => {
        const queries = generateQueries('John Smith', 'Medical College of Wisconsin');
        expect(queries).toHaveLength(6);
        for (const q of queries) {
            expect(q).toContain('"Medical College of Wisconsin"');
        }
    });

    it('ANCHORED MODE: name expression trims to full + short', () => {
        const [broad] = generateQueries('Michael Scott Perry', "Cook Children's");
        expect(broad).toContain('"Michael Scott Perry"');
        expect(broad).toContain('"Michael Perry"');
        expect(broad).not.toContain('"Michael S Perry"');
        expect(broad).toContain('"Cook Children\'s"'.replace('\\', ''));
    });

    it('UNANCHORED: no affiliation, full variant set, no anchor text', () => {
        const queries = generateQueries('Michael Scott Perry');
        expect(queries[0]).toContain('"Michael S Perry"');
        for (const q of queries) {
            expect(q).not.toContain('Cook');
        }
    });

    it('strips quotes and parens from the affiliation', () => {
        const [broad] = generateQueries('John Smith', 'Mayo "Clinic" (Rochester)');
        expect(broad).toContain('"Mayo Clinic Rochester"');
    });

    it('stays under 32 words: anchored worst case (4-token name, 6-word affiliation)', () => {
        const queries = generateQueries(
            'Christopher Alexander Jonathan Montgomery',
            'University of Maryland Marlene and Stewart Greenebaum Comprehensive Cancer Center',
        );
        for (const q of queries) {
            expect(q.split(/\s+/).length).toBeLessThanOrEqual(32);
        }
    });

    it('stays under 32 words: unanchored double-paren worst case', () => {
        const queries = generateQueries('Christopher (Chris) Alexander Montgomery (Fitzgerald)');
        for (const q of queries) {
            expect(q.split(/\s+/).length).toBeLessThanOrEqual(32);
        }
    });
});
