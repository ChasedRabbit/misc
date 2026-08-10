import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSubmitBody, parseCompletedList, completionIndex, withStatus, isStale,
} from '../directory/sync.js';

test('a shared key rides along in the body, and is omitted when unset', () => {
  const body = JSON.parse(buildSubmitBody({ id: 'H-1' }, 'sekrit'));
  assert.equal(body.id, 'H-1');
  assert.equal(body.key, 'sekrit');
  const noKey = JSON.parse(buildSubmitBody({ id: 'H-1' }, ''));
  assert.ok(!('key' in noKey));
});

test('a normal completed-list response parses cleanly', () => {
  const text = JSON.stringify({
    ok: true,
    completed: [
      { id: 'H-1', submittedAt: '2026-08-10T12:00:00Z', changeCount: 2 },
      { id: 'H-2', submittedAt: '2026-08-11T09:00:00Z', changeCount: 0 },
    ],
  });
  const list = parseCompletedList(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'H-1');
  assert.equal(list[0].changeCount, 2);
});

test('a server-side error is surfaced, not read as an empty roster', () => {
  assert.throws(() => parseCompletedList(JSON.stringify({ ok: false, error: 'unauthorized' })), /unauthorized/);
});

test('malformed JSON fails loudly rather than silently returning nothing', () => {
  assert.throws(() => parseCompletedList('<html>not json</html>'), /valid JSON/);
});

test('junk rows in the response are dropped, not crashed on', () => {
  const list = parseCompletedList(JSON.stringify({
    ok: true,
    completed: [null, {}, { id: '' }, { id: 'H-9', submittedAt: '2026-08-10' }],
  }));
  assert.deepEqual(list.map((r) => r.id), ['H-9']);
});

test('completionIndex tolerates a missing or malformed list', () => {
  assert.equal(completionIndex(null).size, 0);
  assert.equal(completionIndex(undefined).size, 0);
  assert.equal(completionIndex([{ id: 'H-1' }, { notAnId: true }]).size, 1);
});

test('a household confirmed only online shows the online status', () => {
  const records = [{ id: 'H-1' }, { id: 'H-2' }];
  const out = withStatus(records, [{ id: 'H-1', submittedAt: '2026-08-10', changeCount: 0 }], []);
  assert.equal(out[0].status.source, 'online');
  assert.equal(out[1].status, null, 'nothing known about H-2');
});

test('a household confirmed only at the table shows the device status, offline or not', () => {
  const records = [{ id: 'H-1' }];
  const out = withStatus(records, [], [{ id: 'H-1', submittedAt: '2026-08-10', changeCount: 1 }]);
  assert.equal(out[0].status.source, 'device');
});

test('when both sides know about a household, the newer submission wins', () => {
  const records = [{ id: 'H-1' }];
  const olderOnline = [{ id: 'H-1', submittedAt: '2026-08-01T00:00:00Z', changeCount: 0 }];
  const newerDevice = [{ id: 'H-1', submittedAt: '2026-08-10T00:00:00Z', changeCount: 1 }];
  const out = withStatus(records, olderOnline, newerDevice);
  assert.equal(out[0].status.source, 'device');
  assert.equal(out[0].status.changeCount, 1);

  // And the reverse: an online update after an earlier in-person confirmation.
  const out2 = withStatus(records,
    [{ id: 'H-1', submittedAt: '2026-08-10T00:00:00Z', changeCount: 2 }],
    [{ id: 'H-1', submittedAt: '2026-08-01T00:00:00Z', changeCount: 0 }]);
  assert.equal(out2[0].status.source, 'online');
  assert.equal(out2[0].status.changeCount, 2);
});

test('withStatus never mutates the input records', () => {
  const records = [{ id: 'H-1', household: 'Fielden' }];
  const copy = JSON.parse(JSON.stringify(records));
  withStatus(records, [{ id: 'H-1', submittedAt: '2026-08-10' }], []);
  assert.deepEqual(records, copy);
});

test('cache freshness is a simple age check', () => {
  const now = 1_000_000;
  assert.equal(isStale(null, 60_000, now), true, 'never fetched is always stale');
  assert.equal(isStale(now - 30_000, 60_000, now), false);
  assert.equal(isStale(now - 90_000, 60_000, now), true);
});
