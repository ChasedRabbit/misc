// csv.js — turning a church-software export into households, and back again.
//
// Pure functions, no DOM. The office's export is the one thing this tool can't
// control: every system names its columns differently, some put one row per
// person and some put one row per family, and Excel in some locales writes
// semicolons instead of commas. So the strategy is to guess well, show the
// guess, and let a human correct it — never to require a particular format.

const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Columns we know how to use. Synonyms are ordered best-first: an exact match
 * on the first synonym beats an exact match on the last, which is how "Home
 * Phone" and "Cell Phone" end up in the right slots even though both are
 * plausibly "phone".
 */
export const FIELD_TARGETS = [
  {
    key: 'householdId', label: 'Family / household ID', level: 'household',
    hint: 'Lets updates be matched back to the right record on re-import.',
    synonyms: ['householdid', 'familyid', 'houseid', 'homeid', 'familynumber', 'envelopenumber', 'envelope', 'recordid', 'unitid', 'id'],
  },
  {
    key: 'householdName', label: 'Family / household name', level: 'household',
    synonyms: ['householdname', 'familyname', 'household', 'family', 'lastname', 'surname', 'last'],
  },
  {
    key: 'street', label: 'Street address', level: 'household',
    synonyms: ['addressline1', 'address1', 'streetaddress', 'streetline1', 'mailingaddress', 'homeaddress', 'street', 'addr1', 'address'],
  },
  {
    key: 'unit', label: 'Apt / unit', level: 'household',
    synonyms: ['addressline2', 'address2', 'streetline2', 'apartment', 'apt', 'unit', 'suite', 'addr2'],
  },
  { key: 'city', label: 'City', level: 'household', synonyms: ['mailingcity', 'city', 'town'] },
  { key: 'state', label: 'State', level: 'household', synonyms: ['mailingstate', 'state', 'province', 'region', 'st'] },
  { key: 'zip', label: 'ZIP', level: 'household', synonyms: ['mailingzip', 'zipcode', 'postalcode', 'zip', 'postal', 'postcode'] },
  {
    key: 'homePhone', label: 'Home phone', level: 'household',
    synonyms: ['homephone', 'housephone', 'householdphone', 'landline', 'primaryphone', 'mainphone', 'telephone', 'phonenumber', 'phone'],
  },
  {
    key: 'householdEmail', label: 'Household email', level: 'household',
    synonyms: ['householdemail', 'familyemail'],
  },
  {
    key: 'anniversary', label: 'Anniversary', level: 'household',
    synonyms: ['weddinganniversary', 'anniversary', 'weddingdate', 'marriagedate'],
  },
  { key: 'fullName', label: 'Full name', level: 'person', synonyms: ['fullname', 'displayname', 'personname', 'membername', 'name'] },
  { key: 'firstName', label: 'First name', level: 'person', synonyms: ['firstname', 'givenname', 'preferredname', 'goesby', 'nickname', 'first'] },
  { key: 'lastName', label: 'Last name', level: 'person', synonyms: ['lastname', 'surname', 'familyname', 'last'] },
  {
    key: 'role', label: 'Role / relationship', level: 'person',
    synonyms: ['familyrelationship', 'householdrole', 'relationship', 'familyrole', 'memberrole', 'familyposition', 'role', 'relation', 'position'],
  },
  { key: 'email', label: 'Email', level: 'person', synonyms: ['emailaddress', 'primaryemail', 'personalemail', 'email'] },
  {
    key: 'mobile', label: 'Mobile', level: 'person',
    synonyms: ['mobilephone', 'cellphone', 'cellularphone', 'mobilenumber', 'textnumber', 'mobile', 'cell'],
  },
  { key: 'birthday', label: 'Birthday', level: 'person', synonyms: ['dateofbirth', 'birthdate', 'birthday', 'dob', 'born'] },
];

// ---------------------------------------------------------------------------
// Reading and writing CSV
// ---------------------------------------------------------------------------

/** Excel writes semicolons in some locales, and exports are sometimes tabs. */
export function detectDelimiter(text) {
  const firstLine = String(text || '').replace(/^﻿/, '').split(/\r?\n/)[0] || '';
  let best = ',';
  let bestCount = -1;
  for (const d of [',', ';', '\t', '|']) {
    // Count only outside quotes, so a comma inside "Smith, John" doesn't win.
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const c = firstLine[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === d && !inQuotes) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

/**
 * RFC 4180-ish: quoted fields, doubled quotes, embedded commas and newlines,
 * CRLF, and a BOM from Excel. Values are trimmed — leading spaces in a church
 * export are always accidental.
 */
export function parseCsv(text, delimiter) {
  const s = String(text || '').replace(/^﻿/, '');
  if (!s.trim()) return [];
  const d = delimiter || detectDelimiter(s);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === d) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  row.push(field);
  rows.push(row);

  while (rows.length && rows[rows.length - 1].every((v) => str(v) === '')) rows.pop();
  return rows.map((r) => r.map((v) => str(v)));
}

export function toCsv(rows) {
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');

  function cell(v) {
    const s = str(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
}

// ---------------------------------------------------------------------------
// Guessing which column is which
// ---------------------------------------------------------------------------

/**
 * Assign headers to fields, best match first, each header used at most once.
 *
 * Greedy on match quality rather than on column order, so a file with both
 * "Phone" and "Home Phone" gives "Home Phone" to homePhone — the exact synonym
 * hit outranks the looser one no matter which column comes first.
 *
 * @returns {Object} field key -> column index (only for fields it's confident about)
 */
export function guessMapping(headers) {
  const cols = (headers || []).map(norm);
  const candidates = [];

  for (const target of FIELD_TARGETS) {
    for (let i = 0; i < cols.length; i++) {
      if (!cols[i]) continue;
      const rank = target.synonyms.indexOf(cols[i]);
      if (rank >= 0) {
        candidates.push({ field: target.key, col: i, score: 1000 - rank });
        continue;
      }
      // Substring fallback: "Primary Home Phone" contains "homephone".
      const hit = target.synonyms.findIndex((syn) => syn.length >= 4 && cols[i].includes(syn));
      if (hit >= 0) candidates.push({ field: target.key, col: i, score: 500 - hit });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.col - b.col);

  const mapping = {};
  const usedCols = new Set();
  for (const c of candidates) {
    if (mapping[c.field] !== undefined || usedCols.has(c.col)) continue;
    mapping[c.field] = c.col;
    usedCols.add(c.col);
  }
  return mapping;
}

/** Does this export put each person on their own row? */
export function looksPerPerson(rows, mapping) {
  if (rows.length < 3) return false;
  const hasPersonName = mapping.fullName !== undefined || mapping.firstName !== undefined;
  if (!hasPersonName) return false;
  const keys = rows.slice(1).map((r) => householdKeyFor(r, mapping));
  const unique = new Set(keys.filter(Boolean));
  // Fewer households than rows means rows are being grouped.
  return unique.size > 0 && unique.size < keys.length;
}

function cellAt(row, idx) {
  return idx === undefined || idx === null ? '' : str(row[idx]);
}

function householdKeyFor(row, mapping) {
  const id = cellAt(row, mapping.householdId);
  if (id) return `id:${norm(id)}`;
  // Failing an ID, a household is a surname at an address. Imperfect for two
  // families sharing a house, which is why the office sees the grouping before
  // any links are generated.
  const name = cellAt(row, mapping.householdName) || cellAt(row, mapping.lastName);
  const street = cellAt(row, mapping.street);
  const key = `${norm(name)}|${norm(street)}`;
  return key === '|' ? '' : `k:${key}`;
}

// ---------------------------------------------------------------------------
// Building households
// ---------------------------------------------------------------------------

/**
 * @returns {{records: Array, warnings: string[]}}
 */
export function buildRecords(rows, mapping, options = {}) {
  const warnings = [];
  if (!rows || rows.length < 2) return { records: [], warnings: ['The file has no data rows.'] };

  const data = rows.slice(1).filter((r) => r.some((v) => str(v) !== ''));
  if (!data.length) return { records: [], warnings: ['The file has no data rows.'] };

  const groups = new Map();
  let ungrouped = 0;

  data.forEach((row, i) => {
    let key = householdKeyFor(row, mapping);
    if (!key) {
      // No name and no address: keep the row rather than dropping it silently,
      // but it can only ever be its own household.
      key = `row:${i}`;
      ungrouped++;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  if (ungrouped) {
    warnings.push(`${ungrouped} row${ungrouped === 1 ? '' : 's'} had no family name or address, so ${ungrouped === 1 ? 'it was' : 'they were'} treated as separate households.`);
  }

  const records = [];
  let n = 0;

  for (const rowsFor of groups.values()) {
    n++;
    const first = rowsFor[0];
    // Household details can be blank on a child's row, so take the first row
    // that actually carries each one.
    const pick = (field) => {
      for (const r of rowsFor) {
        const v = cellAt(r, mapping[field]);
        if (v) return v;
      }
      return '';
    };

    const lastNames = rowsFor.map((r) => cellAt(r, mapping.lastName)).filter(Boolean);
    const household = pick('householdName') || lastNames[0] || '';

    const people = [];
    for (const r of rowsFor) {
      const full = cellAt(r, mapping.fullName);
      const firstName = cellAt(r, mapping.firstName);
      const lastName = cellAt(r, mapping.lastName);
      const name = full || [firstName, lastName].filter(Boolean).join(' ');
      if (!name) continue;
      people.push({
        name: tidyName(name),
        role: cellAt(r, mapping.role),
        email: cellAt(r, mapping.email),
        mobile: cellAt(r, mapping.mobile),
        birthday: cellAt(r, mapping.birthday),
      });
    }

    records.push({
      id: cellAt(first, mapping.householdId) || `H${String(n).padStart(4, '0')}`,
      household,
      address: {
        street: pick('street'),
        unit: pick('unit'),
        city: pick('city'),
        state: pick('state'),
        zip: pick('zip'),
      },
      phone: pick('homePhone'),
      email: pick('householdEmail'),
      anniversary: pick('anniversary'),
      people: dedupePeople(people),
    });
  }

  const noAddress = records.filter((r) => !r.address.street).length;
  if (noAddress) {
    warnings.push(`${noAddress} household${noAddress === 1 ? ' has' : 's have'} no street address on file. The form will ask for one.`);
  }
  const noPeople = records.filter((r) => r.people.length === 0).length;
  if (noPeople) {
    warnings.push(`${noPeople} household${noPeople === 1 ? ' has' : 's have'} no names attached — check the name columns are mapped.`);
  }
  if (mapping.householdId === undefined) {
    warnings.push('No family ID column was found, so households were grouped by surname and address and given generated IDs. Mapping a real ID column makes re-importing the updates much easier.');
  }

  return { records, warnings };
}

/** "SMITH, John" and "Smith,John" are the same person listed twice. */
function dedupePeople(people) {
  const seen = new Map();
  for (const p of people) {
    const key = norm(p.name);
    const existing = seen.get(key);
    if (!existing) { seen.set(key, p); continue; }
    // Keep whichever copy carries more detail.
    for (const f of ['role', 'email', 'mobile', 'birthday']) {
      if (!existing[f] && p[f]) existing[f] = p[f];
    }
  }
  return [...seen.values()];
}

/** Exports often carry "Smith, John" — flip it, and fix shouted names. */
export function tidyName(raw) {
  let name = str(raw).replace(/\s+/g, ' ');
  const m = name.match(/^([^,]+),\s*(.+)$/);
  if (m) name = `${m[2]} ${m[1]}`;
  // Only touch the case when the whole name is shouted or whispered — a name
  // the office typed as "Mary Jo VanDyke" is deliberate and must survive.
  if (name === name.toUpperCase() || name === name.toLowerCase()) {
    name = name.toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .replace(/\bMc([a-z])/g, (_, c) => `Mc${c.toUpperCase()}`);
  }
  return name.trim();
}

// ---------------------------------------------------------------------------
// Exports back out
// ---------------------------------------------------------------------------

/** One row per reported change — what the office works through by hand. */
export function updatesToCsv(submissions) {
  const rows = [['Record ID', 'Household', 'Submitted', 'Field', 'Was', 'Now', 'Type', 'Note']];
  for (const s of submissions) {
    if (!s.changes.length) {
      rows.push([s.id, s.household, s.submittedAt, '(confirmed, no changes)', '', '', 'confirmed', s.note || '']);
      continue;
    }
    s.changes.forEach((c, i) => {
      rows.push([s.id, s.household, s.submittedAt, c.field, c.was, c.now, c.kind, i === 0 ? (s.note || '') : '']);
    });
  }
  return toCsv(rows);
}

/** One row per person, corrected — the file to re-import. */
export function directoryToCsv(submissions) {
  const rows = [[
    'Record ID', 'Household', 'Street', 'Apt/Unit', 'City', 'State', 'ZIP',
    'Home Phone', 'Household Email', 'Anniversary',
    'Name', 'Role', 'Email', 'Mobile', 'Birthday', 'Submitted',
  ]];
  for (const s of submissions) {
    const r = s.record || {};
    const a = r.address || {};
    const head = [
      s.id, r.household || '', a.street || '', a.unit || '', a.city || '', a.state || '', a.zip || '',
      r.phone || '', r.email || '', r.anniversary || '',
    ];
    if (!r.people || !r.people.length) {
      rows.push([...head, '', '', '', '', '', s.submittedAt]);
      continue;
    }
    for (const p of r.people) {
      rows.push([...head, p.name || '', p.role || '', p.email || '', p.mobile || '', p.birthday || '', s.submittedAt]);
    }
  }
  return toCsv(rows);
}
