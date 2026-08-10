// directory.js — pure logic for the church directory update form.
//
// No DOM, no network, no storage. Everything here is a function from data to
// data, which is what makes the interesting parts testable: what counts as a
// change, how a record survives a round trip through a link, and what the
// office actually receives.
//
// The design premise of the whole tool is that most families have nothing to
// update. Someone who hasn't moved in ten years should confirm and be done, so
// the form's job is to make "nothing changed" a single tap and to submit only
// the fields that genuinely differ. That means the comparison has to be
// forgiving: (804) 555-0142 and 804.555.0142 are the same phone number, and
// nobody should get an email saying their number changed because of a hyphen.

export const SCHEMA_VERSION = 1;

/** Fields on a person, in display order, with the comparison rule for each. */
export const PERSON_FIELDS = [
  { key: 'name', label: 'Name', kind: 'text' },
  { key: 'role', label: 'Role', kind: 'text' },
  { key: 'email', label: 'Email', kind: 'email' },
  { key: 'mobile', label: 'Mobile', kind: 'phone' },
  { key: 'birthday', label: 'Birthday', kind: 'date' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export function blankRecord() {
  return {
    id: '',
    household: '',
    address: { street: '', unit: '', city: '', state: '', zip: '' },
    phone: '',
    email: '',
    anniversary: '',
    people: [],
    note: '',
  };
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Fill in a partial record and give every person a stable key. The keys are
 * what the diff matches on, so that adding or removing someone doesn't make it
 * look like everyone below them changed their name.
 */
export function normalizeRecord(raw) {
  const base = blankRecord();
  const r = raw && typeof raw === 'object' ? raw : {};
  const addr = r.address && typeof r.address === 'object' ? r.address : {};
  const people = Array.isArray(r.people) ? r.people : [];

  return {
    ...base,
    id: str(r.id),
    household: str(r.household),
    address: {
      street: str(addr.street),
      unit: str(addr.unit),
      city: str(addr.city),
      state: str(addr.state),
      zip: str(addr.zip),
    },
    phone: str(r.phone),
    email: str(r.email),
    anniversary: canonicalDate(r.anniversary),
    note: str(r.note),
    people: people.map((p, i) => ({
      _k: str(p && p._k) || `p${i}`,
      name: str(p && p.name),
      role: str(p && p.role),
      email: str(p && p.email),
      mobile: str(p && p.mobile),
      birthday: canonicalDate(p && p.birthday),
    })),
  };
}

export function cloneRecord(record) {
  return normalizeRecord(JSON.parse(JSON.stringify(record)));
}

/** A person key that cannot collide with any key already in the record. */
export function nextPersonKey(record) {
  const used = new Set((record.people || []).map((p) => p._k));
  for (let i = 1; ; i++) {
    const k = `n${i}`;
    if (!used.has(k)) return k;
  }
}

// ---------------------------------------------------------------------------
// Dates
//
// Directories print "Mar 4", not a year, but exports often carry a full date of
// birth. We keep the year when we're given one and never show it, so that a
// family confirming their record can't accidentally strip it — see
// canonicalDate/mergeDate below.
// ---------------------------------------------------------------------------

/** @returns {{month:number, day:number}|null} */
export function parseDayMonth(input) {
  const s = str(input);
  if (!s) return null;

  // 2026-03-04, and the XML-ish --03-04 that some systems use for "no year".
  let m = s.match(/^(?:(\d{4})-)?-?-?(\d{1,2})-(\d{1,2})$/);
  if (m) return check(Number(m[2]), Number(m[3]));

  // 3/4 or 3/4/1975
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) return check(Number(m[1]), Number(m[2]));

  // Mar 4, March 4, 4 March
  const words = s.toLowerCase().replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  let month = null;
  let day = null;
  for (const w of words) {
    const idx = MONTH_NAMES.findIndex((n) => n.startsWith(w) && w.length >= 3);
    if (idx >= 0 && month === null) month = idx + 1;
    else if (/^\d{1,2}$/.test(w) && day === null) day = Number(w);
  }
  if (month !== null && day !== null) return check(month, day);
  return null;

  function check(mo, d) {
    if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
    return { month: mo, day: d };
  }
}

function yearOf(input) {
  const s = str(input);
  let m = s.match(/^(\d{4})-\d{1,2}-\d{1,2}$/);
  if (m) return m[1];
  m = s.match(/^\d{1,2}\/\d{1,2}\/(\d{2,4})$/);
  if (m) return m[1].length === 2 ? `19${m[1]}` : m[1];
  return '';
}

const pad = (n) => String(n).padStart(2, '0');

/** Store as YYYY-MM-DD when a year is known, MM-DD when it isn't. */
export function canonicalDate(input) {
  const dm = parseDayMonth(input);
  if (!dm) return str(input);
  const y = yearOf(input);
  return `${y ? `${y}-` : ''}${pad(dm.month)}-${pad(dm.day)}`;
}

/**
 * Apply an edited date on top of the stored one, keeping a year the form never
 * showed. A family retyping "Mar 4" over a stored 1975-03-04 means "still the
 * fourth of March", not "delete the year we had".
 */
export function mergeDate(previous, edited) {
  const next = canonicalDate(edited);
  const a = parseDayMonth(previous);
  const b = parseDayMonth(next);
  if (!a || !b) return next;
  if (a.month !== b.month || a.day !== b.day) return next;
  const y = yearOf(previous);
  return y ? `${y}-${pad(b.month)}-${pad(b.day)}` : next;
}

export function formatDate(stored) {
  const dm = parseDayMonth(stored);
  if (!dm) return str(stored);
  return `${MONTHS[dm.month - 1]} ${dm.day}`;
}

// ---------------------------------------------------------------------------
// Phones, emails, addresses
// ---------------------------------------------------------------------------

export function formatPhone(input) {
  const s = str(input);
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return s;
}

export function addressLine(addr) {
  if (!addr) return '';
  const street = [str(addr.street), str(addr.unit)].filter(Boolean).join(' ');
  const cityState = [str(addr.city), str(addr.state)].filter(Boolean).join(', ');
  const tail = [cityState, str(addr.zip)].filter(Boolean).join(' ');
  return [street, tail].filter(Boolean).join(', ');
}

export function addressLines(addr) {
  if (!addr) return [];
  const street = [str(addr.street), str(addr.unit)].filter(Boolean).join(' ');
  const cityState = [str(addr.city), str(addr.state)].filter(Boolean).join(', ');
  const tail = [cityState, str(addr.zip)].filter(Boolean).join(' ');
  return [street, tail].filter(Boolean);
}

export function householdTitle(record) {
  const name = str(record && record.household);
  if (!name) return 'Your household';
  if (/\bfamily\b|\bhousehold\b/i.test(name)) return name;
  return `The ${name} Family`;
}

export function personName(p) {
  return str(p && p.name) || 'Unnamed person';
}

export function personSummary(p) {
  const bits = [
    str(p.email),
    formatPhone(p.mobile),
    p.birthday ? `b. ${formatDate(p.birthday)}` : '',
  ].filter(Boolean);
  return [personName(p), bits.join(' · ')].filter(Boolean).join(' — ');
}

/** Is this record so empty that there's nothing to confirm? */
export function isEmptyRecord(record) {
  const r = normalizeRecord(record);
  return !r.household && !addressLine(r.address) && !r.phone && !r.email && r.people.length === 0;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const COMPARE = {
  phone: (v) => str(v).replace(/\D/g, ''),
  email: (v) => str(v).toLowerCase(),
  text: (v) => str(v).replace(/\s+/g, ' ').toLowerCase(),
  date: (v) => {
    const dm = parseDayMonth(v);
    return dm ? `${pad(dm.month)}-${pad(dm.day)}` : str(v).toLowerCase();
  },
};

/** Equal for the purposes of "did anything actually change?" */
export function sameValue(a, b, kind = 'text') {
  const norm = COMPARE[kind] || COMPARE.text;
  return norm(a) === norm(b);
}

function changeKind(from, to) {
  if (!str(from)) return 'added';
  if (!str(to)) return 'removed';
  return 'changed';
}

/**
 * What differs between the record we sent out and the record that came back.
 *
 * The address is compared as a single unit on purpose: a family that moves
 * changes four fields at once, and "Address: was X, now Y" is what a human
 * wants to read, not four separate lines about the city and the ZIP.
 */
export function diffRecord(before, after) {
  const a = normalizeRecord(before);
  const b = normalizeRecord(after);
  const changes = [];

  const household = [
    { key: 'household', label: 'Family name', kind: 'text' },
    { key: 'phone', label: 'Home phone', kind: 'phone', format: formatPhone },
    { key: 'email', label: 'Household email', kind: 'email' },
    { key: 'anniversary', label: 'Anniversary', kind: 'date', format: formatDate },
  ];
  for (const f of household) {
    if (sameValue(a[f.key], b[f.key], f.kind)) continue;
    const fmt = f.format || ((v) => str(v));
    changes.push({
      scope: 'household',
      key: f.key,
      label: f.label,
      from: fmt(a[f.key]),
      to: fmt(b[f.key]),
      kind: changeKind(a[f.key], b[f.key]),
    });
  }

  const beforeAddr = addressLine(a.address);
  const afterAddr = addressLine(b.address);
  if (!sameValue(beforeAddr, afterAddr, 'text')) {
    changes.push({
      scope: 'household',
      key: 'address',
      label: 'Address',
      from: beforeAddr,
      to: afterAddr,
      kind: changeKind(beforeAddr, afterAddr),
    });
  }

  const remaining = new Map(a.people.map((p) => [p._k, p]));
  for (const person of b.people) {
    const was = remaining.get(person._k);
    if (!was) {
      changes.push({
        scope: 'person',
        key: `person:${person._k}`,
        label: 'Added to household',
        person: personName(person),
        from: '',
        to: personSummary(person),
        kind: 'person-added',
      });
      continue;
    }
    remaining.delete(person._k);
    for (const f of PERSON_FIELDS) {
      if (sameValue(was[f.key], person[f.key], f.kind)) continue;
      const fmt = f.kind === 'phone' ? formatPhone : f.kind === 'date' ? formatDate : (v) => str(v);
      changes.push({
        scope: 'person',
        key: `person:${person._k}:${f.key}`,
        label: f.label,
        // Name changes read better against the old name.
        person: f.key === 'name' ? personName(was) : personName(person),
        from: fmt(was[f.key]),
        to: fmt(person[f.key]),
        kind: changeKind(was[f.key], person[f.key]),
      });
    }
  }
  for (const gone of remaining.values()) {
    changes.push({
      scope: 'person',
      key: `person:${gone._k}`,
      label: 'No longer in this household',
      person: personName(gone),
      from: personSummary(gone),
      to: '',
      kind: 'person-removed',
    });
  }

  return changes;
}

/** One line of plain English for a single change. */
export function describeChange(c) {
  if (c.kind === 'person-added') return `Added to household: ${c.to}`;
  if (c.kind === 'person-removed') return `No longer in this household: ${c.person}`;
  const what = c.scope === 'person' ? `${c.person} — ${c.label}` : c.label;
  if (c.kind === 'added') return `${what}: ${c.to} (was blank)`;
  if (c.kind === 'removed') return `${what}: removed (was ${c.from})`;
  return `${what}: ${c.from} → ${c.to}`;
}

/** Fields we hold but the family left untouched — reassuring to list back. */
export function unchangedSummary(before, after) {
  const a = normalizeRecord(before);
  const changed = new Set(diffRecord(before, after).map((c) => c.key));
  const out = [];
  if (addressLine(a.address) && !changed.has('address')) out.push('address');
  if (a.phone && !changed.has('phone')) out.push('home phone');
  for (const p of a.people) {
    const touched = [...changed].some((k) => k.startsWith(`person:${p._k}`));
    if (!touched) out.push(personName(p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * The plain-text body the office receives. Deliberately readable by a person
 * rather than by a parser — whoever is retyping this into the church database
 * needs to see the old value next to the new one.
 */
export function submissionText(before, after, meta = {}) {
  const b = normalizeRecord(before);
  const a = normalizeRecord(after);
  const changes = diffRecord(b, a);
  const lines = [];

  lines.push(`DIRECTORY UPDATE — ${householdTitle(a)}`);
  if (b.id) lines.push(`Record ID: ${b.id}`);
  if (meta.submittedAt) lines.push(`Submitted: ${meta.submittedAt}`);
  lines.push('');

  if (changes.length === 0) {
    lines.push('CONFIRMED — no changes. Everything on file is correct.');
  } else {
    lines.push(`CHANGES (${changes.length})`);
    for (const c of changes) lines.push(`  • ${describeChange(c)}`);
  }

  if (a.note) {
    lines.push('');
    lines.push('NOTE FROM THE FAMILY');
    lines.push(`  ${a.note}`);
  }

  if (changes.length > 0) {
    const untouched = unchangedSummary(b, a);
    if (untouched.length) {
      lines.push('');
      lines.push(`Confirmed unchanged: ${untouched.join(', ')}.`);
    }
  }

  return lines.join('\n');
}

export function submissionSubject(before, after) {
  const a = normalizeRecord(after);
  const n = diffRecord(before, after).length;
  const what = n === 0 ? 'no changes' : `${n} change${n === 1 ? '' : 's'}`;
  const id = normalizeRecord(before).id;
  return `Directory update — ${householdTitle(a)}${id ? ` (${id})` : ''} — ${what}`;
}

export function mailtoUrl({ to, subject, body }) {
  const qs = [];
  if (subject) qs.push(`subject=${encodeURIComponent(subject)}`);
  if (body) qs.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${encodeURIComponent(str(to))}${qs.length ? `?${qs.join('&')}` : ''}`;
}

/** Machine-readable form of a submission, for POSTing or for CSV export. */
export function submissionPayload(before, after, meta = {}) {
  const b = normalizeRecord(before);
  const a = normalizeRecord(after);
  const changes = diffRecord(b, a);
  return {
    version: SCHEMA_VERSION,
    id: b.id,
    household: householdTitle(a),
    submittedAt: meta.submittedAt || '',
    confirmed: true,
    changeCount: changes.length,
    changes: changes.map((c) => ({
      field: c.scope === 'person' ? `${c.person} — ${c.label}` : c.label,
      was: c.from,
      now: c.to,
      kind: c.kind,
    })),
    note: a.note,
    record: stripKeys(a),
  };
}

function stripKeys(record) {
  return {
    ...record,
    people: record.people.map(({ _k, ...rest }) => rest),
  };
}

// ---------------------------------------------------------------------------
// Link encoding
//
// The record travels in the URL fragment, which browsers never send to the
// server. That is the entire reason this tool needs no backend and no database
// to hold members' addresses: the only copy of a family's data in transit is
// the one in the link that was mailed to that family.
// ---------------------------------------------------------------------------

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(encoded) {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Trailing blanks cost URL length and carry no information.
function trimTrailing(arr) {
  const out = arr.slice();
  while (out.length && (out[out.length - 1] === '' || out[out.length - 1] === undefined)) out.pop();
  return out;
}

export function packRecord(record) {
  const r = normalizeRecord(record);
  return trimTrailing([
    SCHEMA_VERSION,
    r.id,
    r.household,
    trimTrailing([r.address.street, r.address.unit, r.address.city, r.address.state, r.address.zip]),
    r.phone,
    r.email,
    r.anniversary,
    r.people.map((p) => trimTrailing([p.name, p.role, p.email, p.mobile, p.birthday])),
  ]);
}

export function unpackRecord(packed) {
  if (!Array.isArray(packed)) throw new Error('Not a directory record.');
  const [, id, household, addr, phone, email, anniversary, people] = packed;
  const a = Array.isArray(addr) ? addr : [];
  return normalizeRecord({
    id,
    household,
    address: { street: a[0], unit: a[1], city: a[2], state: a[3], zip: a[4] },
    phone,
    email,
    anniversary,
    people: (Array.isArray(people) ? people : []).map((p) => {
      const q = Array.isArray(p) ? p : [];
      return { name: q[0], role: q[1], email: q[2], mobile: q[3], birthday: q[4] };
    }),
  });
}

export function encodeRecord(record) {
  return b64urlEncode(JSON.stringify(packRecord(record)));
}

export function decodeRecord(encoded) {
  const text = b64urlDecode(str(encoded));
  const packed = JSON.parse(text);
  if (!Array.isArray(packed) || packed[0] !== SCHEMA_VERSION) {
    throw new Error('This link was made by a different version of the form.');
  }
  return unpackRecord(packed);
}

/**
 * @param base  the page URL families will open, e.g.
 *              https://example.github.io/misc/directory/
 */
export function buildLink(base, record) {
  const clean = str(base).split('#')[0];
  return `${clean}#r=${encodeRecord(record)}`;
}

export function escapeHtml(value) {
  return str(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** A sample household so the page is explorable without any real data. */
export function demoRecord() {
  return normalizeRecord({
    id: 'H-0142',
    household: 'Fielden',
    address: { street: '1204 Oak Ridge Rd', unit: '', city: 'Glen Allen', state: 'VA', zip: '23060' },
    phone: '8045550142',
    email: '',
    anniversary: '1998-06-13',
    people: [
      { name: 'Harold Fielden', role: 'Head', email: 'hcfielden@example.com', mobile: '8045550143', birthday: '1971-03-04' },
      { name: 'Sarah Fielden', role: 'Spouse', email: 'sarah@example.com', mobile: '8045550144', birthday: '1973-11-12' },
      { name: 'Emma Fielden', role: 'Child', email: '', mobile: '', birthday: '2009-07-22' },
    ],
  });
}
