import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRecord, cloneRecord, nextPersonKey, parseDayMonth, canonicalDate,
  mergeDate, formatDate, formatPhone, addressLine, householdTitle, personName,
  formalName, parseAgeYears, sameValue, diffRecord, describeChange,
  unchangedSummary, submissionText, submissionSubject, submissionPayload,
  mailtoUrl, encodeRecord, decodeRecord, buildLink, isEmptyRecord, demoRecord,
} from '../directory/directory.js';

const sample = () => demoRecord();

test('a record survives a round trip through a link', () => {
  const before = sample();
  const after = decodeRecord(encodeRecord(before));
  assert.deepEqual(after, before);
});

test('links carry the record in the fragment, never the query', () => {
  const link = buildLink('https://example.org/misc/directory/', sample());
  assert.ok(link.includes('#r='), link.slice(0, 60));
  assert.ok(!link.split('#')[0].includes('='), 'nothing before the hash');
  // Fragments are not sent to the server, which is the whole privacy argument.
  assert.equal(link.split('#')[0], 'https://example.org/misc/directory/');
});

test('a link made by a different schema version is rejected, not misread', () => {
  const packed = JSON.stringify([99, 'H-1', 'Fielden']);
  const encoded = Buffer.from(packed, 'utf8').toString('base64url');
  assert.throws(() => decodeRecord(encoded), /different version/);
});

test('non-ASCII names survive encoding', () => {
  const r = normalizeRecord({
    household: 'Muñoz',
    people: [{ first: 'José', last: 'Muñoz', email: 'jose@example.com' }],
  });
  assert.equal(decodeRecord(encodeRecord(r)).people[0].first, 'José');
});

test('confirming without touching anything produces no changes', () => {
  const before = sample();
  const after = cloneRecord(before);
  assert.equal(diffRecord(before, after).length, 0);
});

test('formatting differences are not changes', () => {
  const before = sample();
  const after = cloneRecord(before);
  after.phone = '804.555.0142';
  after.people[0].email = 'HAL@example.com';
  after.people[1].first = '  Sarah  ';
  assert.equal(diffRecord(before, after).length, 0, 'punctuation and case are noise');
});

test('a move is reported as one address change, not four field changes', () => {
  const before = sample();
  const after = cloneRecord(before);
  after.address = { street: '88 Cedar Ln', unit: '', city: 'Ashland', state: 'VA', zip: '23005' };
  const changes = diffRecord(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].label, 'Address');
  assert.match(describeChange(changes[0]), /1204 Oak Ridge Rd.*→.*88 Cedar Ln/);
});

test('people are matched by key, so adding someone does not shift the others', () => {
  const before = sample();
  const after = cloneRecord(before);
  after.people.unshift({ _k: nextPersonKey(after), first: 'Caleb', last: 'Fielden', birthday: '02-02' });
  const changes = diffRecord(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'person-added');
  assert.match(describeChange(changes[0]), /^Added to household: Caleb Fielden/);
});

test('removing someone is reported against the name we knew them by', () => {
  const before = sample();
  const after = cloneRecord(before);
  after.people = after.people.filter((p) => p.first !== 'Emma');
  const changes = diffRecord(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'person-removed');
  assert.equal(changes[0].person, 'Emma Fielden');
});

test('a person field change names the person and the field', () => {
  const before = sample();
  const after = cloneRecord(before);
  after.people[1].mobile = '8045550199';
  const [c] = diffRecord(before, after);
  assert.equal(c.person, 'Sarah Fielden');
  assert.equal(c.label, 'Cell phone');
  assert.equal(c.to, '(804) 555-0199');
});

test('a surname change is reported against the old name', () => {
  const before = sample();
  const after = cloneRecord(before);
  after.people[2].last = 'Fielden-Blake';
  const [c] = diffRecord(before, after);
  assert.equal(c.person, 'Emma Fielden');
  assert.equal(c.label, 'Last name');
});

test('blank-to-value reads as added, value-to-blank as removed', () => {
  const before = sample();
  const after = cloneRecord(before);
  after.people[2].email = 'emma@example.com';
  after.phone = '';
  const kinds = Object.fromEntries(diffRecord(before, after).map((c) => [c.label, c.kind]));
  assert.equal(kinds.Email, 'added');
  assert.equal(kinds['Home phone'], 'removed');
  assert.match(describeChange(diffRecord(before, after).find((c) => c.label === 'Email')), /was blank/);
});

test('the preferred name is what gets printed, and the legal one is kept', () => {
  const r = sample();
  assert.equal(personName(r.people[0]), 'Hal Fielden');
  assert.equal(formalName(r.people[0]), 'Harold Fielden');
  assert.equal(formalName(r.people[1]), '', 'no nickname, nothing to disclose');
});

test('household title reads naturally whatever the export called it', () => {
  assert.equal(householdTitle({ household: 'Fielden' }), 'The Fielden Family');
  assert.equal(householdTitle({ household: 'Fielden & Blake' }), 'The Fielden & Blake Family');
  assert.equal(householdTitle({ household: 'The Fielden Family' }), 'The Fielden Family');
  assert.equal(householdTitle({ household: '' }), 'Your household');
});

test('dates are read in every shape the exports use', () => {
  assert.deepEqual(parseDayMonth('03/04/1971'), { month: 3, day: 4 });
  assert.deepEqual(parseDayMonth('1971-03-04'), { month: 3, day: 4 });
  assert.deepEqual(parseDayMonth('--03-04'), { month: 3, day: 4 });
  assert.deepEqual(parseDayMonth('Mar 4'), { month: 3, day: 4 });
  assert.deepEqual(parseDayMonth('March 4, 1971'), { month: 3, day: 4 });
  assert.equal(parseDayMonth('13/40/1971'), null);
  assert.equal(parseDayMonth(''), null);
});

test('an unparseable date is preserved rather than silently dropped', () => {
  assert.equal(canonicalDate('sometime in June'), 'sometime in June');
  assert.equal(formatDate('sometime in June'), 'sometime in June');
});

test('the birth year is kept even though the form never shows it', () => {
  assert.equal(canonicalDate('03/04/1971'), '1971-03-04');
  assert.equal(formatDate('1971-03-04'), 'Mar 4', 'the year is never displayed');
  // Retyping the same day must not strip the year the office holds.
  assert.equal(mergeDate('1971-03-04', 'Mar 4'), '1971-03-04');
  // Genuinely changing the day drops a year we can no longer vouch for.
  assert.equal(mergeDate('1971-03-04', 'Mar 5'), '03-05');
});

test('a birthday correction is one change, and only when the day moves', () => {
  const before = sample();
  const after = cloneRecord(before);
  after.people[0].birthday = mergeDate(before.people[0].birthday, '3/4');
  assert.equal(diffRecord(before, after).length, 0);
  after.people[0].birthday = mergeDate(before.people[0].birthday, 'Mar 5');
  assert.equal(diffRecord(before, after).length, 1);
});

test('phones are formatted when they can be, and left alone when they cannot', () => {
  assert.equal(formatPhone('8045550142'), '(804) 555-0142');
  assert.equal(formatPhone('18045550142'), '(804) 555-0142');
  assert.equal(formatPhone('615-555-0142 (Josh)'), '615-555-0142 (Josh)');
  assert.equal(formatPhone('555-0142'), '555-0142');
  assert.equal(formatPhone(''), '');
});

test('age strings are read only well enough to sort a household', () => {
  assert.equal(parseAgeYears('53 yrs'), 53);
  assert.equal(parseAgeYears('8 months'), 8 / 12);
  assert.equal(parseAgeYears('-1 month'), 0, 'a future birthday is not negative age');
  assert.equal(parseAgeYears(''), null);
});

test('sameValue is forgiving in the ways that matter and strict otherwise', () => {
  assert.ok(sameValue('(804) 555-0142', '804.555.0142', 'phone'));
  assert.ok(sameValue('A@B.com', 'a@b.com', 'email'));
  assert.ok(sameValue(' Oak  St ', 'oak st', 'text'));
  assert.ok(sameValue('1971-03-04', '03-04', 'date'));
  assert.ok(!sameValue('8045550142', '8045550143', 'phone'));
});

test('the office email lists changes, and says so plainly when there are none', () => {
  const before = sample();
  const unchanged = submissionText(before, cloneRecord(before), { submittedAt: '10 Aug 2026' });
  assert.match(unchanged, /CONFIRMED — no changes/);
  assert.match(unchanged, /Record ID: H-0142/);

  const after = cloneRecord(before);
  after.people[1].mobile = '8045550199';
  after.note = 'Please use the cell, the landline is going away.';
  const text = submissionText(before, after, { submittedAt: '10 Aug 2026' });
  assert.match(text, /CHANGES \(1\)/);
  assert.match(text, /Sarah Fielden — Cell phone: \(804\) 555-0144 → \(804\) 555-0199/);
  assert.match(text, /NOTE FROM THE FAMILY/);
  assert.match(text, /Confirmed unchanged: address, home phone, Hal Fielden, Emma Fielden\./);
});

test('unchanged summary does not claim a person is unchanged when they are not', () => {
  const before = sample();
  const after = cloneRecord(before);
  after.people[0].email = 'new@example.com';
  assert.ok(!unchangedSummary(before, after).includes('Hal Fielden'));
});

test('the subject line says how much changed before it is opened', () => {
  const before = sample();
  assert.match(submissionSubject(before, cloneRecord(before)), /no changes$/);
  const after = cloneRecord(before);
  after.phone = '6155550100';
  assert.match(submissionSubject(before, after), /1 change$/);
});

test('mailto encodes a body with newlines and ampersands intact', () => {
  const url = mailtoUrl({ to: 'office@example.org', subject: 'A & B', body: 'one\ntwo & three' });
  assert.ok(url.startsWith('mailto:office%40example.org?'));
  assert.ok(url.includes('subject=A%20%26%20B'));
  assert.ok(url.includes('one%0Atwo%20%26%20three'));
});

test('the machine-readable payload keeps old and new values side by side', () => {
  const before = sample();
  const after = cloneRecord(before);
  after.address.street = '88 Cedar Ln';
  const payload = submissionPayload(before, after, { submittedAt: '2026-08-10' });
  assert.equal(payload.id, 'H-0142');
  assert.equal(payload.changeCount, 1);
  assert.equal(payload.changes[0].was, '1204 Oak Ridge Rd, Glen Allen, VA 23060');
  assert.ok(!('_k' in payload.record.people[0]), 'internal keys stay internal');
});

test('a household with nothing in it is recognised as empty', () => {
  assert.ok(isEmptyRecord(normalizeRecord({})));
  assert.ok(!isEmptyRecord(sample()));
});

test('malformed input normalises instead of throwing', () => {
  const r = normalizeRecord({ people: 'not an array', address: null, id: 42 });
  assert.deepEqual(r.people, []);
  assert.equal(r.id, '42');
  assert.equal(addressLine(r.address), '');
});

test('a household of one is addressed by name, not as a family', () => {
  const solo = normalizeRecord({ household: 'Calloway', people: [{ first: 'Ruth', last: 'Calloway' }] });
  assert.equal(householdTitle(solo), 'Ruth Calloway');
});
