/**
 * Generate Google search queries for one KOL.
 *
 * Every design choice below is validated against real data:
 *   - 14,820 unique press articles from two live NotifyMe corpora
 *     (Alexion Neurology 5,511 + Ferring Uro-Onco 9,309), pairing
 *     roster names with the article text that covered them. DF% cited
 *     as (Alexion / Ferring).
 *   - The full 9,146-name Bio_KOLs roster across 19 projects, used as
 *     a format-validation gate for the name cleaner.
 *
 * Name variants — all earn their place:
 *   - SHORT (First Last) alone rescues ~47% of pairs (articles drop
 *     the middle name).
 *   - INITIAL (First M Last) is the ONLY matching form in 10.6% of
 *     Alexion and 22.0% of Ferring pairs.
 *   - Together the variants reach 82-83% of captured pairs; most of
 *     the remainder is wrong-person/junk capture a quoted-name query
 *     SHOULD exclude, plus ~1.2% "Dr Lastname"-only prose (accepted).
 *   - Parenthetical roster names (579 of 9,146 = 6.3%) carry
 *     nicknames, maiden names, or alternate spellings — including
 *     doubles like "Ghulam Rehman (Manni) Mohy-Ud-Din (Mohyuddin)".
 *     Each parenthetical yields one extra variant (capped at 2);
 *     multi-word trailing parens are standalone alternate names.
 *     Parens never enter a quoted phrase.
 *
 * Credential stripping is CASE-GATED: "DO"/"MS"/"MA" strip only when
 * written in UPPERCASE, because Do / Ma / So / Ba are real surnames
 * ("Hai C Do", "Cynthia Xiuguang Ma" are in the roster). Unambiguous
 * credentials (PhD, PharmD, Jr, III...) strip in any case, and after
 * a comma everything credential-like strips.
 *
 * Affiliation anchor: only 22.7% of real coverage articles contain
 * even the affiliation's 6-word prefix, so anchoring is SELECTIVE —
 * populate Input column C only for ambiguous names (2-token +
 * high-frequency surname; 117 of 9,146 in the current roster). The
 * phrase is capped at its first 6 words (a prefix still exact-matches
 * pages carrying the full institution name) to protect the 32-word
 * query budget.
 *
 * Honorific bias (MD OR Dr OR PhD): present in 84.1% / 79.0% of
 * articles. "professor" would add ~4pts but risks the 32-word limit.
 *
 * Cluster terms are the highest-DF activity words in the corpora:
 *   quotes:      said 45/43, according-to 21/26, says 17/15,
 *                noted 14/13, told 10/7
 *   conference:  presented 20/20 (superset of "presented at" 10/10),
 *                annual-meeting 13/12, presentation 11/9,
 *                conference 6/5, congress 4/3
 *   press:       announced 11/7, recognized 7.5/6.6, press-release
 *                6/4, award 6/5, grant 5.6/3.5, named 4/3
 *                (appointed/joins dropped: 0.7-1.7%, near dead)
 *   publication: study 51/50, research 55/45, trial 34/34, findings
 *                25/25, published 23/24 (superset of "published in"),
 *                journal 12/15
 * >=1 topical cluster reaches 86%+ of articles; the broad query
 * covers the rest. Directory spam is excluded in resultFilter.js, not
 * with -site: operators. Every query stays under Google's 32-word
 * limit (tested, including 2-parenthetical + long-affiliation cases).
 */

// Strip only when written in UPPERCASE (surname collision risk:
// Do, Ma, So, Ba, Ms...).
const CREDENTIALS_UPPER_ONLY = new Set([
    'md',
    'do',
    'ms',
    'ma',
    'ba',
    'bs',
    'np',
    'pa',
    'rn',
    'ot',
    'msc',
    'bsc',
    'msn',
    'bsn',
    'mba',
    'mph',
    'mha',
    'mhs',
    'mms',
    'msci',
    'msce',
    'mmsc',
    'aprn',
    'crnp',
    'arnp',
    'cnp',
    'dnp',
    'pac',
    'pa-c',
    'fnp',
    'fnp-bc',
    'pmhnp',
    'pmhnp-bc',
    'facc',
    'facs',
    'facp',
    'faan',
    'faap',
    'fasco',
    'facog',
    'facr',
    'fccp',
    'fasn',
    'fana',
    'faes',
    'facmg',
    'fapa',
    'dfapa',
    'faanem',
    'face',
    'facep',
    'fache',
    'frcp',
    'frcpc',
    'frcs',
    'mrcp',
    'dds',
    'dmd',
    'edd',
    'dpt',
    'otr',
]);

// Never surnames — strip in any case.
const CREDENTIALS_ANY_CASE = new Set([
    'phd',
    'pharmd',
    'mbbs',
    'mbchb',
    'mbbch',
    'drph',
    'dphil',
    'dsc',
    'psyd',
    'jr',
    'sr',
    'ii',
    'iii',
    'iv',
]);

function normToken(t) {
    return t.toLowerCase().replace(/[.]/g, '');
}

function isCredentialToken(tokenAsWritten, afterComma) {
    const norm = normToken(tokenAsWritten);
    if (CREDENTIALS_ANY_CASE.has(norm)) return true;
    if (!CREDENTIALS_UPPER_ONLY.has(norm)) return false;
    // After a comma, credential intent is unambiguous.
    if (afterComma) return true;
    // Otherwise require UPPERCASE as written: "DO" strips, "Do" stays.
    const letters = tokenAsWritten.replace(/[^A-Za-z]/g, '');
    return letters.length > 0 && letters === letters.toUpperCase();
}

/**
 * Extract ALL parenthetical tokens with position-based classification:
 *   trailing "(X)" single word            -> alternate surname
 *   trailing "(X Y)" multi word           -> standalone alternate name
 *   "(X)" right after the first name      -> nickname
 *   "(X)" just before the last name       -> alternate/maiden surname
 *   deeper-middle or single-letter parens -> ignored
 */
function extractParentheticals(raw) {
    // The roster uses two nickname conventions: (Ben) and "Jane".
    // Normalize quoted nicknames to parenthetical form, then strip
    // any residual unpaired quotes/brackets so no query phrase can
    // ever contain " ( or ).
    const text = String(raw || '').replace(/"([^"]*)"/g, '($1)');
    const baseName = text
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[()"]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const parens = [];

    const stripOthers = (s) =>
        s
            .replace(/\([^)]*\)/g, ' ')
            .replace(/[()"]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

    for (const match of text.matchAll(/\(([^)]*)\)/g)) {
        const token = match[1].replace(/[()"]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!token || token.length < 2) continue;

        const before = stripOthers(text.slice(0, match.index));
        const after = stripOthers(text.slice(match.index + match[0].length));
        const wordsBefore = before ? before.split(/\s+/).length : 0;
        const wordsAfter = after ? after.split(/\s+/).length : 0;
        const multiWord = /\s/.test(token);

        let kind = null;
        if (wordsAfter === 0 && multiWord) kind = 'altFullName';
        else if (wordsAfter === 0) kind = 'altSurname';
        else if (wordsBefore === 1) kind = 'nickname';
        else if (wordsAfter === 1 && !multiWord) kind = 'altSurname';

        if (kind) parens.push({ token, kind });
    }

    return { baseName, parens };
}

/**
 * Strip parentheticals, honorific prefix, and credential suffixes.
 * "Dr. John A. Smith, MD, PhD"     -> "John A. Smith"
 * "Jane Doe MD FACC"               -> "Jane Doe"
 * "Bertrand Marquess Anz, III"     -> "Bertrand Marquess Anz"
 * "Hai C Do"                       -> "Hai C Do"   (Do is a surname)
 * "John Alan Smith DO"             -> "John Alan Smith"
 * "Smith, John" (last-first) is left untouched.
 */
export function cleanKolName(rawName) {
    let name = extractParentheticals(rawName).baseName;
    if (!name) return '';

    name = name.replace(/^dr\.?\s+/i, '');

    const commaParts = name
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    if (commaParts.length > 1) {
        const tailTokens = commaParts.slice(1).join(' ').split(/\s+/);
        const allCredentials =
            tailTokens.length > 0 && tailTokens.every((t) => isCredentialToken(t, true));
        if (allCredentials) {
            name = commaParts[0];
        }
    }

    const tokens = name.split(/\s+/);
    while (tokens.length > 2 && isCredentialToken(tokens[tokens.length - 1], false)) {
        tokens.pop();
    }

    return tokens.join(' ').trim();
}

const MAX_PAREN_VARIANTS = 2;
const MAX_AFFILIATION_WORDS = 6;

// Particle surnames: "Bethanie Shannon Van Horne" -> lastName
// "Van Horne", not "Horne" (press writes "Dr. Van Horne").
const SURNAME_PARTICLES = new Set([
    'van',
    'von',
    'de',
    'del',
    'della',
    'di',
    'da',
    'dal',
    'la',
    'le',
    'den',
    'der',
    'ter',
    'ten',
    'st',
    'mc',
    'mac',
    'al',
    'el',
    'bin',
    'ibn',
]);

/**
 * Canonical searchable name forms for a roster KOL. Shared by the
 * query generator and the identity gate so the two can never drift.
 * Returns { full, short, initial, extras } where extras are the
 * nickname / alternate-surname / alternate-name variants (max 2).
 */
export function buildNameForms(kolName) {
    const { parens } = extractParentheticals(kolName);
    const cleaned = cleanKolName(kolName);
    if (!cleaned) return null;

    const parts = cleaned.split(/\s+/);
    const firstName = parts[0] || '';

    let lastStart = parts.length - 1;
    if (
        parts.length >= 3 &&
        SURNAME_PARTICLES.has(parts[parts.length - 2].toLowerCase().replace(/\./g, ''))
    ) {
        lastStart = parts.length - 2;
    }
    const lastName = parts.slice(lastStart).join(' ');
    const middleNames = parts.slice(1, lastStart);

    const full = parts.join(' ');
    const short = `${firstName} ${lastName}`.trim();
    const middleInitials = middleNames.map((n) => n.charAt(0)).join(' ');
    const initial = middleInitials ? `${firstName} ${middleInitials} ${lastName}` : short;

    const extras = [];
    for (const p of parens) {
        if (extras.length >= MAX_PAREN_VARIANTS || parts.length < 2) break;
        let variant = null;
        if (p.kind === 'nickname') variant = `${p.token} ${lastName}`;
        if (p.kind === 'altSurname') variant = `${firstName} ${p.token}`;
        if (p.kind === 'altFullName') variant = p.token;
        if (variant && ![full, short, initial, ...extras].includes(variant)) {
            extras.push(variant);
        }
    }

    return { full, short, initial, extras };
}

export function generateQueries(kolName, affiliation = '', clusters = null) {
    const forms = buildNameForms(kolName);
    if (!forms) return [];
    const { full, short, initial, extras } = forms;

    // ANCHORED PRECISION MODE: a populated affiliation marks this KOL
    // as ambiguity-flagged (common name). Live test run evidence: with
    // no anchor, "Michael Scott Perry" returned 20/20 wrong-person
    // rows. In this mode the affiliation phrase is appended to ALL
    // five queries, and the name expression is trimmed to full+short
    // so the longest query stays within Google's 32-word budget
    // (name <=7 + honorific 5 + cluster 12 + affiliation <=6 <= 30).
    const cleanAffiliation = String(affiliation || '')
        .replace(/["()]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .slice(0, MAX_AFFILIATION_WORDS)
        .join(' ');
    const anchored = cleanAffiliation.length > 0;

    const candidates = anchored ? [full, short] : [full, short, initial, ...extras];
    const names = candidates.filter((name, index, array) => name && array.indexOf(name) === index);

    // Google drops terms beyond 32 words. Budget: 32 minus the
    // honorific group (5 tokens) minus the longest cluster (12 tokens)
    // leaves 15 tokens for the name expression. Drop order when over
    // budget: the initial variant first (an alternate publishing name
    // like a maiden surname outranks it), then paren extras last-first
    // — full + short always survive.
    const NAME_EXPRESSION_MAX_TOKENS = 15;
    const buildExpression = (list) =>
        list.length === 1 ? `"${list[0]}"` : `(${list.map((n) => `"${n}"`).join(' OR ')})`;

    const nameList = [...names];
    let nameExpression = buildExpression(nameList);
    while (nameExpression.split(/\s+/).length > NAME_EXPRESSION_MAX_TOKENS && nameList.length > 2) {
        const initialIdx = nameList.indexOf(initial);
        if (initialIdx > -1 && initial !== full && initial !== short) {
            nameList.splice(initialIdx, 1);
        } else {
            nameList.pop();
        }
        nameExpression = buildExpression(nameList);
    }

    // 84.1% / 79.0% of corpus articles contain MD, Dr, or PhD.
    const honorific = '(MD OR Dr OR PhD)';

    const anchor = anchored ? ` "${cleanAffiliation}"` : '';

    const all = [
        // 1. Broad net — tbs recency filter does the work
        `${nameExpression} ${honorific}${anchor}`,
        // 2. Media quotes
        `${nameExpression} ${honorific} (said OR says OR told OR noted OR "according to")${anchor}`,
        // 3. Conference activity
        `${nameExpression} ${honorific} (presented OR presentation OR conference OR congress OR "annual meeting")${anchor}`,
        // 4. Press / announcements / recognition
        `${nameExpression} ${honorific} ("press release" OR announced OR named OR award OR recognized OR grant)${anchor}`,
        // 5. Publication coverage
        `${nameExpression} ${honorific} (study OR trial OR published OR findings OR journal OR research)${anchor}`,
        // 6. Events / faculty lane — CME, grand rounds, speaker and
        // faculty pages. Deliberately its own query: press corpora
        // show these terms at only 0.2-8% DF because event pages are
        // a DIFFERENT content class the press clusters never reach
        // (operator-required lane). "course" rejected: 12-17% DF is
        // inflated by "of course" / course-of-treatment collisions.
        `${nameExpression} ${honorific} ("grand rounds" OR CME OR faculty OR speaker OR webinar OR symposium)${anchor}`,
    ];

    // Optional cluster subset (1-based). Weekly-lean example: [1,3,4,6]
    // skips quotes+publications lanes when dedicated pubs/trials
    // pipelines already cover them. Default null = all six (no-miss).
    if (Array.isArray(clusters) && clusters.length > 0) {
        const wanted = new Set(clusters.map(Number));
        return all.filter((_, index) => wanted.has(index + 1));
    }
    return all;
}
