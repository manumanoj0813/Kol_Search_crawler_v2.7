/**
 * Static defaults. Runtime values come from actor input
 * (.actor/input_schema.json) and override these in main.js.
 */
export const CONFIG = {
    GOOGLE_ACTOR_ID: 'scraperlink/google-search-results-serp-scraper',

    DAYS_BACK: 7,
    INCLUDE_MERGED: true,

    // NOTE: the scraperlink actor requires `limit` as a STRING.
    RESULTS_PER_QUERY: 10,

    PAGE_CONCURRENCY: 10,
};

export const OUTPUT_HEADERS = [
    'KOL_ID',
    'KOL_Name',
    'Search_Query',
    'Title',
    'Description',
    'URL',
    'Published_Date',
    'Author',
    'Position',
    'Source',
    'Platform',
    'Activity_Type',
    'Validity',
    'Validity_Signals',
];
