// config.js — the handful of things the church sets once.
//
// Edit this file, commit it, and every link you have already sent out picks up
// the change: the links carry the family's data, not the church's settings.
// Any of these can also be overridden per-link with a query parameter, which is
// what the link generator on admin.html does when you try a different setting.

export const CONFIG = {
  // Shown at the top of the page.
  churchName: 'Our Church',

  // Where submissions go when the family taps Send. Leave blank and the page
  // falls back to "copy the summary", which needs no email app.
  officeEmail: '',

  // Optional. A form endpoint (Formspree, a Google Apps Script web app, etc.)
  // to POST the submission to instead of opening an email. See README.md.
  postUrl: '',

  // Optional friendly nudge, e.g. 'Sunday, September 6'. Blank hides it.
  deadline: '',

  // Optional. Shown when someone gets stuck: 'the office at (804) 555-0100'.
  helpContact: '',
};

/** Per-link overrides, so a setting can be tried without a redeploy. */
export function configFromUrl(search, base = CONFIG) {
  const params = new URLSearchParams(search || '');
  const out = { ...base };
  const map = {
    c: 'churchName',
    to: 'officeEmail',
    post: 'postUrl',
    by: 'deadline',
    help: 'helpContact',
  };
  for (const [param, key] of Object.entries(map)) {
    const v = params.get(param);
    if (v !== null) out[key] = v;
  }
  return out;
}
