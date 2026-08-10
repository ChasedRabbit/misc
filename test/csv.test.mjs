import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, toCsv, detectDelimiter, guessMapping, normalizeState, normalizeZip,
  addressKey, householdId, groupHouseholds, contactRoutes, updatesToCsv,
  directoryToCsv, linksToCsv,
} from '../directory/csv.js';
import { buildLink, personName, decodeRecord } from '../directory/directory.js';

// The header of the real export this was written against.
const HEADER = '"First Name","Preferred Name","Last Name",Birthday,Age,Email,"Home Phone","Cell Phone",Address,City,State,"Zip Code"';

const row = (...cells) => cells.join(',');
const FIXTURE = [
  HEADER,
  row('Harold', 'Hal', 'Fielden', '03/04/1971', '54 yrs', 'hal@example.com', '615-555-0142', '615-555-0143', '"1204 Oak Ridge Rd"', 'Franklin', 'TN', '37064'),
  row('Sarah', '', 'Fielden', '11/12/1973', '52 yrs', 'sarah@example.com', '615-555-0142', '', '"1204 Oak Ridge Rd"', 'Franklin', 'Tennessee', '37064'),
  row('Emma', '', 'Fielden', '07/22/2009', '16 yrs', '', '', '', '"1204 Oak Ridge Rd."', 'Franklin', 'TN', '37064-1234'),
  row('Ruth', '', 'Calloway', '01/09/1948', '77 yrs', '', '615-555-0170', '', '"1204 Oak Ridge Rd"', 'Franklin', 'TN', '37064'),
  row('Peter', '', 'Nkemi', '', '', 'peter@example.com', '', '615-555-0180', '', '', '', ''),
].join('\n');

function load(text) {
  const rows = parseCsv(text);
  return groupHouseholds(rows, guessMapping(rows[0]));
}

test('the real export header maps onto every field it should', () => {
  const headers = parseCsv(HEADER)[0];
  const m = guessMapping(headers);
  assert.deepEqual(headers, [
    'First Name', 'Preferred Name', 'Last Name', 'Birthday', 'Age', 'Email',
    'Home Phone', 'Cell Phone', 'Address', 'City', 'State', 'Zip Code',
  ]);
  assert.equal(m.first, 0);
  assert.equal(m.preferred, 1);
  assert.equal(m.last, 2);
  assert.equal(m.birthday, 3);
  assert.equal(m.age, 4);
  assert.equal(m.email, 5);
  assert.equal(m.homePhone, 6);
  assert.equal(m.mobile, 7);
  assert.equal(m.street, 8);
  assert.equal(m.city, 9);
  assert.equal(m.state, 10);
  assert.equal(m.zip, 11);
  assert.equal(m.householdId, undefined, 'this export has no ID column');
});

test('"Cell Phone" wins the mobile column and "Home Phone" the household one', () => {
  const m = guessMapping(['Phone', 'Cell Phone', 'Home Phone']);
  assert.equal(m.mobile, 1);
  assert.equal(m.homePhone, 2);
  assert.notEqual(m.homePhone, 0, 'the specific match beats the generic one');
});

test('no column is claimed by two fields', () => {
  const m = guessMapping(['Last Name', 'Family Name', 'First Name']);
  const used = Object.values(m);
  assert.equal(new Set(used).size, used.length);
  assert.equal(m.last, 0);
  assert.equal(m.householdName, 1);
});

test('quoted fields, embedded commas and CRLF all parse', () => {
  const rows = parseCsv('a,b\r\n"one, two","he said ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['one, two', 'he said "hi"']]);
});

test('a UTF-8 BOM does not poison the first column name', () => {
  const rows = parseCsv('﻿First Name,Last Name\nAda,Lovelace');
  assert.equal(rows[0][0], 'First Name');
});

test('an embedded newline inside quotes stays one field', () => {
  const rows = parseCsv('a,b\n"line one\nline two",x');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], 'line one\nline two');
});

test('semicolon exports are detected', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

test('csv output quotes only what needs quoting, and round trips', () => {
  const rows = [['plain', 'has,comma', 'has"quote'], ['x', 'y', 'z']];
  const text = toCsv(rows);
  assert.equal(text.split('\r\n')[0], 'plain,"has,comma","has""quote"');
  assert.deepEqual(parseCsv(text), rows);
});

test('states and ZIPs are tidied on the way in', () => {
  assert.equal(normalizeState('Tennessee'), 'TN');
  assert.equal(normalizeState('tn'), 'TN');
  assert.equal(normalizeState('North Carolina'), 'NC');
  assert.equal(normalizeState('Ontario'), 'Ontario', 'unknown values are left alone');
  assert.equal(normalizeZip('37064-1234'), '37064-1234');
  assert.equal(normalizeZip('37064.0'), '37064');
});

test('address keys fold the abbreviations people actually vary', () => {
  const a = { street: '1204 Oak Ridge Rd', city: 'Franklin', zip: '37064' };
  const b = { street: '1204 Oak Ridge Road', city: 'Franklin', zip: '37064' };
  const c = { street: '1204 Oak Ridge Rd.', city: 'Franklin', zip: '37064-1234' };
  assert.equal(addressKey(a), addressKey(b));
  assert.equal(addressKey(a), addressKey(c), 'ZIP+4 must not split a household');
  const other = { street: '1206 Oak Ridge Rd', city: 'Franklin', zip: '37064' };
  assert.notEqual(addressKey(a), addressKey(other));
});

test('apartment numbers keep separate households apart', () => {
  const a = addressKey({ street: '10 Main St Apt 4', city: 'Franklin', zip: '37064' });
  const b = addressKey({ street: '10 Main St Apt 5', city: 'Franklin', zip: '37064' });
  assert.notEqual(a, b);
});

test('household IDs are stable and distinct', () => {
  assert.equal(householdId('abc'), householdId('abc'));
  assert.notEqual(householdId('abc'), householdId('abd'));
  assert.match(householdId('abc'), /^H-[0-9A-Z]{7}$/);
});

test('an address groups a household even across different surnames', () => {
  const { records } = load(FIXTURE);
  const home = records.find((r) => r.address.street.startsWith('1204'));
  assert.equal(home.people.length, 4, 'the grandmother belongs in the household');
  assert.deepEqual(home.surnames, ['Calloway', 'Fielden']);
  assert.equal(home.household, 'Calloway & Fielden');
});

test('a household is ordered oldest first, so parents lead', () => {
  const { records } = load(FIXTURE);
  const home = records.find((r) => r.address.street.startsWith('1204'));
  assert.deepEqual(home.people.map(personName), [
    'Ruth Calloway', 'Hal Fielden', 'Sarah Fielden', 'Emma Fielden',
  ]);
});

test('conflicting spellings resolve to the commonest, not the first seen', () => {
  const { records } = load(FIXTURE);
  const home = records.find((r) => r.address.street.startsWith('1204'));
  assert.equal(home.address.state, 'TN', '"Tennessee" was normalised then outvoted');
  assert.equal(home.address.zip, '37064');
  assert.equal(home.phone, '615-555-0142', 'the shared landline, not the outlier');
});

test('someone with no address becomes a household of one', () => {
  const { records, warnings } = load(FIXTURE);
  const peter = records.find((r) => r.people[0].first === 'Peter');
  assert.equal(peter.people.length, 1);
  assert.ok(warnings.some((w) => w.kind === 'no-address' && w.count === 1));
});

test('mixed-surname households are surfaced for review rather than split', () => {
  const { warnings } = load(FIXTURE);
  const w = warnings.find((x) => x.kind === 'mixed-surnames');
  assert.equal(w.count, 1);
});

test('a crowd at one address is split rather than mailed a single link', () => {
  const many = [HEADER];
  for (let i = 0; i < 12; i++) {
    many.push(row(`Person${i}`, '', 'Doe', '', '', '', '', '', '"1 Church St"', 'Franklin', 'TN', '37064'));
  }
  const rows = parseCsv(many.join('\n'));
  const { records, warnings } = groupHouseholds(rows, guessMapping(rows[0]));
  assert.equal(records.length, 12);
  assert.ok(warnings.some((w) => w.kind === 'oversized' && w.count === 12));
});

test('rows without a name are skipped and counted', () => {
  const rows = parseCsv([HEADER, row('', '', '', '', '', 'ghost@example.com', '', '', '', '', '', '')].join('\n'));
  const { records, warnings } = groupHouseholds(rows, guessMapping(rows[0]));
  assert.equal(records.length, 0);
  assert.ok(warnings.some((w) => w.kind === 'skipped' && w.count === 1));
});

test('an explicit household ID column is trusted over the address', () => {
  const rows = parseCsv([
    'Family ID,First Name,Last Name,Address,City,Zip Code',
    'F-9,Ann,Reid,10 Main St,Franklin,37064',
    'F-9,Bob,Reid,99 Elsewhere Ave,Franklin,37064',
  ].join('\n'));
  const { records } = groupHouseholds(rows, guessMapping(rows[0]));
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'F-9');
});

test('contact routes report how a household can actually be reached', () => {
  const { records } = load(FIXTURE);
  const home = records.find((r) => r.address.street.startsWith('1204'));
  const routes = contactRoutes(home);
  assert.deepEqual(routes.emails, ['hal@example.com', 'sarah@example.com']);
  assert.ok(routes.reachable);

  const unreachable = contactRoutes({ phone: '', people: [{ email: '', mobile: '' }] });
  assert.equal(unreachable.reachable, false);
});

test('every generated household record makes a decodable link', () => {
  const { records } = load(FIXTURE);
  for (const r of records) {
    const round = decodeRecord(buildLink('https://example.org/d/', r).split('#r=')[1]);
    assert.equal(round.id, r.id);
    assert.equal(round.people.length, r.people.length);
    assert.equal(personName(round.people[0]), personName(r.people[0]));
  }
});

test('the links sheet carries a working link per household', () => {
  const { records } = load(FIXTURE);
  const rows = parseCsv(linksToCsv(records, 'https://example.org/d/', buildLink));
  assert.equal(rows.length, records.length + 1);
  assert.equal(rows[0][6], 'Link');
  assert.ok(rows[1][6].includes('#r='));
});

test('the updates sheet puts the old value beside the new one', () => {
  const csv = updatesToCsv([
    {
      id: 'H-1', household: 'The Fielden Family', submittedAt: '2026-08-10', note: 'thanks',
      changes: [{ field: 'Sarah Fielden — Cell phone', was: '(615) 555-0144', now: '(615) 555-0199', kind: 'changed' }],
    },
    { id: 'H-2', household: 'The Nkemi Family', submittedAt: '2026-08-10', changes: [] },
  ]);
  const rows = parseCsv(csv);
  assert.equal(rows[1][4], 'Sarah Fielden');
  assert.equal(rows[1][5], 'Cell phone');
  assert.equal(rows[1][6], '(615) 555-0144');
  assert.equal(rows[1][7], '(615) 555-0199');
  assert.equal(rows[2][5], 'CONFIRMED — no changes');
});

test('the corrected directory exports one row per person and no Age column', () => {
  const { records } = load(FIXTURE);
  const rows = parseCsv(directoryToCsv(records, { [records[0].id]: { confirmed: true, submittedAt: '2026-08-10' } }));
  assert.ok(!rows[0].includes('Age'), 'Age is derived from Birthday and must not be written back');
  assert.equal(rows.length, 1 + records.reduce((n, r) => n + r.people.length, 0));
  assert.equal(rows[0][1], 'First Name');
});

test('an empty file is handled without throwing', () => {
  assert.deepEqual(parseCsv(''), []);
  const { records, warnings } = groupHouseholds([], {});
  assert.deepEqual(records, []);
  assert.deepEqual(warnings, []);
});

test('household IDs stay unique even when two records are indistinguishable', () => {
  // Same name, no address, no email: the natural key collides.
  const rows = parseCsv([HEADER,
    row('John', '', 'Smith', '', '', '', '', '', '', '', '', ''),
    row('John', '', 'Smith', '', '', '', '', '', '', '', '', ''),
  ].join('\n'));
  const { records } = groupHouseholds(rows, guessMapping(rows[0]));
  assert.equal(records.length, 2);
  assert.notEqual(records[0].id, records[1].id, 'two families must not share an ID');
});

test('a household with no surname on file still gets a name', () => {
  const rows = parseCsv([HEADER, row('Prince', '', '', '', '', 'p@example.com', '', '', '', '', '', '')].join('\n'));
  const { records } = groupHouseholds(rows, guessMapping(rows[0]));
  assert.equal(records[0].household, 'Prince');
});
