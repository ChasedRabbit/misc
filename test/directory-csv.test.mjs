import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, toCsv, detectDelimiter, guessMapping, buildRecords,
  looksPerPerson, tidyName, updatesToCsv, directoryToCsv, FIELD_TARGETS,
} from '../directory/csv.js';
import { submissionPayload, normalizeRecord, cloneRecord } from '../directory/directory.js';

// A per-person export, the shape most church systems produce.
const PER_PERSON = [
  'Family ID,Last Name,First Name,Relationship,Address Line 1,City,State,Zip,Home Phone,Cell Phone,Email,Birthdate',
  'F1001,Fielden,Harold,Head,1204 Oak Ridge Rd,Glen Allen,VA,23060,(804) 555-0142,(804) 555-0143,hcf@example.com,3/4/1971',
  'F1001,Fielden,Sarah,Spouse,1204 Oak Ridge Rd,Glen Allen,VA,23060,(804) 555-0142,(804) 555-0144,sf@example.com,11/12/1973',
  'F1001,Fielden,Emma,Child,,,,,,,,7/22/2009',
  'F1002,Alvarez,Miguel,Head,88 Cedar Ln,Ashland,VA,23005,(804) 555-0200,,ma@example.com,1/9/1980',
].join('\n');

function load(text) {
  const rows = parseCsv(text);
  const mapping = guessMapping(rows[0]);
  return { rows, mapping, ...buildRecords(rows, mapping) };
}

// --- parsing --------------------------------------------------------------

test('quoted fields, embedded commas and doubled quotes are parsed', () => {
  const rows = parseCsv('Name,Note\n"Smith, John","He said ""hello"""\n');
  assert.deepEqual(rows, [['Name', 'Note'], ['Smith, John', 'He said "hello"']]);
});

test('a newline inside a quoted field does not split the row', () => {
  const rows = parseCsv('Name,Address\n"Smith","12 Oak St\nApt 4"\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], '12 Oak St\nApt 4');
});

test('Excel quirks survive: BOM, CRLF and a trailing newline', () => {
  const rows = parseCsv('﻿Name,City\r\nSmith,Ashland\r\n');
  assert.deepEqual(rows, [['Name', 'City'], ['Smith', 'Ashland']]);
});

test('semicolon and tab exports are detected instead of read as one column', () => {
  assert.equal(detectDelimiter('Name;City;Zip'), ';');
  assert.equal(detectDelimiter('Name\tCity\tZip'), '\t');
  assert.equal(detectDelimiter('Name,City,Zip'), ',');
  // A comma inside a quoted header must not outvote the real delimiter.
  assert.equal(detectDelimiter('"Name, Full";City;Zip'), ';');
  assert.deepEqual(parseCsv('Name;City\nSmith;Ashland'), [['Name', 'City'], ['Smith', 'Ashland']]);
});

test('an empty file yields nothing rather than a phantom row', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('   \n  \n'), []);
});

test('CSV output quotes exactly what needs quoting and round trips', () => {
  const rows = [['Name', 'Note'], ['Smith, John', 'He said "hi"'], ['Plain', 'text']];
  const text = toCsv(rows);
  assert.match(text, /"Smith, John","He said ""hi"""/);
  assert.match(text, /\r\nPlain,text/);
  assert.deepEqual(parseCsv(text), rows);
});

// --- column guessing ------------------------------------------------------

test('a typical export maps every column without help', () => {
  const { rows, mapping } = load(PER_PERSON);
  const at = (key) => rows[0][mapping[key]];
  assert.equal(at('householdId'), 'Family ID');
  assert.equal(at('lastName'), 'Last Name');
  assert.equal(at('firstName'), 'First Name');
  assert.equal(at('role'), 'Relationship');
  assert.equal(at('street'), 'Address Line 1');
  assert.equal(at('city'), 'City');
  assert.equal(at('state'), 'State');
  assert.equal(at('zip'), 'Zip');
  assert.equal(at('homePhone'), 'Home Phone');
  assert.equal(at('mobile'), 'Cell Phone');
  assert.equal(at('email'), 'Email');
  assert.equal(at('birthday'), 'Birthdate');
});

test('"Phone" and "Home Phone" in one file land in the right slots', () => {
  // The exact synonym must win regardless of which column comes first.
  const a = guessMapping(['Phone', 'Home Phone', 'Cell Phone']);
  assert.equal(a.homePhone, 1);
  assert.equal(a.mobile, 2);

  const b = guessMapping(['Home Phone', 'Phone', 'Mobile']);
  assert.equal(b.homePhone, 0);
  assert.equal(b.mobile, 2);
});

test('no column is ever assigned to two fields', () => {
  const headers = ['ID', 'Name', 'Last Name', 'Address', 'Phone', 'Email', 'DOB'];
  const mapping = guessMapping(headers);
  const used = Object.values(mapping);
  assert.equal(new Set(used).size, used.length, JSON.stringify(mapping));
});

test('unrecognised columns are left alone rather than force-fitted', () => {
  const mapping = guessMapping(['Giving Number', 'Baptism Date', 'Small Group']);
  assert.deepEqual(mapping, {});
});

test('wordier headers still match on a contained synonym', () => {
  const mapping = guessMapping(['Primary Email Address', 'Mailing Address Line 1', 'Date Of Birth']);
  assert.equal(mapping.email, 0);
  assert.equal(mapping.street, 1);
  assert.equal(mapping.birthday, 2);
});

test('every declared target is reachable from its own first synonym', () => {
  for (const target of FIELD_TARGETS) {
    const mapping = guessMapping([target.synonyms[0]]);
    assert.equal(mapping[target.key], 0, `${target.key} did not match "${target.synonyms[0]}"`);
  }
});

// --- grouping into households --------------------------------------------

test('a per-person export is grouped into households', () => {
  const { rows, mapping, records, warnings } = load(PER_PERSON);
  assert.ok(looksPerPerson(rows, mapping));
  assert.equal(records.length, 2);
  assert.deepEqual(warnings, []);

  const fielden = records.find((r) => r.id === 'F1001');
  assert.equal(fielden.household, 'Fielden');
  assert.equal(fielden.people.length, 3);
  assert.deepEqual(fielden.people.map((p) => p.name), ['Harold Fielden', 'Sarah Fielden', 'Emma Fielden']);
  assert.equal(fielden.address.street, '1204 Oak Ridge Rd');
  assert.equal(fielden.phone, '(804) 555-0142');
});

test("household details are found even when only a parent's row carries them", () => {
  // Emma's row has no address; the household must still have one.
  const { records } = load(PER_PERSON);
  const fielden = records.find((r) => r.id === 'F1001');
  assert.equal(fielden.address.city, 'Glen Allen');
  assert.equal(fielden.address.zip, '23060');
  assert.equal(fielden.people[2].name, 'Emma Fielden');
  assert.equal(fielden.people[2].birthday, '7/22/2009');
});

test('without an ID column, surname plus address groups the household', () => {
  const text = [
    'Last Name,First Name,Address,City',
    'Fielden,Harold,1204 Oak Ridge Rd,Glen Allen',
    'Fielden,Sarah,1204 Oak Ridge Rd,Glen Allen',
    'Fielden,Rachel,5 Other St,Ashland',
  ].join('\n');
  const { records, warnings } = load(text);
  assert.equal(records.length, 2, 'a different address is a different household');
  assert.equal(records[0].people.length, 2);
  assert.equal(records[1].people.length, 1);
  assert.ok(warnings.some((w) => /No family ID column/.test(w)));
  // Generated IDs so submissions can still be told apart.
  assert.equal(new Set(records.map((r) => r.id)).size, 2);
});

test("without an ID, a child's address-less row still joins the family", () => {
  // The common shape of a per-person export: only the adults carry an address.
  const text = [
    'Last Name,First Name,Address,City',
    'Fielden,Harold,1204 Oak Ridge Rd,Glen Allen',
    'Fielden,Sarah,1204 Oak Ridge Rd,Glen Allen',
    'Fielden,Emma,,',
  ].join('\n');
  const { records } = load(text);
  assert.equal(records.length, 1, 'Emma must not become her own household');
  assert.deepEqual(records[0].people.map((p) => p.name), ['Harold Fielden', 'Sarah Fielden', 'Emma Fielden']);
});

test('an address-less row is left alone when two families share the surname', () => {
  // Guessing would put a child in the wrong house, which is worse than a
  // stray record the office can see and fix.
  const text = [
    'Last Name,First Name,Address,City',
    'Smith,John,12 Oak St,Ashland',
    'Smith,Mary,88 Cedar Ln,Glen Allen',
    'Smith,Timmy,,',
  ].join('\n');
  const { records, warnings } = load(text);
  assert.equal(records.length, 3);
  assert.ok(warnings.some((w) => /more than one family shares that surname/.test(w)));
});

test('a one-row-per-family export still produces a household', () => {
  const text = [
    'Household Name,Full Name,Address,City,State,Zip,Phone,Email',
    'Alvarez,Miguel Alvarez,88 Cedar Ln,Ashland,VA,23005,(804) 555-0200,ma@example.com',
  ].join('\n');
  const { rows, mapping, records } = load(text);
  assert.equal(looksPerPerson(rows, mapping), false);
  assert.equal(records.length, 1);
  assert.equal(records[0].household, 'Alvarez');
  assert.equal(records[0].people[0].name, 'Miguel Alvarez');
});

test('the same person listed twice is merged, keeping the fuller copy', () => {
  const text = [
    'Family ID,Last Name,First Name,Email,Cell Phone',
    'F1,Smith,John,,',
    'F1,SMITH,JOHN,js@example.com,(804) 555-0101',
  ].join('\n');
  const { records } = load(text);
  assert.equal(records[0].people.length, 1);
  assert.equal(records[0].people[0].email, 'js@example.com');
  assert.equal(records[0].people[0].mobile, '(804) 555-0101');
});

test('blank rows are ignored and unusable rows are reported, not dropped', () => {
  const text = [
    'Family ID,Last Name,First Name,Address',
    'F1,Smith,John,12 Oak St',
    ',,,',
    'F2,,Anonymous,',
  ].join('\n');
  const { records, warnings } = load(text);
  assert.equal(records.length, 2, 'the blank row is skipped, the nameless one is kept');
  assert.ok(warnings.some((w) => /no street address/.test(w)));
});

test('a file with only headers is reported instead of silently succeeding', () => {
  const { records, warnings } = load('Family ID,Last Name');
  assert.deepEqual(records, []);
  assert.ok(warnings.some((w) => /no data rows/.test(w)));
});

test('missing name columns are called out rather than producing empty families', () => {
  const text = 'Family ID,Address,City\nF1,12 Oak St,Ashland';
  const { warnings } = load(text);
  assert.ok(warnings.some((w) => /no names attached/.test(w)));
});

test('names are un-shouted and un-inverted', () => {
  assert.equal(tidyName('Smith, John'), 'John Smith');
  assert.equal(tidyName('SMITH, JOHN'), 'John Smith');
  assert.equal(tidyName('mcdonald, angus'), 'Angus McDonald');
  assert.equal(tidyName("O'BRIEN, SEAN"), "Sean O'Brien");
  // Mixed case is left exactly as the office typed it.
  assert.equal(tidyName('Mary Jo VanDyke'), 'Mary Jo VanDyke');
  assert.equal(tidyName('  John   Smith '), 'John Smith');
});

// --- exports back out -----------------------------------------------------

function submissionFor(mutate) {
  const before = normalizeRecord({
    id: 'F1001', household: 'Fielden',
    address: { street: '1204 Oak Ridge Rd', city: 'Glen Allen', state: 'VA', zip: '23060' },
    phone: '(804) 555-0142',
    people: [{ name: 'Harold Fielden', role: 'Head', email: 'hcf@example.com', mobile: '(804) 555-0143' }],
  });
  const after = cloneRecord(before);
  mutate(after);
  return submissionPayload(before, after, { submittedAt: '2026-08-10' });
}

test('the changes export gives the office one row per thing to retype', () => {
  const moved = submissionFor((r) => { r.address.street = '88 Cedar Ln'; r.people[0].mobile = '(804) 555-0199'; });
  const rows = parseCsv(updatesToCsv([moved]));
  assert.equal(rows.length, 3, 'header plus one row per change');
  assert.deepEqual(rows[0].slice(0, 6), ['Record ID', 'Household', 'Submitted', 'Field', 'Was', 'Now']);
  assert.equal(rows[1][0], 'F1001');
  assert.ok(rows.some((r) => r[3] === 'Address' && /88 Cedar Ln/.test(r[5])));
  assert.ok(rows.some((r) => r[3] === 'Harold Fielden — Mobile'));
});

test('a household that confirmed with no changes still appears in the export', () => {
  // Knowing a record was verified is worth as much as knowing it changed.
  const confirmed = submissionFor(() => {});
  const rows = parseCsv(updatesToCsv([confirmed]));
  assert.equal(rows.length, 2);
  assert.equal(rows[1][3], '(confirmed, no changes)');
  assert.equal(rows[1][6], 'confirmed');
});

test('the corrected directory export is one row per person and re-importable', () => {
  const moved = submissionFor((r) => {
    r.address.street = '88 Cedar Ln';
    r.people.push({ name: 'Ruth Fielden', role: 'Child', email: '', mobile: '', birthday: '02-02' });
  });
  const rows = parseCsv(directoryToCsv([moved]));
  assert.equal(rows.length, 3, 'header plus one row per person');
  assert.equal(rows[1][2], '88 Cedar Ln', 'the corrected address, not the old one');
  assert.equal(rows[2][2], '88 Cedar Ln', 'household details repeat on every person row');
  assert.deepEqual(rows.slice(1).map((r) => r[10]), ['Harold Fielden', 'Ruth Fielden']);
});

test('a household with nobody left still exports its address', () => {
  const emptied = submissionFor((r) => { r.people = []; });
  const rows = parseCsv(directoryToCsv([emptied]));
  assert.equal(rows.length, 2);
  assert.equal(rows[1][10], '');
  assert.equal(rows[1][2], '1204 Oak Ridge Rd');
});

test('a note with a comma survives the export intact', () => {
  const noted = submissionFor((r) => { r.note = 'We moved in June, after the wedding'; });
  const rows = parseCsv(updatesToCsv([noted]));
  assert.equal(rows[1][7], 'We moved in June, after the wedding');
});
