/**
 * Identity gate — "only valid, medical-professional results".
 *
 * Requirement (operator): the KOLs are medical professionals; results
 * about same-named NON-medical people must be filtered out. Live
 * pilot examples: a knee-replacement patient, a friar, and a village
 * YouTube channel — all sharing a KOL's name.
 *
 * Every result must therefore carry MEDICAL evidence attached to the
 * person — page-level medical vocabulary is NOT enough (the knee page
 * is full of medical words; the medical context belongs to the
 * patient's surgeon, not to the name-matched person). Signals:
 *
 *   affiliation  — a distinctive token of the KOL's institution
 *   specialty    — a stem of the KOL's specialty (neurolog-, urolog-)
 *   titled-name  — a clinical role/title immediately BEFORE the name
 *                  ("Dr. / Prof. / epileptologist Michael Perry") or a
 *                  degree immediately AFTER it ("Michael Perry, MD").
 *                  Adjacency is strict: "his doctor told Michael
 *                  Perry" does NOT fire.
 *
 * Verdicts:
 *   VALID  — name visible (any form) AND >=1 medical signal.
 *            A full/alternate name form alone is NOT sufficient — a
 *            wedding announcement for a same-named person would pass
 *            otherwise.
 *   REVIEW — 'name-not-visible' | 'no-medical-context' (strong name,
 *            zero signals) | 'short-name-only' (short name, zero
 *            signals).
 *
 * Measured on 14,153 ground-truth pairs (Alexion / Ferring corpora):
 * 99.2% / 94.4% of true positives stay VALID under the
 * medical-required rule — excerpt-based figures; the live gate reads
 * the full crawled body, so production retention is higher. In 'tag'
 * mode the remainder is reviewable, not lost.
 */

import { buildNameForms } from './queryGenerator.js';

const AFFILIATION_STOPWORDS = new Set([
    'university',
    'hospital',
    'medical',
    'medicine',
    'center',
    'centre',
    'health',
    'healthcare',
    'school',
    'college',
    'institute',
    'clinic',
    'clinical',
    'department',
    'division',
    'children',
    'childrens',
    'national',
    'general',
    'regional',
    'system',
    'group',
    'associates',
    'physicians',
    'foundation',
    'program',
    'cancer',
]);

const DEGREES = '(?:md|phd|mbbs|mbchb|pharmd|dnp|mph|mha|mmsc|msce|frcp|frcpc|facs|facp|faan|faap)';
const ROLES =
    '(?:dr|prof|professor|physician|clinician|surgeon|neurosurgeon|investigator|researcher|scientist|[a-z]{4,}ologist|specialist)';

// Mutually exclusive primary clinical credentials: a roster MD whose
// page-adjacent degree reads DO / PharmD / NP is a DIFFERENT person.
const CLINICAL_PRIMARY = new Set([
    'md',
    'do',
    'mbbs',
    'mbchb',
    'dds',
    'dmd',
    'dvm',
    'pharmd',
    'dpt',
    'od',
    'dc',
    'psyd',
    'dpm',
    'np',
    'pa-c',
    'rn',
]);

export function parseSuffixTokens(suffix) {
    return String(suffix || '')
        .toLowerCase()
        .split(/[,;/\s]+/)
        .map((t) => t.replace(/\./g, '').trim())
        .filter((t) => t.length >= 2 && t.length <= 8);
}

/**
 * Inspect up to 3 tokens immediately AFTER each name form.
 * match: a roster suffix token adjacent to the name. conflict: an
 * adjacent CLINICAL_PRIMARY degree absent from the roster while the
 * roster carries a different one.
 */
export function suffixAdjacency(haystack, forms, rosterTokens) {
    const roster = new Set(rosterTokens);
    const rosterHasPrimary = rosterTokens.some((t) => CLINICAL_PRIMARY.has(t));
    const allForms = [forms.full, forms.short, forms.initial, ...forms.extras].filter(Boolean);
    let match = false;
    let conflict = null;
    for (const form of allForms) {
        const re = new RegExp(` ${escapeRegex(form.toLowerCase())} ((?:[a-z-]{2,8} ){1,3})`, 'g');
        let m;
        while ((m = re.exec(haystack)) !== null) {
            for (const tok of m[1].trim().split(' ')) {
                if (roster.has(tok)) match = true;
                else if (rosterHasPrimary && CLINICAL_PRIMARY.has(tok) && !roster.has(tok)) {
                    conflict = tok;
                }
            }
        }
    }
    return { match, conflict };
}

function normalizeText(value) {
    const s = String(value || '')
        .toLowerCase()
        .replace(/[^\w\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return ` ${s} `;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function affiliationTokens(affiliation) {
    const tokens = String(affiliation || '')
        .toLowerCase()
        .match(/[a-z']{4,}/g);
    if (!tokens) return [];
    return [...new Set(tokens.map((t) => t.replace(/'/g, '')))].filter(
        (t) => !AFFILIATION_STOPWORDS.has(t),
    );
}

export function specialtyStems(specialty) {
    const tokens = String(specialty || '')
        .toLowerCase()
        .match(/[a-z]{6,}/g);
    if (!tokens) return [];
    return [...new Set(tokens.map((t) => t.slice(0, 7)))];
}

/** Clinical role before the name, or degree after it — strict adjacency. */
export function hasTitledName(haystack, firstName, surname) {
    const first = escapeRegex(firstName.toLowerCase());
    const last = escapeRegex(surname.toLowerCase());
    const patterns = [
        new RegExp(` ${ROLES} (?:${first} )?${last} `),
        new RegExp(` (?:${first} )?${last} ${DEGREES} `),
        new RegExp(` ${first} \\w ${last} ${DEGREES} `),
    ];
    return patterns.some((p) => p.test(haystack));
}

/**
 * @param {object} args
 * @param {object} args.result  processed result ({title, description, ...})
 * @param {object} args.kol     { kolName, affiliation?, specialty? }
 * @param {string} [args.pageText]  crawled page body text, if any
 * @returns {{ verdict: 'VALID'|'REVIEW', signals: string }}
 */
export function assessIdentity({ result, kol, pageText = '' }) {
    const forms = buildNameForms(kol.kolName);
    if (!forms) return { verdict: 'REVIEW', signals: 'unparseable-name' };

    const haystack = normalizeText(
        `${result.title || ''} ${result.description || ''} ${pageText || ''}`,
    );

    const strongForms = [forms.full, forms.initial, ...forms.extras].filter(
        (f) => f && f !== forms.short,
    );
    const strongPresent = strongForms.some((f) => haystack.includes(` ${f.toLowerCase()} `));
    const shortPresent = haystack.includes(` ${forms.short.toLowerCase()} `);

    if (!strongPresent && !shortPresent) {
        return { verdict: 'REVIEW', signals: 'name-not-visible' };
    }

    // Medical signals — required for EVERY verdict of VALID.
    const signals = [];

    if (
        affiliationTokens(kol.affiliation).some(
            (t) => haystack.includes(` ${t} `) || haystack.includes(` ${t}s `),
        )
    ) {
        signals.push('affiliation');
    }

    if (specialtyStems(kol.specialty).some((s) => haystack.includes(s))) {
        signals.push('specialty');
    }

    // Check title/degree adjacency against EVERY name form — a degree
    // can sit next to an alternate publishing name ("Ghulam Mohyuddin,
    // MD") rather than the canonical roster surname.
    const allForms = [forms.full, forms.short, forms.initial, ...forms.extras].filter(Boolean);
    const titled = allForms.some((form) => {
        const tokens = form.split(' ');
        if (tokens.length < 2) return false;
        return hasTitledName(haystack, tokens[0], tokens.slice(1).join(' '));
    });
    if (titled) {
        signals.push('titled-name');
    }

    // Roster suffix: adjacency match is the strongest medical signal;
    // an adjacent CONFLICTING primary credential demotes to REVIEW —
    // a roster MD whose page reads "Name, DO" is a different person.
    const rosterTokens = parseSuffixTokens(kol.suffix);
    if (rosterTokens.length > 0) {
        const adj = suffixAdjacency(haystack, forms, rosterTokens);
        if (adj.conflict) {
            return {
                verdict: 'REVIEW',
                signals: `suffix-conflict:${adj.conflict}`,
            };
        }
        if (adj.match) signals.unshift('suffix-match');
    }

    if (signals.length === 0) {
        return {
            verdict: 'REVIEW',
            signals: strongPresent ? 'no-medical-context' : 'short-name-only',
        };
    }

    return {
        verdict: 'VALID',
        signals: (strongPresent ? ['full-name', ...signals] : signals).join('+'),
    };
}
