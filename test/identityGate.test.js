import { describe, expect, it } from 'vitest';

import {
    assessIdentity,
    affiliationTokens,
    specialtyStems,
    hasTitledName,
} from '../src/identityGate.js';

const kolPatel = {
    kolName: 'Anup Dilip Patel',
    affiliation: "Nationwide Children's Hospital",
    specialty: 'Pediatric Neurology',
};
const kolPerry = {
    kolName: 'Michael Scott Perry',
    affiliation: "Cook Children's",
    specialty: 'Pediatric Neurology',
};

describe('assessIdentity', () => {
    it('full-name ALONE is not enough — non-medical page goes to REVIEW', () => {
        const out = assessIdentity({
            result: {
                title: 'Anup Dilip Patel and partner celebrate wedding',
                description: 'The couple met in college',
            },
            kol: kolPatel,
        });
        expect(out.verdict).toBe('REVIEW');
        expect(out.signals).toBe('no-medical-context');
    });

    it('VALID on full-name + specialty evidence', () => {
        const out = assessIdentity({
            result: { title: 'Interview with Anup Dilip Patel', description: '' },
            kol: kolPatel,
            pageText: 'The pediatric neurologist discussed new seizure protocols.',
        });
        expect(out.verdict).toBe('VALID');
        expect(out.signals).toBe('full-name+specialty');
    });

    it('VALID on short name + affiliation token', () => {
        const out = assessIdentity({
            result: {
                title: 'Anup Patel discusses seizure care',
                description: 'A Nationwide expert weighs in',
            },
            kol: kolPatel,
        });
        expect(out.verdict).toBe('VALID');
        expect(out.signals).toContain('affiliation');
    });

    it('VALID on short name + specialty stem in crawled body', () => {
        const out = assessIdentity({
            result: { title: 'Anup Patel on new findings', description: '' },
            kol: kolPatel,
            pageText: 'The pediatric neurologist explained the results in detail.',
        });
        expect(out.verdict).toBe('VALID');
        expect(out.signals).toContain('specialty');
    });

    it('REVIEW on the knee-surgery wrong-person page (short name, no signals)', () => {
        const out = assessIdentity({
            result: {
                title: 'Surgical Expertise and Innovative Treatment',
                description:
                    'Twenty-year Navy veteran Michael Perry got his life back after knee replacement',
            },
            kol: kolPerry,
            pageText: 'After years of knee pain the veteran returned to hiking.',
        });
        expect(out.verdict).toBe('REVIEW');
        expect(out.signals).toBe('short-name-only');
    });

    it('REVIEW when the name is not visible anywhere we can see', () => {
        const out = assessIdentity({
            result: { title: 'A YouTube channel', description: 'village shorts' },
            kol: kolPatel,
        });
        expect(out.verdict).toBe('REVIEW');
        expect(out.signals).toBe('name-not-visible');
    });

    it('alternate-name extras count as strong forms (with medical evidence)', () => {
        const out = assessIdentity({
            result: { title: 'Ghulam Mohyuddin, MD, shares myeloma insights', description: '' },
            kol: { kolName: 'Ghulam Rehman (Manni) Mohy-Ud-Din (Mohyuddin)' },
        });
        expect(out.verdict).toBe('VALID');
        expect(out.signals).toContain('full-name');
        expect(out.signals).toContain('titled-name');
    });
});

describe('roster suffix', () => {
    it('suffix-match is a strong signal: page degree matches roster', () => {
        const out = assessIdentity({
            result: {
                title: 'Epilepsy panel',
                description: 'Anup Patel, MD, FAAN answered questions',
            },
            kol: { kolName: 'Anup Dilip Patel', suffix: 'MD, FAAN, FAES' },
        });
        expect(out.verdict).toBe('VALID');
        expect(out.signals).toContain('suffix-match');
    });

    it('roster subset on page still matches (MD alone vs "MD, PhD")', () => {
        const out = assessIdentity({
            result: { title: 'Elizabeth Thiele, MD discusses TSC', description: '' },
            kol: { kolName: 'Elizabeth Anne Thiele', suffix: 'MD, PhD' },
        });
        expect(out.verdict).toBe('VALID');
        expect(out.signals).toContain('suffix-match');
    });

    it('suffix-CONFLICT demotes to REVIEW: roster MD, page DO', () => {
        const out = assessIdentity({
            result: {
                title: 'Heart care in Detroit',
                description: 'Dr Michael Perry DO of the Heart and Vascular Institute',
            },
            kol: { kolName: 'Michael Scott Perry', suffix: 'MD' },
        });
        expect(out.verdict).toBe('REVIEW');
        expect(out.signals).toBe('suffix-conflict:do');
    });

    it('non-primary degrees never conflict (roster MD, page PhD)', () => {
        const out = assessIdentity({
            result: { title: 'Ingo Helbig, PhD presents genetics findings', description: '' },
            kol: { kolName: 'Ingo Helbig', suffix: 'MD', specialty: 'Neurology' },
        });
        expect(out.verdict).toBe('VALID');
    });

    it('empty suffix keeps prior behavior', () => {
        const out = assessIdentity({
            result: { title: 'Panel', description: 'Dr. Michael Perry answered questions' },
            kol: { kolName: 'Michael Scott Perry', suffix: '' },
        });
        expect(out.verdict).toBe('VALID');
        expect(out.signals).toContain('titled-name');
    });
});

describe('token helpers', () => {
    it('drops generic affiliation words, keeps distinctive ones', () => {
        const tokens = affiliationTokens("Nationwide Children's Hospital");
        expect(tokens).toContain('nationwide');
        expect(tokens).not.toContain('hospital');
        expect(tokens).not.toContain('childrens');
    });

    it('stems specialties for inflection matching', () => {
        expect(specialtyStems('Pediatric Neurology')).toContain('neurolo');
    });
});
