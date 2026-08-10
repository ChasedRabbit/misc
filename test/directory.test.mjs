import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRecord, cloneRecord, nextPersonKey, blankRecord, isEmptyRecord,
  parseDayMonth, canonicalDate, mergeDate, formatDate,
  formatPhone, addressLine, householdTitle, personSummary,
  sameValue, diffRecord, describeChange, unchangedSummary,
  submissionText, submissionSubject, submissionPayload, mailtoUrl,
  packRecord, unpackRecord, encodeRecord, decodeRecord, buildLink,
  escapeHtml, demoRecord,
} from '../directory/directory.js';

const demo = () => cloneRecord(demoRecord());

// --- dates ----------------------------------------------------------------

test('birthdays parse from every shape an export is likely to use', () => {
  assert.deepEqual(parseDayMonth('1971-03-04'), { month: 3, day: 4 });
  assert.deepEqual(parseDayMonth('--03-04'), { month: 3, day: 4 });
  assert.deepEqual(parseDayMonth('3/4/1971'), { month: 3, day: 4 });
  assert.deepEqual(parseDayMonth('3/4'), { month: 3, day: 4 });
  assert.deepEqual(parseDayMonth('Mar 4'), { month: 3, day: 4 });
  assert.deepEqual(parseDayMonth('March 4'), { month: 3, day: 4 });
  assert.deepEqual(parseDayMonth('4 March'), { month: 3, day: 4 });
  assert.equal(parseDayMonth('sometime in spring'), null);
  assert.equal(parseDayMonth(''), null);
});

test('impossible dates are rejected rather than silently reformatted', () => {
  assert.equal(parseDayMonth('13/40'), null);
  assert.equal(parseDayMonth('2026-13-01'), null);
  assert.equal(parseDayMonth('0/0'), null);
});

test('a date we cannot parse is preserved, not thrown away', () => {
  assert.equal(canonicalDate('Easter'), 'Easter');
  assert.equal(formatDate('Easter'), 'Easter');
});

test('the year is kept but never displayed', () => {
  assert.equal(canonicalDate('3/4/1971'), '1971-03-04');
  assert.equal(formatDate('1971-03-04'), 'Mar 4');
  assert.equal(formatDate('03-04'), 'Mar 4');
});

test('retyping the same day keeps the year; changing it drops the year', () => {
  // The form only ever showed "Mar 4", so retyping it must not delete 1971.
  assert.equal(mergeDate('1971-03-04', 'Mar 4'), '1971-03-04');
  assert.equal(mergeDate('1971-03-04', '3/4'), '1971-03-04');
  // A real correction can't claim the old year.
  assert.equal(mergeDate('1971-03-04', 'Mar 5'), '03-05');
  assert.equal(mergeDate('03-04', 'Mar 4'), '03-04');
});

// --- formatting -----------------------------------------------------------

test('phones format when they can and pass through when they cannot', () => {
  assert.equal(formatPhone('8045550142'), '(804) 555-0142');
  assert.equal(formatPhone('1-804-555-0142'), '(804) 555-0142');
  assert.equal(formatPhone('804.555.0142'), '(804) 555-0142');
  assert.equal(formatPhone('ext 12'), 'ext 12');
  assert.equal(formatPhone(''), '');
});

test('addresses skip the parts that are blank', () => {
  assert.equal(
    addressLine({ street: '1204 Oak Ridge Rd', city: 'Glen Allen', state: 'VA', zip: '23060' }),
    '1204 Oak Ridge Rd, Glen Allen, VA 23060'
  );
  assert.equal(addressLine({ street: '88 Cedar Ln', unit: 'Apt 2' }), '88 Cedar Ln Apt 2');
  assert.equal(addressLine({}), '');
});

test('household titles read naturally without doubling up', () => {
  assert.equal(householdTitle({ household: 'Fielden' }), 'The Fielden Family');
  assert.equal(householdTitle({ household: 'The Fielden Family' }), 'The Fielden Family');
  assert.equal(householdTitle({ household: '' }), 'Your household');
});

// --- comparison -----------------------------------------------------------

test('formatting differences are not changes', () => {
  assert.ok(sameValue('(804) 555-0142', '804.555.0142', 'phone'));
  assert.ok(sameValue('Sarah@Example.com', 'sarah@example.com', 'email'));
  assert.ok(sameValue('  Glen   Allen ', 'glen allen', 'text'));
  assert.ok(sameValue('1971-03-04', 'Mar 4', 'date'));
  assert.ok(!sameValue('(804) 555-0142', '(804) 555-0199', 'phone'));
});

test('a record that comes back untouched reports no changes at all', () => {
  const before = demo();
  const after = cloneRecord(before);
  assert.deepEqual(diffRecord(before, after), []);
  assert.match(submissionText(before, after), /CONFIRMED — no changes/);
});

test('reformatting every field still reports no changes', () => {
  // This is the case that matters: a family taps through the form, a phone
  // input helpfully reformats a number, and the office must not be told to
  // update anything.
  const before = demo();
  const after = cloneRecord(before);
  after.phone = '804.555.0142';
  after.people[0].email = 'HCFielden@Example.com';
  after.people[0].birthday = 'Mar 4';
  after.address.city = ' Glen Allen ';
  assert.deepEqual(diffRecord(before, after), []);
});

test('a move is one change, not four', () => {
  const before = demo();
  const after = cloneRecord(before);
  after.address = { street: '88 Cedar Ln', unit: '', city: 'Ashland', state: 'VA', zip: '23005' };

  const changes = diffRecord(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].key, 'address');
  assert.equal(changes[0].kind, 'changed');
  assert.match(describeChange(changes[0]), /1204 Oak Ridge Rd.*→.*88 Cedar Ln/);
});

test('changes are attributed to the right person', () => {
  const before = demo();
  const after = cloneRecord(before);
  after.people[1].mobile = '8045550199';

  const changes = diffRecord(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].person, 'Sarah Fielden');
  assert.equal(changes[0].label, 'Mobile');
  assert.equal(describeChange(changes[0]), 'Sarah Fielden — Mobile: (804) 555-0144 → (804) 555-0199');
});

test('adding a person does not make everyone below them look renamed', () => {
  const before = demo();
  const after = cloneRecord(before);
  after.people.unshift({
    _k: nextPersonKey(after), name: 'Caleb Fielden', role: 'Child',
    email: '', mobile: '', birthday: '02-02',
  });

  const changes = diffRecord(before, after);
  assert.equal(changes.length, 1, JSON.stringify(changes, null, 2));
  assert.equal(changes[0].kind, 'person-added');
  assert.match(describeChange(changes[0]), /^Added to household: Caleb Fielden/);
});

test('removing a person is reported as a departure, not a blanked name', () => {
  const before = demo();
  const after = cloneRecord(before);
  after.people = after.people.filter((p) => p.name !== 'Emma Fielden');

  const changes = diffRecord(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'person-removed');
  assert.equal(describeChange(changes[0]), 'No longer in this household: Emma Fielden');
});

test('a name change is reported against the name the office knows', () => {
  const before = demo();
  const after = cloneRecord(before);
  after.people[2].name = 'Emma Fielden-Blake';

  const [change] = diffRecord(before, after);
  assert.equal(change.person, 'Emma Fielden');
  assert.equal(describeChange(change), 'Emma Fielden — Name: Emma Fielden → Emma Fielden-Blake');
});

test('filling a blank field reads as added, and clearing one as removed', () => {
  const before = demo();
  const after = cloneRecord(before);
  after.people[2].email = 'emma@example.com';
  after.phone = '';

  const changes = diffRecord(before, after);
  const added = changes.find((c) => c.kind === 'added');
  const removed = changes.find((c) => c.kind === 'removed');
  assert.match(describeChange(added), /was blank/);
  assert.match(describeChange(removed), /removed \(was \(804\) 555-0142\)/);
});

test('untouched parts of the record are listed back to the office', () => {
  const before = demo();
  const after = cloneRecord(before);
  after.people[1].mobile = '8045550199';

  const untouched = unchangedSummary(before, after);
  assert.ok(untouched.includes('address'));
  assert.ok(untouched.includes('home phone'));
  assert.ok(untouched.includes('Harold Fielden'));
  assert.ok(!untouched.includes('Sarah Fielden'));
});

// --- submission -----------------------------------------------------------

test('the office email shows old and new side by side', () => {
  const before = demo();
  const after = cloneRecord(before);
  after.address.street = '88 Cedar Ln';
  after.note = 'We moved in June.';

  const text = submissionText(before, after, { submittedAt: '10 Aug 2026' });
  assert.match(text, /DIRECTORY UPDATE — The Fielden Family/);
  assert.match(text, /Record ID: H-0142/);
  assert.match(text, /CHANGES \(1\)/);
  assert.match(text, /NOTE FROM THE FAMILY/);
  assert.match(text, /We moved in June\./);
  assert.match(text, /Confirmed unchanged: home phone/);
});

test('the subject line says how much work it represents', () => {
  const before = demo();
  const same = cloneRecord(before);
  assert.match(submissionSubject(before, same), /no changes$/);

  const one = cloneRecord(before);
  one.phone = '8045550199';
  assert.match(submissionSubject(before, one), /1 change$/);

  const two = cloneRecord(one);
  two.people[0].email = 'new@example.com';
  assert.match(submissionSubject(before, two), /2 changes$/);
});

test('the payload carries the corrected record without internal keys', () => {
  const before = demo();
  const after = cloneRecord(before);
  after.people[0].mobile = '8045550199';

  const payload = submissionPayload(before, after, { submittedAt: '2026-08-10' });
  assert.equal(payload.id, 'H-0142');
  assert.equal(payload.changeCount, 1);
  assert.equal(payload.confirmed, true);
  assert.equal(payload.changes[0].field, 'Harold Fielden — Mobile');
  for (const p of payload.record.people) {
    assert.equal(p._k, undefined, 'internal person keys must not leak into the payload');
  }
});

test('mailto links survive the punctuation in a submission body', () => {
  const url = mailtoUrl({ to: 'office@example.org', subject: 'A & B', body: 'was: x\nnow: y+z' });
  assert.match(url, /^mailto:office%40example\.org\?/);
  assert.match(url, /subject=A%20%26%20B/);
  assert.match(url, /body=was%3A%20x%0Anow%3A%20y%2Bz/);
});

// --- links ----------------------------------------------------------------

test('a record survives the round trip through a link', () => {
  const before = demo();
  const restored = decodeRecord(encodeRecord(before));
  assert.deepEqual(diffRecord(before, restored), [], 'round trip must not invent changes');
  assert.equal(restored.id, before.id);
  assert.equal(restored.people.length, before.people.length);
  assert.equal(restored.address.zip, '23060');
});

test('names outside ASCII survive the round trip', () => {
  const record = normalizeRecord({
    household: 'Muñoz',
    address: { street: '12 Rue de l’Église', city: 'Glen Allen', state: 'VA', zip: '23060' },
    people: [{ name: 'José Muñoz', email: 'jose@example.com' }],
  });
  const restored = decodeRecord(encodeRecord(record));
  assert.equal(restored.household, 'Muñoz');
  assert.equal(restored.people[0].name, 'José Muñoz');
  assert.equal(restored.address.street, '12 Rue de l’Église');
});

test('empty and minimal records still round trip', () => {
  assert.deepEqual(decodeRecord(encodeRecord(blankRecord())), normalizeRecord(blankRecord()));
  const sparse = normalizeRecord({ household: 'Smith' });
  assert.equal(decodeRecord(encodeRecord(sparse)).household, 'Smith');
});

test('packing drops trailing blanks so links stay short', () => {
  const packed = packRecord(normalizeRecord({ household: 'Smith' }));
  assert.equal(packed.length, 3, JSON.stringify(packed));
  assert.deepEqual(unpackRecord(packed).people, []);
});

test('a mangled link fails loudly instead of showing an empty form', () => {
  assert.throws(() => decodeRecord('not-a-real-payload!!'));
  assert.throws(() => decodeRecord(''));
  // A record from a future schema must not be silently misread.
  const future = btoa(JSON.stringify([99, 'H-1', 'Smith'])).replace(/=+$/, '');
  assert.throws(() => decodeRecord(future), /different version/);
});

test('links are built against the page URL and drop any existing fragment', () => {
  const link = buildLink('https://example.github.io/misc/directory/#stale', demo());
  assert.ok(link.startsWith('https://example.github.io/misc/directory/#r='));
  assert.equal(link.split('#').length, 2);
});

// --- odds and ends --------------------------------------------------------

test('normalizing survives junk input without throwing', () => {
  assert.deepEqual(normalizeRecord(null), normalizeRecord(blankRecord()));
  assert.deepEqual(normalizeRecord({ people: 'nope' }).people, []);
  assert.equal(normalizeRecord({ id: 42 }).id, '42');
});

test('person keys are unique so added people never collide', () => {
  const record = normalizeRecord({ people: [{ name: 'A' }, { name: 'B' }] });
  const k1 = nextPersonKey(record);
  record.people.push({ _k: k1, name: 'C' });
  assert.notEqual(nextPersonKey(record), k1);
  assert.equal(new Set(record.people.map((p) => p._k)).size, 3);
});

test('an empty record is recognised so the page can ask instead of confirm', () => {
  assert.ok(isEmptyRecord(blankRecord()));
  assert.ok(!isEmptyRecord(demo()));
  assert.ok(!isEmptyRecord({ household: 'Smith' }));
});

test('person summaries omit the fields that are blank', () => {
  assert.equal(personSummary({ name: 'Emma Fielden', birthday: '2009-07-22' }), 'Emma Fielden — b. Jul 22');
  assert.equal(personSummary({ name: 'Emma Fielden' }), 'Emma Fielden');
});

test('user text is escaped before it reaches the page', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("O'Brien & Sons"), 'O&#39;Brien &amp; Sons');
});
