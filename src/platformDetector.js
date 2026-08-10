/**
 * Hostname-safe platform detection.
 *
 * Never uses substring includes() — "genedx.com".includes("x.com") is
 * true, which is exactly the bug this rewrite removes. A platform
 * matches only when the hostname IS the domain or a subdomain of it.
 */

const PLATFORM_DOMAINS = [
    ['facebook.com', 'Facebook'],
    ['fb.com', 'Facebook'],
    ['instagram.com', 'Instagram'],
    ['linkedin.com', 'LinkedIn'],
    ['x.com', 'X'],
    ['twitter.com', 'X'],
    ['youtube.com', 'YouTube'],
    ['youtu.be', 'YouTube'],
    ['threads.net', 'Threads'],
    ['threads.com', 'Threads'],
    ['bsky.app', 'Bluesky'],
    ['tiktok.com', 'TikTok'],
];

export function detectPlatform(url) {
    if (!url) return 'Website';

    let host;
    try {
        host = new URL(String(url).trim()).hostname.toLowerCase();
    } catch {
        return 'Website';
    }
    host = host.replace(/^www\./, '');

    for (const [domain, platform] of PLATFORM_DOMAINS) {
        if (host === domain || host.endsWith(`.${domain}`)) {
            return platform;
        }
    }
    return 'Website';
}
