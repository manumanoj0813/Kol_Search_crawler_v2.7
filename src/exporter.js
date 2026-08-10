/**
 * Build the Excel backup as a Buffer for the Apify key-value store.
 * Writing to the container filesystem would die with the container —
 * the KV store is the only place the user can actually download from.
 *
 * Column headers mirror the Output sheet exactly.
 */

import XLSX from 'xlsx';

import { OUTPUT_HEADERS } from './config.js';

export function buildWorkbookBuffer(results) {
    const rows = results.map((r) => [
        r.kolId || '',
        r.kolName || '',
        r.searchQuery || '',
        r.title || '',
        r.description || '',
        r.url || '',
        r.publishedDate || '',
        r.author || '',
        r.position || '',
        r.source || '',
        r.platform || '',
        r.activityType || '',
        r.validity || '',
        r.validitySignals || '',
    ]);

    const worksheet = XLSX.utils.aoa_to_sheet([OUTPUT_HEADERS, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Results');

    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
