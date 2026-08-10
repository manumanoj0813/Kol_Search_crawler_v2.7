/**
 * Fetch a result page and extract title / description / author /
 * published date.
 *
 * Date cascade: article meta tags -> <time datetime> -> JSON-LD
 * (including @graph recursion) -> common CSS selectors.
 *
 * Block-page guard: Cloudflare/consent interstitials return metadata
 * like "Just a moment..." which must never overwrite good SERP data.
 * Detected block pages return the empty result.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

const EMPTY = { publishedDate: '', author: '', title: '', description: '', bodyText: '' };

const BLOCK_TITLE_RE =
    /just a moment|attention required|access denied|are you a robot|verify you are human|enable javascript|captcha|pardon our interruption|request blocked|cloudflare|robot check|security check/i;

const META_DATE_SELECTORS = [
    'meta[property="article:published_time"]',
    'meta[property="article:published"]',
    'meta[property="og:published_time"]',
    'meta[name="date"]',
    'meta[name="publish-date"]',
    'meta[name="published-date"]',
    'meta[name="publication-date"]',
    'meta[name="article:published_time"]',
    'meta[name="DC.date"]',
    'meta[name="dcterms.date"]',
    'meta[itemprop="datePublished"]',
    'meta[itemprop="dateCreated"]',
    'meta[property="datePublished"]',
];

const HTML_DATE_SELECTORS = [
    '[itemprop="datePublished"]',
    '[itemprop="dateCreated"]',
    '.published',
    '.publish-date',
    '.published-date',
    '.publication-date',
    '.post-date',
    '.article-date',
    '.entry-date',
    '.date-published',
];

export async function crawlPage(url, { agent } = {}) {
    if (!url) return EMPTY;

    try {
        const response = await axios.get(url, {
            timeout: 15000,
            maxRedirects: 5,
            maxContentLength: 5 * 1024 * 1024,
            responseType: 'text',
            // Prevent axios auto-JSON-parsing; cheerio needs the string.
            transformResponse: [(data) => data],
            validateStatus: (status) => status >= 200 && status < 400,
            ...(agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {}),
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                    'Chrome/151.0.0.0 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        const $ = cheerio.load(response.data);

        const title = cleanText(
            $('meta[property="og:title"]').attr('content') ||
                $('meta[name="twitter:title"]').attr('content') ||
                $('title').first().text() ||
                '',
        );

        if (BLOCK_TITLE_RE.test(title)) {
            console.log(`Block page detected, keeping SERP metadata: ${url}`);
            return EMPTY;
        }

        const description = cleanText(
            $('meta[property="og:description"]').attr('content') ||
                $('meta[name="description"]').attr('content') ||
                $('meta[name="twitter:description"]').attr('content') ||
                '',
        );

        const author = cleanText(
            $('meta[name="author"]').attr('content') ||
                $('meta[property="article:author"]').attr('content') ||
                $('meta[name="byl"]').attr('content') ||
                $('meta[itemprop="author"]').attr('content') ||
                '',
        );

        let publishedDate = '';

        for (const selector of META_DATE_SELECTORS) {
            const value = $(selector).first().attr('content');
            if (value) {
                publishedDate = value.trim();
                break;
            }
        }

        if (!publishedDate) {
            $('time[datetime]').each((_, element) => {
                if (publishedDate) return;
                const value = $(element).attr('datetime');
                if (value) publishedDate = value.trim();
            });
        }

        if (!publishedDate) {
            $('script[type="application/ld+json"]').each((_, element) => {
                if (publishedDate) return;
                const raw = $(element).html();
                if (!raw) return;
                try {
                    const json = JSON.parse(raw);
                    const foundDate = findPublishedDate(json);
                    if (foundDate) publishedDate = foundDate;
                } catch {
                    // ignore invalid JSON-LD
                }
            });
        }

        if (!publishedDate) {
            for (const selector of HTML_DATE_SELECTORS) {
                const element = $(selector).first();
                if (!element.length) continue;
                publishedDate = (
                    element.attr('datetime') ||
                    element.attr('content') ||
                    element.text() ||
                    ''
                ).trim();
                if (publishedDate) break;
            }
        }

        // Body text feeds the identity gate; capped to keep memory flat.
        const bodyText = cleanText($('body').text()).slice(0, 8000);

        console.log(`Crawled: ${url} | date: ${publishedDate || 'NOT FOUND'}`);
        return { publishedDate, author, title, description, bodyText };
    } catch (error) {
        console.log(`Page crawl failed: ${url} | ${error.message}`);
        return EMPTY;
    }
}

function findPublishedDate(data) {
    if (!data) return '';

    if (Array.isArray(data)) {
        for (const item of data) {
            const date = findPublishedDate(item);
            if (date) return date;
        }
        return '';
    }

    if (typeof data === 'object') {
        if (data.datePublished) return String(data.datePublished).trim();
        if (data.dateCreated) return String(data.dateCreated).trim();
        if (data['@graph']) {
            const date = findPublishedDate(data['@graph']);
            if (date) return date;
        }
        for (const key of Object.keys(data)) {
            const value = data[key];
            if (typeof value === 'object') {
                const date = findPublishedDate(value);
                if (date) return date;
            }
        }
    }
    return '';
}

function cleanText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}
