/**
 * Google Sheets I/O with a staging-promote safety model.
 *
 * Invariants:
 *  - Credentials come from a secret input or env var. There is NO
 *    credentials file in this repo or in the Docker image.
 *  - The Output sheet is NEVER cleared at run start. Results append to
 *    a run-stamped staging tab via the atomic values.append API (no
 *    read-then-write row math, no race). On successful completion the
 *    staging content replaces Output and the staging tab is deleted.
 *    A crashed run leaves the previous Output fully intact, with the
 *    partial staging tab available for inspection.
 */

import { google } from 'googleapis';

import { OUTPUT_HEADERS } from './config.js';

// Column letter for the last output column (supports up to Z).
const LAST_COL = String.fromCharCode(64 + OUTPUT_HEADERS.length);

let sheetsClient = null;
let SPREADSHEET_ID = '';
let INPUT_SHEET = 'Input';
let OUTPUT_SHEET = 'Output';

export function initSheets({ spreadsheetId, inputSheet, outputSheet, serviceAccountJson }) {
    SPREADSHEET_ID = spreadsheetId;
    INPUT_SHEET = inputSheet;
    OUTPUT_SHEET = outputSheet;

    const raw = serviceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
        throw new Error(
            'Google credentials missing. Provide the serviceAccountJson secret input ' +
                'or set the GOOGLE_SERVICE_ACCOUNT_JSON environment variable on the actor. ' +
                'Do NOT commit a credentials file.',
        );
    }

    let credentials;
    try {
        credentials = JSON.parse(raw);
    } catch {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON / serviceAccountJson is not valid JSON.');
    }

    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    sheetsClient = google.sheets({ version: 'v4', auth });
}

function sheets() {
    if (!sheetsClient) throw new Error('initSheets() must be called first.');
    return sheetsClient;
}

// ---------------------------------------------------------------
/**
 * An "affiliation" like "MD, MBA, MS, FACS, FRCS" is a credential
 * string in the wrong column (Input order is C=Suffix, D=Affiliation).
 * Anchoring queries on it destroys recall for that KOL, so it is
 * detected, WARNED about, and ignored for anchoring.
 */
export function looksLikeSuffix(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    const tokens = text.split(/[\s,;./]+/).filter(Boolean);
    if (tokens.length === 0) return false;
    return tokens.every((t) => /^[A-Za-z]{2,6}$/.test(t) && t === t.toUpperCase());
}

// READ KOLS  (Input!A2:E -> { kolId, kolName, suffix?, affiliation?, specialty? })
// ---------------------------------------------------------------
export async function readKOLs() {
    const response = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${INPUT_SHEET}!A2:E`,
    });

    const rows = response.data.values || [];
    const kols = rows
        .filter((row) => row[0] && row[1])
        .map((row) => {
            const kol = {
                kolId: String(row[0]).trim(),
                kolName: String(row[1]).trim(),
                suffix: row[2] ? String(row[2]).trim() : '',
                affiliation: row[3] ? String(row[3]).trim() : '',
                specialty: row[4] ? String(row[4]).trim() : '',
            };
            if (kol.affiliation && looksLikeSuffix(kol.affiliation)) {
                console.warn(
                    `WARNING ${kol.kolId}: Affiliation "${kol.affiliation}" looks like a ` +
                        `credential/suffix string - check Input column order ` +
                        `(C=Suffix, D=Affiliation). Ignoring it for query anchoring.`,
                );
                if (!kol.suffix) kol.suffix = kol.affiliation;
                kol.affiliation = '';
            }
            return kol;
        });

    console.log(`Google Sheet returned ${kols.length} KOL(s)`);
    return kols;
}

// ---------------------------------------------------------------
// SHEET HELPERS
// ---------------------------------------------------------------
async function getSheetIdByTitle(title) {
    const meta = await sheets().spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
        fields: 'sheets.properties',
    });
    const found = (meta.data.sheets || []).find((s) => s.properties.title === title);
    return found ? found.properties.sheetId : null;
}

async function addSheet(title) {
    await sheets().spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
}

async function deleteSheetByTitle(title) {
    const sheetId = await getSheetIdByTitle(title);
    if (sheetId === null) return;
    await sheets().spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ deleteSheet: { sheetId } }] },
    });
}

async function ensureSheet(title) {
    const sheetId = await getSheetIdByTitle(title);
    if (sheetId === null) await addSheet(title);
}

// ---------------------------------------------------------------
// STAGING LIFECYCLE
// ---------------------------------------------------------------
export async function createStaging(runTag) {
    const title = `_staging_${runTag}`;

    // Paranoia: a leftover tab with the same tag from a retried run.
    await deleteSheetByTitle(title);
    await addSheet(title);

    await sheets().spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${title}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [OUTPUT_HEADERS] },
    });

    console.log(`Staging tab created: ${title}`);
    return title;
}

/** Atomic append — no read-then-write row math, no race. */
export async function appendResults(stagingTitle, results) {
    if (!results || results.length === 0) return;

    const values = results.map((r) => [
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

    await sheets().spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${stagingTitle}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
    });

    console.log(`Appended ${values.length} row(s) to ${stagingTitle}`);
}

/** On success: staging content replaces Output; staging tab removed. */
export async function promoteStaging(stagingTitle) {
    const res = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${stagingTitle}!A2:${LAST_COL}`,
    });
    const rows = res.data.values || [];

    await ensureSheet(OUTPUT_SHEET);
    await sheets().spreadsheets.values.clear({
        spreadsheetId: SPREADSHEET_ID,
        range: `${OUTPUT_SHEET}!A:${LAST_COL}`,
    });
    await sheets().spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${OUTPUT_SHEET}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [OUTPUT_HEADERS, ...rows] },
    });

    await deleteSheetByTitle(stagingTitle);
    console.log(`Promoted ${rows.length} row(s) from ${stagingTitle} to ${OUTPUT_SHEET}`);
    return rows.length;
}

/** Empty-run path: keep previous Output, remove the staging tab. */
export async function dropStaging(stagingTitle) {
    try {
        await deleteSheetByTitle(stagingTitle);
        console.log(`Staging tab dropped: ${stagingTitle}`);
    } catch (error) {
        console.log(`Could not drop staging tab ${stagingTitle}: ${error.message}`);
    }
}
