/**
 * Two explicit stages replace the old fragile double-pass through one
 * function:
 *   1. processSerpResults()   — normalize raw SERP items once.
 *   2. enrichWithPageData()   — overlay crawled page metadata, but only
 *      with non-empty values, so a blocked/failed crawl never wipes a
 *      good SERP title or date.
 */

import { detectPlatform } from './platformDetector.js';

/**
 * SERP items almost never carry an author for social posts, but the
 * poster's name is usually IN the title ("Cassie Shields | And that's
 * a wrap...", '"AACP on Instagram: ..."') or the URL path
 * (facebook.com/autismsciencefd/posts/...). Derive it so the Author
 * column is populated instead of blank (pilot run: 50/51 blank).
 */
export function deriveSocialAuthor(url, title, platform) {
    if (platform === 'Website') return '';
    const t = String(title || '');

    const pipe = t.match(/^([^|]{2,40})\s*\|/);
    if (
        pipe &&
        pipe[1].trim().split(/\s+/).length <= 4 &&
        !/facebook|instagram|youtube|tiktok/i.test(pipe[1])
    ) {
        return pipe[1].trim();
    }

    const on = t.match(/^"?([A-Za-z@][\w .'@&-]{1,40}?) on (?:Instagram|Facebook|TikTok)/);
    if (on) return on[1].trim();

    const fb = String(url || '').match(/facebook\.com\/([^/?#]+)\//);
    if (fb && !['posts', 'watch', 'photo', 'reel', 'groups', 'p'].includes(fb[1])) {
        return fb[1];
    }
    return '';
}

// Text signals are EVENT-PAGE specific. Bare "conference/congress/
// speaker" removed after ground-truth calibration: press coverage OF
// conferences uses those words constantly (602 Press rows misfiled),
// while true event pages carry registration/CME/program vocabulary.
const CONFERENCE_TEXT_RE =
    /grand ?rounds|\bcme\b|agenda|registration|register now|accredit|scientific program|call for abstracts|abstract submission|poster session|webinar/i;
const CONFERENCE_URL_RE =
    /cme|grand-?rounds|webinar|\/events?\/|\/education\/|\/courses?\/|\/program(me)?\b|\/sessions?\/|learn\.|agenda|abstract[_-]?book|posters?[_-]|session_brochure|\/PDFfiles\//i;
// Congress hosting platforms and program-book hosts — calibrated on
// 15,954 ground-truth conference engagements (Alexion export).
const CONFERENCE_DOMAINS = [
    'mirasmart.com',
    'virtual-meeting.org',
    'emedevents.com',
    'eeds.com',
    'flippingbook.com',
    'cmscscholar.org',
    'eventscribe.com',
    'confex.com',
    'cvent.com',
    'abstractsonline.com',
    'morressier.com',
    'medscape.org',
];
// Conference abstracts published as journal supplements (3,740 in the
// Alexion ground truth): DOI on a journal domain but a supplement path
// -> Conference, not Pubs.
const SUPPLEMENT_RE = /supplement|\/abstracts?\/|\.abstract\b/i;
// Session-record titles: poster codes (P4.2-066, S31.007), "Poster",
// "Oral Presentation", "Session 5" — title-level only, never body text.
const CONF_TITLE_RE =
    /\b[PS] ?\d+\.[\d.-]+|\bposter\b|\boral presentation\b|\bsession [ivxlc\d]+|platform session|\bplenary\b|\bpresented at\b|\babstract\b/i;

const TRIAL_DOMAINS = [
    'clinicaltrials.gov',
    'clinicaltrialsregister.eu',
    'euclinicaltrials.eu',
    'isrctn.com',
    'anzctr.org.au',
    'ctri.nic.in',
    'umin.ac.jp',
    'chictr.org.cn',
];
const TRIAL_RE = /\bnct\d{7,8}\b|clinical ?trials? registry/i;

const PUB_DOMAINS = [
    'pubmed.ncbi.nlm.nih.gov',
    'ncbi.nlm.nih.gov',
    'doi.org',
    'nature.com',
    'nejm.org',
    'thelancet.com',
    'sciencedirect.com',
    'springer.com',
    'link.springer.com',
    'wiley.com',
    'onlinelibrary.wiley.com',
    'academic.oup.com',
    'jamanetwork.com',
    'neurology.org',
    'bmj.com',
    'cell.com',
    'frontiersin.org',
    'mdpi.com',
    'biorxiv.org',
    'medrxiv.org',
    'karger.com',
    'tandfonline.com',
    'sagepub.com',
    'journals.lww.com',
    'ahajournals.org',
    'annualreviews.org',
    'plos.org',
    'jns.org',
];
// '/article/' deliberately absent: news URLs use it constantly
// (ksdk.com/article/news/... caused 253 Press->Pubs misfiles).
const PUB_URL_RE = /\/doi\/|pubmed|\/pmc\/|\/fulltext|pmid/i;

// FORM signals only — never medical-topic words (study/patients/
// treatment made 4,591 conference abstracts misfile as Press).
const PRESS_RE =
    /press release|announc|\bnews\b|interview|according to|\bsaid\b|\bsays\b|\btold\b|report(s|ed)?\b|award|named|launch|approv|\bfda\b|appoint|recogni[sz]/i;
// Headline-style titles often lack newsy verbs; the URL usually says
// it plainly (56% of ground-truth Press had newsy URLs, quiet titles).
const PRESS_URL_RE =
    /\/news\b|\/article|\/story|\/stories|\/press|\/blog|\/magazine|\/view(article)?\//i;
// Trade med-news outlets whose quiet titles carry no newsy verbs —
// calibrated on ground truth (Medscape /viewarticle, MedPage, VJ...).
const PRESS_DOMAINS = [
    'medscape.com',
    'medpagetoday.com',
    'healio.com',
    'neurologylive.com',
    'vjneurology.com',
    'everydayhealth.com',
    'healthcentral.com',
    'medicalnewstoday.com',
    'statnews.com',
    'fiercepharma.com',
    'biopharmadive.com',
    'consultqd.clevelandclinic.org',
    'ajmc.com',
    'pharmacytimes.com',
    'targetedonc.com',
    'onclive.com',
    'hcplive.com',
];

function hostMatches(url, domains) {
    try {
        const host = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
        return domains.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
        return false;
    }
}

/**
 * NotifyMe activity taxonomy: SMA | Press | Conference | Pubs |
 * Trials | Other. Precedence:
 *   1. SMA — social platform posts, by channel, regardless of topic
 *      (an Instagram conference post is SMA, matching deliverables).
 *   2. Trials — registry domains or NCT identifiers.
 *   3. Pubs — journal/publisher/PubMed domains or DOI-style paths.
 *   4. Conference — CME / grand rounds / faculty / symposium signals.
 *   5. Press — newsy language (announcements, quotes, approvals).
 *   6. Other — nothing above matched (directories, evergreen pages).
 */
export function classifyActivityType(url, title, description, platform) {
    if (platform && platform !== 'Website') return 'SMA';
    const text = `${title || ''} ${description || ''}`;
    const u = String(url || '');
    if (hostMatches(u, TRIAL_DOMAINS) || TRIAL_RE.test(text) || TRIAL_RE.test(u)) return 'Trials';
    if (hostMatches(u, PUB_DOMAINS) || PUB_URL_RE.test(u)) {
        // Journal-supplement / abstract links and poster-coded titles
        // are conference engagements, not publications.
        if (SUPPLEMENT_RE.test(u) || CONF_TITLE_RE.test(title || '')) return 'Conference';
        return 'Pubs';
    }
    if (
        CONFERENCE_TEXT_RE.test(text) ||
        CONFERENCE_URL_RE.test(u) ||
        CONF_TITLE_RE.test(title || '')
    )
        return 'Conference';
    if (PRESS_RE.test(text) || PRESS_URL_RE.test(u)) return 'Press';
    return 'Other';
}

export function processSerpResults(kol, results) {
    return results.map((result) => {
        const url = result.url || result.link || '';

        return {
            kolId: kol.kolId || '',
            kolName: kol.kolName || '',
            searchQuery: result.searchQuery || result.query || '',
            title: result.title || '',
            description: result.description || result.snippet || '',
            url,
            publishedDate:
                result.publishedDate ||
                result.date ||
                result.published_date ||
                result.publishDate ||
                result.publishedAt ||
                '',
            author:
                result.author || deriveSocialAuthor(url, result.title || '', detectPlatform(url)),
            position: result.position || '',
            source: getSource(url),
            platform: detectPlatform(url),
            activityType: classifyActivityType(
                url,
                result.title || '',
                result.description || result.snippet || '',
                detectPlatform(url),
            ),
        };
    });
}

export function enrichWithPageData(processedResults, pageData) {
    return processedResults.map((result) => {
        const page = pageData.get(result.url) || {};
        return {
            ...result,
            // Page metadata wins only when it exists; blocked pages
            // return empty strings and fall through to SERP values.
            title: page.title || result.title,
            description: page.description || result.description,
            author: page.author || result.author,
            publishedDate: page.publishedDate || result.publishedDate,
        };
    });
}

function getSource(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}
