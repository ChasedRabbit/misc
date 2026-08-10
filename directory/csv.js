// csv.js — turning a church-software people export into households, and
// turning the answers back into something the office can re-import.
//
// Pure functions: text in, data out. No DOM, no file API.
//
// This is written against a real export whose header is
//
//   First Name, Preferred Name, Last Name, Birthday, Age, Email,
//   Home Phone, Cell Phone, Address, City, State, Zip Code
//
// which has two properties that drive most of the decisions below:
//
//   1. There is no household or family ID, and no relationship column. Who
//      lives with whom has to be inferred, and the only evidence is the
//      address. See groupHouseholds.
//   2. Age is derived from Birthday ("53 yrs"), so it is never asked about and
//      never written back — it would just go stale against the real birthday.
//
// The column mapping is still by synonym rather than by position, so a
// different export (or a reordered one) still lands correctly, and anything it
// gets wrong can be overridden by hand in the office page.

import { canonicalDate, parseAgeYears, personName, formatPhone } from './directory.js';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

// ---------------------------------------------------------------------------
// Reading and writing CSV
// ---------------------------------------------------------------------------

/** Excel in some locales writes semicolons; exports occasionally use tabs. */
export function detectDelimiter(text) {
  const firstLine = String(text).replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/**
 * A real CSV reader: quoted fields, embedded commas and newlines, doubled
 * quotes, CRLF, and a UTF-8 BOM. Values are trimmed, which is what you want
 * for directory data and would be wrong for almost anything else.
 */
export function parseCsv(text, delimiter) {
  if (typeof text !== 'string') return [];
  const s = text.replace(/^﻿/, '');
  const delim = delimiter || detectDelimiter(s);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
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
  return rows
    .map((row) => row
      .map((cell) => {
        const v = cell === null || cell === undefined ? '' : String(cell);
        return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      })
      .join(','))
    .join('\r\n');
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

const normHeader = (h) => str(h).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Synonyms are ordered best-first; the position is the score, so "cellphone"
 * beats "phone" for the mobile column even though both appear in the list.
 */
export const FIELD_TARGETS = [
  { key: 'first', label: 'First name', level: 'person', required: true,
    synonyms: ['firstname', 'first', 'givenname', 'legalfirstname', 'fname'] },
  { key: 'preferred', label: 'Goes by', level: 'person',
    synonyms: ['preferredname', 'preferred', 'nickname', 'goesby', 'knownas', 'displayname'] },
  { key: 'last', label: 'Last name', level: 'person',
    synonyms: ['lastname', 'last', 'surname', 'familyname', 'lname'] },
  { key: 'birthday', label: 'Birthday', level: 'person',
    synonyms: ['birthday', 'birthdate', 'dateofbirth', 'dob', 'born', 'birth'] },
  { key: 'age', label: 'Age (sorting only)', level: 'person',
    synonyms: ['age', 'currentage'] },
  { key: 'email', label: 'Email', level: 'person',
    synonyms: ['email', 'emailaddress', 'primaryemail', 'personalemail', 'emailaddress1'] },
  { key: 'mobile', label: 'Cell phone', level: 'person',
    synonyms: ['cellphone', 'cell', 'mobilephone', 'mobile', 'cellular', 'textnumber', 'mobilenumber'] },
  { key: 'homePhone', label: 'Home phone', level: 'household',
    synonyms: ['homephone', 'householdphone', 'housephone', 'landline', 'homephonenumber', 'phone', 'primaryphone', 'telephone', 'phonenumber'] },
  { key: 'street', label: 'Address', level: 'household',
    synonyms: ['address', 'addressline1', 'address1', 'streetaddress', 'street', 'mailingaddress', 'homeaddress', 'addr1'] },
  { key: 'unit', label: 'Apt / unit', level: 'household',
    synonyms: ['addressline2', 'address2', 'apt', 'apartment', 'unit', 'suite', 'addr2'] },
  { key: 'city', label: 'City', level: 'household',
    synonyms: ['city', 'town', 'mailingcity'] },
  { key: 'state', label: 'State', level: 'household',
    synonyms: ['state', 'province', 'region', 'mailingstate', 'st'] },
  { key: 'zip', label: 'ZIP', level: 'household',
    synonyms: ['zipcode', 'zip', 'postalcode', 'postal', 'zip5', 'mailingzip'] },
  { key: 'householdId', label: 'Household ID', level: 'household',
    synonyms: ['householdid', 'familyid', 'houseid', 'envelopenumber', 'envelope', 'familynumber', 'recordid', 'memberid', 'id'] },
  { key: 'householdName', label: 'Household name', level: 'household',
    synonyms: ['householdname', 'familyname', 'household', 'family'] },
];

/**
 * Best-guess column assignment. Greedy over (target, header) pairs sorted by
 * how specific the match is, so each header is claimed once and the most
 * confident matches win — "Last Name" goes to the person's surname rather than
 * to the household name, which also lists 'familyname'.
 *
 * @returns {Object<string, number>} target key -> column index
 */
export function guessMapping(headers) {
  const scored = [];
  headers.forEach((h, i) => {
    const n = normHeader(h);
    if (!n) return;
    for (const target of FIELD_TARGETS) {
      const rank = target.synonyms.indexOf(n);
      if (rank >= 0) scored.push({ target: target.key, index: i, score: rank });
    }
  });
  scored.sort((a, b) => a.score - b.score);

  const mapping = {};
  const usedColumns = new Set();
  for (const s of scored) {
    if (mapping[s.target] !== undefined || usedColumns.has(s.index)) continue;
    mapping[s.target] = s.index;
    usedColumns.add(s.index);
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Cleanups worth doing on the way in
// ---------------------------------------------------------------------------

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  newhampshire: 'NH', newjersey: 'NJ', newmexico: 'NM', newyork: 'NY',
  northcarolina: 'NC', northdakota: 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', rhodeisland: 'RI', southcarolina: 'SC',
  southdakota: 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', westvirginia: 'WV', wisconsin: 'WI',
  wyoming: 'WY', districtofcolumbia: 'DC',
};

/** "Tennessee" and "TN" are the same state; the directory should print one. */
export function normalizeState(value) {
  const s = str(value);
  if (!s) return '';
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const key = s.toLowerCase().replace(/[^a-z]/g, '');
  return STATES[key] || s;
}

/** ZIP+4 and stray ".0" from spreadsheet round trips. */
export function normalizeZip(value) {
  const s = str(value).replace(/\.0$/, '');
  const m = s.match(/^(\d{5})(?:[-\s]?(\d{4}))?$/);
  if (!m) return s;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

/** The key households are grouped on. Address only — see groupHouseholds. */
export function addressKey(row) {
  // ZIP+4 is per-delivery-point and gets filled in unevenly across a family's
  // rows, so only the five-digit ZIP takes part in the key. Otherwise one
  // member whose record carries the +4 is silently split into their own
  // household — which is exactly the mistake a family would notice.
  const zip5 = str(row.zip).replace(/\D/g, '').slice(0, 5);
  const parts = [row.street, row.unit, row.city, zip5]
    .map((v) => str(v).toLowerCase())
    .join(' ');
  // Fold the usual abbreviations so "123 Oak St." and "123 Oak Street" meet.
  const folded = parts
    .replace(/\b(street|str)\b/g, 'st')
    .replace(/\b(avenue|ave)\b/g, 'av')
    .replace(/\b(road)\b/g, 'rd')
    .replace(/\b(drive)\b/g, 'dr')
    .replace(/\b(lane)\b/g, 'ln')
    .replace(/\b(court)\b/g, 'ct')
    .replace(/\b(circle|cir)\b/g, 'cr')
    .replace(/\b(boulevard|blvd)\b/g, 'bl')
    .replace(/\b(place)\b/g, 'pl')
    .replace(/\b(apartment|apt|unit|suite|ste)\b/g, '#')
    .replace(/\b(north|n)\b/g, 'n')
    .replace(/\b(south|s)\b/g, 's')
    .replace(/\b(east|e)\b/g, 'e')
    .replace(/\b(west|w)\b/g, 'w');
  return folded.replace(/[^a-z0-9#]/g, '');
}

/**
 * A short, stable ID derived from the address, so an update can be matched
 * back to the right entry in an export that has no ID column of its own. It is
 * computed from the address as it was when the link went out, and carried
 * unchanged in the link — so a family that moves still comes back matchable.
 */
export function householdId(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `H-${(h >>> 0).toString(36).toUpperCase().padStart(7, '0')}`;
}

// ---------------------------------------------------------------------------
// Rows -> households
// ---------------------------------------------------------------------------

function readRow(row, mapping) {
  const get = (key) => {
    const i = mapping[key];
    return i === undefined || i < 0 ? '' : str(row[i]);
  };
  return {
    first: get('first'),
    preferred: get('preferred'),
    last: get('last'),
    birthday: get('birthday'),
    age: get('age'),
    email: get('email'),
    mobile: get('mobile'),
    homePhone: get('homePhone'),
    street: get('street'),
    unit: get('unit'),
    city: get('city'),
    state: normalizeState(get('state')),
    zip: normalizeZip(get('zip')),
    householdId: get('householdId'),
    householdName: get('householdName'),
  };
}

/** The most common non-empty value, so one bad row can't rename a household. */
function commonest(values) {
  const counts = new Map();
  for (const v of values) {
    const s = str(v);
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/**
 * Group people into households.
 *
 * With no family ID in the export, the address is the only evidence available,
 * and it is used on its own rather than combined with the surname. That is a
 * deliberate trade: grouping on address+surname would split every household
 * where a spouse kept their name, or where a grandparent or a stepchild is
 * under the same roof — about 130 addresses here — and wrongly splitting a
 * family is far more visible and more offensive to the family than wrongly
 * merging two, which the office can spot in the review list.
 *
 * People with no address can't be grouped at all, so each becomes a household
 * of one. That is honest: we genuinely don't know who they live with.
 */
export function groupHouseholds(rows, mapping, options = {}) {
  const { maxHouseholdSize = 8 } = options;
  const dataRows = rows.slice(1);
  const groups = new Map();
  const loners = [];
  const warnings = [];
  let skipped = 0;

  for (const raw of dataRows) {
    if (!raw || raw.every((v) => str(v) === '')) { skipped++; continue; }
    const row = readRow(raw, mapping);
    if (!row.first && !row.last) { skipped++; continue; }

    const explicit = str(row.householdId);
    const key = explicit || addressKey(row);
    if (!key) { loners.push(row); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const records = [];
  const push = (key, members) => records.push(buildRecord(key, members));

  for (const [key, members] of groups) {
    // An "address" shared by a crowd is usually a data-entry placeholder — a
    // church office address, or a blank normalised to the same string — not
    // one household. Split it rather than mail one link to forty people.
    if (members.length > maxHouseholdSize) {
      warnings.push({
        kind: 'oversized',
        count: members.length,
        address: [members[0].street, members[0].city].filter(Boolean).join(', '),
        message: `${members.length} people share one address — split into separate households for safety.`,
      });
      for (const m of members) push(`${key}|${m.first}${m.last}`, [m]);
      continue;
    }
    push(key, members);
  }
  for (const m of loners) push(`noaddr|${m.first}${m.last}${m.email}`, [m]);

  if (loners.length) {
    warnings.push({
      kind: 'no-address',
      count: loners.length,
      message: `${loners.length} people have no address on file, so each is listed on their own.`,
    });
  }
  if (skipped) {
    warnings.push({ kind: 'skipped', count: skipped, message: `${skipped} rows skipped (no name).` });
  }

  // Two people with the same name, no address and no email hash to the same
  // ID. That is rare but real, and a duplicate ID would send both families'
  // updates to the same record — so uniqueness is enforced rather than hoped
  // for. Order comes from the file, so regenerating links gives the same IDs.
  const seenIds = new Set();
  for (const r of records) {
    if (!seenIds.has(r.id)) { seenIds.add(r.id); continue; }
    let n = 2;
    let candidate = `${r.id}-${n}`;
    while (seenIds.has(candidate)) candidate = `${r.id}-${++n}`;
    r.id = candidate;
    seenIds.add(candidate);
  }

  const mixed = records.filter((r) => r.surnames.length > 1).length;
  if (mixed) {
    warnings.push({
      kind: 'mixed-surnames',
      count: mixed,
      message: `${mixed} households contain more than one surname — worth a glance before sending.`,
    });
  }

  return { records, warnings };
}

function buildRecord(key, members) {
  const sorted = members.slice().sort((a, b) => {
    // Oldest first, which puts parents above children without needing a
    // relationship column. Anyone with no age keeps their original order.
    const ay = parseAgeYears(a.age);
    const by = parseAgeYears(b.age);
    if (ay === null && by === null) return 0;
    if (ay === null) return 1;
    if (by === null) return -1;
    return by - ay;
  });

  const surnames = [...new Set(sorted.map((m) => str(m.last)).filter(Boolean))];
  const explicitName = commonest(sorted.map((m) => m.householdName));
  // A handful of rows carry no surname at all; fall back to what we do know
  // rather than leaving a household with no name on the page.
  const household = explicitName || surnames.join(' & ') || personName(sorted[0]);

  const first = sorted[0] || {};
  const address = {
    street: commonest(sorted.map((m) => m.street)) || str(first.street),
    unit: commonest(sorted.map((m) => m.unit)),
    city: commonest(sorted.map((m) => m.city)),
    state: commonest(sorted.map((m) => m.state)),
    zip: commonest(sorted.map((m) => m.zip)),
  };

  const id = commonest(sorted.map((m) => m.householdId)) || householdId(key);

  return {
    id,
    household,
    surnames,
    address,
    phone: commonest(sorted.map((m) => m.homePhone)),
    email: '',
    anniversary: '',
    people: sorted.map((m, i) => ({
      _k: `p${i}`,
      first: m.first,
      preferred: m.preferred,
      last: m.last,
      email: m.email,
      mobile: m.mobile,
      birthday: canonicalDate(m.birthday),
    })),
    note: '',
  };
}

/** Where a link can be sent, and by which route. */
export function contactRoutes(record) {
  const emails = [...new Set(record.people.map((p) => str(p.email)).filter(Boolean))];
  const mobiles = [...new Set(record.people.map((p) => str(p.mobile)).filter(Boolean))];
  const phones = [...new Set([str(record.phone), ...mobiles].filter(Boolean))];
  return { emails, mobiles, phones, reachable: emails.length > 0 || phones.length > 0 };
}

// ---------------------------------------------------------------------------
// Exports back out
// ---------------------------------------------------------------------------

const UPDATE_HEADER = [
  'Household ID', 'Household', 'Submitted', 'Change count',
  'Person', 'Field', 'Was', 'Now', 'Kind', 'Note',
];

/**
 * One row per change, with the old value beside the new one. The "was" column
 * is what makes this usable against an export that has no ID: it is how the
 * office finds the right record to edit.
 */
export function updatesToCsv(submissions) {
  const rows = [UPDATE_HEADER];
  for (const s of submissions) {
    if (!s.changes || s.changes.length === 0) {
      rows.push([s.id, s.household, s.submittedAt, 0, '', 'CONFIRMED — no changes', '', '', 'confirmed', s.note || '']);
      continue;
    }
    for (const c of s.changes) {
      const [person, field] = c.field.includes(' — ') ? c.field.split(' — ') : ['', c.field];
      rows.push([s.id, s.household, s.submittedAt, s.changes.length, person, field, c.was, c.now, c.kind, s.note || '']);
    }
  }
  return toCsv(rows);
}

const DIRECTORY_HEADER = [
  'Household ID', 'First Name', 'Preferred Name', 'Last Name', 'Birthday',
  'Email', 'Home Phone', 'Cell Phone', 'Address', 'Apt', 'City', 'State', 'Zip Code',
  'Confirmed', 'Submitted',
];

/**
 * The corrected directory, one row per person, in the shape the export came
 * in. Age is deliberately absent: it is derived from the birthday, and writing
 * a stale one back would be worse than leaving the system to recompute it.
 */
export function directoryToCsv(records, status = {}) {
  const rows = [DIRECTORY_HEADER];
  for (const r of records) {
    const st = status[r.id] || {};
    for (const p of r.people) {
      rows.push([
        r.id, p.first, p.preferred, p.last, p.birthday,
        p.email, formatPhone(r.phone), formatPhone(p.mobile),
        r.address.street, r.address.unit, r.address.city, r.address.state, r.address.zip,
        st.confirmed ? 'yes' : '', st.submittedAt || '',
      ]);
    }
  }
  return toCsv(rows);
}

/** The mail-merge sheet: one row per household, with its personal link. */
export function linksToCsv(records, baseUrl, buildLink) {
  const rows = [['Household ID', 'Household', 'People', 'Address', 'Emails', 'Phones', 'Link']];
  for (const r of records) {
    const routes = contactRoutes(r);
    rows.push([
      r.id,
      r.household,
      r.people.map(personName).join('; '),
      [r.address.street, r.address.city, r.address.state, r.address.zip].filter(Boolean).join(', '),
      routes.emails.join('; '),
      routes.phones.map(formatPhone).join('; '),
      buildLink(baseUrl, r),
    ]);
  }
  return toCsv(rows);
}
