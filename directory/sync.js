// sync.js — cross-referencing the family-facing form and the photo-day tablet
// against a shared list of who has already submitted.
//
// Pure functions only. The actual fetch() calls, and the decision of when to
// make them, live in index.html and admin.html — this file is what makes the
// merging and freshness logic testable without a network or a browser.
//
// The premise: a family's submission can arrive by three different routes —
// emailed, posted to a live endpoint, or confirmed in person at the photo
// table — and without something to cross-reference them, a family that
// already did it online gets asked to do it again at the table. The fix needs
// a place both routes can see, which only the live-endpoint route provides;
// see README.md for why email alone can't do this.

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * The body sent to the sync endpoint. Content-Type must stay a CORS "simple"
 * value (text/plain, not application/json) or Google Apps Script's inability
 * to answer an OPTIONS preflight turns every submission into a network error
 * — see README.md. The endpoint parses JSON out of the text body regardless
 * of the header.
 */
export function buildSubmitBody(payload, key) {
  return JSON.stringify(key ? { ...payload, key } : payload);
}

/**
 * Parse the endpoint's response to "who has already submitted". Deliberately
 * strict: a malformed or unexpected response should read as "sync is down",
 * never as "nobody has submitted" — the latter would make every household
 * look untouched and undo the entire point of asking.
 */
export function parseCompletedList(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The server did not return valid JSON.');
  }
  if (!json || json.ok === false) {
    throw new Error((json && json.error) || 'The server reported an error.');
  }
  const list = Array.isArray(json.completed) ? json.completed : [];
  return list
    .filter((r) => r && str(r.id))
    .map((r) => ({
      id: str(r.id),
      submittedAt: str(r.submittedAt),
      changeCount: Number(r.changeCount) || 0,
    }));
}

/** id -> completion record, for O(1) lookups against a roster in the thousands. */
export function completionIndex(list) {
  const map = new Map();
  for (const r of list || []) if (r && r.id) map.set(r.id, r);
  return map;
}

const isoOf = (s) => str(s);

/**
 * Attach what's known about each household's submission status, combining
 * the live endpoint with anything confirmed on this device. Photo-day mode
 * saves locally first and the tablet may sync later, so a submission taken
 * with no wifi in the room still shows as done immediately, on this device,
 * without waiting on the network.
 *
 * When both sides have a record for the same household, the newer timestamp
 * wins — the case that matters is a family confirming online, then again at
 * the table because they forgot, or vice versa; whichever happened last is
 * the state that should show.
 */
export function withStatus(records, remoteList, localList) {
  const remote = completionIndex(remoteList);
  const local = completionIndex(localList);
  return records.map((r) => {
    const here = local.get(r.id);
    const there = remote.get(r.id);
    let status = null;
    if (here && there) {
      status = isoOf(here.submittedAt) >= isoOf(there.submittedAt)
        ? { ...here, source: 'device' }
        : { ...there, source: 'online' };
    } else if (here) {
      status = { ...here, source: 'device' };
    } else if (there) {
      status = { ...there, source: 'online' };
    }
    return { ...r, status };
  });
}

/** Is a cached fetch old enough to be worth refreshing? */
export function isStale(fetchedAt, ttlMs, now = Date.now()) {
  if (!fetchedAt) return true;
  return now - fetchedAt > ttlMs;
}
