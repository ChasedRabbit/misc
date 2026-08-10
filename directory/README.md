# Directory Update

A church directory refresh, built around the fact that **most families have
nothing to report.** They haven't moved, the number is the same, nobody was born
or left. Asking those households to retype what you already have is how a form
gets ignored.

So this isn't really a form. It's a confirmation. Each family gets a link that
opens their own entry as it stands today, with one button: **Everything is
correct.** Fields only become editable for the sections they say are wrong, and
only what actually changed is submitted.

A family who hasn't moved in ten years is done in about five seconds. A family
who moved last June changes their address and nothing else.

No accounts, no database, no server, no build step. Static files.

## Try it before setting anything up

- `index.html?demo=1` — the family's view, with a made-up household.
- `admin.html` — the office tool. Click **Try it with sample data first**.

Locally, `python3 -m http.server` and open `http://127.0.0.1:8000/directory/` —
the files are ES modules, so `file://` won't work.

## How a round actually goes

1. **Export** your directory to CSV. One row per person or one per family; both
   work. Fewer columns is better — you only need names, address, phones, emails,
   birthdays, and ideally a family ID.
2. **Open `admin.html`** and load the file. It guesses which column is which,
   shows you the guess, and shows you how the rows grouped into households.
   Fix anything it got wrong.
3. **Fill in the settings** — church name, office email, deadline.
4. **Download the links CSV** and mail-merge the `link` column into your email or
   texting tool. Every family gets a different link containing only their own
   details.
5. **On photo day**, open `admin.html` on a tablet, search the family, and hit
   Open. Confirm it with them while they're standing there. Saved on the device,
   no internet needed once the page has loaded.
6. **Collect.** Emailed submissions land in your inbox. Anything gathered on the
   tablet exports as two CSVs: *the changes* (one row per thing to retype) and
   *the corrected directory* (one row per person, ready to re-import).

The two halves work together or separately. Send links to everyone a month
ahead, then mop up the non-responders in person at the photo table.

## Where submissions go

Set this in `config.js`, or per-link in the office tool. Three options:

| | Setup | What the family does | What you get |
|---|---|---|---|
| **Email** *(default)* | None. Just set `officeEmail`. | Taps Send; their mail app opens with the message ready, and **they must tap send again there**. | An email per household. You retype into your system. |
| **Form service** | A Formspree / Google Apps Script account, and its URL in `postUrl`. | Taps Send. Done. | Submissions land in a spreadsheet or inbox automatically. |
| **Copy** | None. Leave both blank. | Taps Copy, pastes into an email or text. | Whatever they send you. |

**Start with email.** It needs no accounts, sends members' addresses through
nobody, and works on every phone. Its one real weakness is the second tap — some
people will assume it sent and close the mail app. If that bites you, or if you
have more than a couple hundred households to chase, move to a form service.

If a POST fails, the page falls back to email or copy rather than losing what
was typed.

## Settings

Edit `config.js` and commit. Links already sent pick up the change, because the
links carry the *family's* data, not the church's settings:

```js
export const CONFIG = {
  churchName: 'Grace Chapel',
  officeEmail: 'office@gracechapel.org',
  postUrl: '',
  deadline: 'Sunday 6 September',
  helpContact: 'the office at (804) 555-0100',
};
```

Any of these can also be overridden on a single link with a query parameter
(`?c=`, `?to=`, `?post=`, `?by=`, `?help=`), which is what the office tool does
while you're trying settings out. Settings in `config.js` keep the links shorter.

## About the data

**A family's details live in their link, in the part after the `#`.** Browsers
never send that part to a web server. That's the whole reason this needs no
backend: there is no copy of the congregation's data on any website, and nothing
to breach. The only copy in transit is in the link you mailed to that family.

Consequences worth knowing:

- **A link is as private as the email it was sent in.** Forwarded, it exposes
  that one household — never anyone else's.
- **Links are long** (roughly 400–900 characters). Fine in email; test a text
  message to yourself first, as some apps truncate.
- **Don't commit your export.** `.gitignore` here already blocks `*.csv`.
- The office tool holds your loaded file in `sessionStorage` — it survives
  opening a family and coming back, and is gone when the tab closes.
  Photo-day responses sit in `localStorage` until you export and clear them.
  Both are on your own device. Use **Clear saved responses** when you're done,
  especially on a shared tablet.
- Pages carry `noindex`, so search engines won't list them.

## Putting it online

The repo already deploys to GitHub Pages on push to `main`
(`.github/workflows/pages.yml`), so the page will be at
`https://<user>.github.io/misc/directory/`. Nothing else to configure.

`admin.html` sits at a public URL too. There's nothing sensitive *in* it — it
holds no data until you load a file — but it's not a page you'd advertise.

## What it deliberately doesn't do

- **No login.** Possession of the link is the credential. For a church
  directory, that's proportionate; for anything more sensitive, it isn't.
- **No partial saves.** A family fills it in once, in one sitting. It's a
  five-second job for most of them.
- **It never deletes anyone.** "No longer in this household" is reported to the
  office as a note to act on, not applied automatically. Someone died, someone
  divorced, a kid went to college — a human should look at those.
- **No photo consent question.** Easy to add if you want one for the printed
  directory, but that's a policy call, so it isn't assumed.

## Development

```sh
node --test 'test/*.mjs'    # directory tests live in test/directory*.test.mjs
```

`directory.js` and `csv.js` are pure functions with no DOM and no fetch, which
is what makes the interesting parts testable: what counts as a change, whether a
record survives a round trip through a link, and how a real export groups into
households. The pages hold the DOM glue.

The comparison is deliberately forgiving — `(804) 555-0142` and `804.555.0142`
are the same number, and no family should be told their number changed because
of a hyphen. Birthdays keep a year if your export has one but never display it,
since directories print `Mar 4`.
