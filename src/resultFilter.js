/**
 * Remove duplicate URLs and low-quality results.
 *
 * Directory/profile spam (Healthgrades, Doximity, NPI registries...) is
 * blocked HERE rather than with -site: operators in the search strings,
 * keeping queries under Google's 32-word limit and making the exclusion
 * list deterministic and testable.
 *
 * Hostname matching is exact-or-subdomain, never substring includes().
 */

const BLOCKED_DOMAINS = [
    'healthgrades.com',
    'doximity.com',
    'zocdoc.com',
    'vitals.com',
    'ratemds.com',
    'sharecare.com',
    'castleconnolly.com',
    'npiprofile.com',
    'npidb.org',
    'npino.com',
    'hipaaspace.com',
    'healthcare4ppl.com',
    'wellness.com',
    'md.com',
    'findatopdoc.com',
    'caredash.com',
];

const BLOCKED_PATHS = [
    { host: 'webmd.com', path: '/doctor' },
    { host: 'health.usnews.com', path: '/doctors' },
];

export function filterResults(results) {
    const seen = new Set();

    return results.filter((result) => {
        if (!result || !result.url) return false;

        const normalizedUrl = normalizeUrl(result.url);
        if (!normalizedUrl) return false;

        if (seen.has(normalizedUrl)) return false;
        seen.add(normalizedUrl);

        if (normalizedUrl.includes('webcache')) return false;
        if (normalizedUrl.toLowerCase().split('?')[0].endsWith('.pdf')) return false;
        if (normalizedUrl.includes('google.com/search')) return false;

        if (isBlockedUrl(normalizedUrl)) {
            console.log(`REMOVE - directory/profile site: ${normalizedUrl}`);
            return false;
        }

        return true;
    });
}

function isBlockedUrl(url) {
    let host;
    let pathname;
    try {
        const parsed = new URL(url);
        host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        pathname = parsed.pathname.toLowerCase();
    } catch {
        return false;
    }

    for (const domain of BLOCKED_DOMAINS) {
        if (host === domain || host.endsWith(`.${domain}`)) return true;
    }
    for (const rule of BLOCKED_PATHS) {
        const hostMatch = host === rule.host || host.endsWith(`.${rule.host}`);
        if (hostMatch && pathname.startsWith(rule.path)) return true;
    }
    return false;
}

export function normalizeUrl(url) {
    try {
        const parsed = new URL(String(url).trim());
        parsed.pathname = parsed.pathname.replace(/\/+$/, '');

        const trackingParameters = [
            'utm_source',
            'utm_medium',
            'utm_campaign',
            'utm_term',
            'utm_content',
            'gclid',
            'fbclid',
            'ref',
            'source',
        ];
        for (const parameter of trackingParameters) {
            parsed.searchParams.delete(parameter);
        }
        return parsed.toString();
    } catch {
        return '';
    }
}
