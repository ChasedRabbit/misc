// sync.gs — the live endpoint that lets the family form and the photo-day
// tablet see the same list of who has already submitted.
//
// This is Google Apps Script, not JavaScript for the page — it runs on
// Google's servers, bound to a Google Sheet. Deploying it costs nothing and
// needs no server of your own.
//
// SETUP
//   1. Create a new Google Sheet (any name).
//   2. Extensions -> Apps Script. Delete the sample code, paste this file in.
//   3. (Optional but recommended) Set SECRET below to a random string of your
//      choosing, so strangers who find the URL can't fill your sheet with junk
//      or read your submission timestamps. Anyone with the link can already
//      only see IDs and dates, never names or addresses — see "What this
//      endpoint returns" below — so this is a spam guard, not a privacy one.
//   4. Deploy -> New deployment -> type "Web app".
//        Execute as: Me
//        Who has access: Anyone
//      (Anyone, not Anyone with a Google account — the page runs in a
//      family's browser with no Google login.)
//   5. Copy the deployment URL. Put it in config.js as postUrl, and if you
//      set SECRET, also as syncKey.
//   6. Reopen the Sheet — a "Responses" tab appears the first time anyone
//      submits, with a header row and one row per household.
//
// If you ever change the code, you must create a NEW deployment version
// (Deploy -> Manage deployments -> edit -> New version) for the change to
// take effect. Saving the script alone does not update a live deployment.
//
// WHAT THIS ENDPOINT RETURNS
//   The photo-day tablet needs to know WHETHER and WHEN each household
//   submitted, not WHAT they submitted — that already lands safely in this
//   Sheet, which only people with access to your Google account can open.
//   So the read side (doGet) hands back only household ID, timestamp, and a
//   count of how many fields changed. No names, addresses, phones, or emails
//   ever transit that request. The write side (doPost) does receive the full
//   submission, same as an emailed one would, because that's the one place
//   your directory data has to end up.

const SHEET_NAME = 'Responses';

// Leave blank to accept requests from anyone with the URL (fine for most
// churches — the URL itself isn't published). Set to a random string to
// require it, e.g. SECRET = 'a1b2c3d4e5'.
const SECRET = '';

const HEADER = [
  'Household ID', 'Household', 'Submitted', 'Change count',
  'Changes (JSON)', 'Note', 'Record (JSON)',
];

function doPost(e) {
  let body;
  try {
    // The page sends Content-Type: text/plain on purpose, to keep this a
    // CORS "simple request" — Apps Script has no way to answer the preflight
    // OPTIONS request that a JSON content-type would trigger, so declaring
    // JSON here would make every submission fail as a network error. The
    // body is JSON text regardless of what the header says.
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Could not parse the submission.' });
  }

  if (SECRET && body.key !== SECRET) {
    return json({ ok: false, error: 'unauthorized' });
  }
  if (!body.id) {
    return json({ ok: false, error: 'Submission is missing a household ID.' });
  }

  upsert(body);
  return json({ ok: true });
}

function doGet(e) {
  const key = (e.parameter && e.parameter.key) || '';
  if (SECRET && key !== SECRET) {
    return json({ ok: false, error: 'unauthorized' });
  }

  const sheet = getSheet();
  const rows = sheet.getDataRange().getValues();
  const completed = [];
  for (let i = 1; i < rows.length; i++) {
    const [id, , submittedAt, changeCount] = rows[i];
    if (id) completed.push({ id: String(id), submittedAt: fmt(submittedAt), changeCount: Number(changeCount) || 0 });
  }
  return json({ ok: true, completed });
}

function upsert(body) {
  const sheet = getSheet();
  const ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), 1).getValues();
  let rowIndex = -1;
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(body.id)) { rowIndex = i + 2; break; }
  }

  const record = [
    body.id,
    body.household || '',
    body.submittedAt || new Date().toISOString(),
    body.changeCount || 0,
    JSON.stringify(body.changes || []),
    body.note || '',
    JSON.stringify(body.record || {}),
  ];

  // A second submission from the same household (they went back and changed
  // something else) replaces the row rather than appending a duplicate, so
  // the sheet always shows the office the latest state, not a history to sift.
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, record.length).setValues([record]);
  else sheet.appendRow(record);
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function fmt(value) {
  // A cell that Sheets auto-parsed into a date needs putting back into the
  // same ISO shape the page compares timestamps as strings against.
  return value instanceof Date ? value.toISOString() : String(value || '');
}

function json(obj) {
  // Apps Script's ContentService has no API for setting an HTTP status code
  // or response headers, so errors are encoded in the body's `ok` field
  // instead of a 4xx/5xx — callers check that field, not response.status.
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
