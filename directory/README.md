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

1. **Export** your directory to CSV, one row per person. You only need names,
   address, phones, emails and birthdays. If your system can export a **family
   or household ID, include it** — see "How households are worked out" below.
2. **Open `admin.html`** and load the file. It guesses which column is which,
   shows you the guess, and shows you how the rows grouped into households.
   Fix anything it got wrong.
3. **Fill in the settings** — church name, office email, deadline.
4. **Download the links CSV** and mail-merge the `link` column into your email or
   texting tool. Every family gets a different link containing only their own
   details.
5. **On photo day**, open `admin.html` on a tablet, search the family, and hit
   Open. Confirm it with them while they're standing there. Saved on the device,
   no internet needed once the page has loaded. If a family already confirmed
   online, the search shows that before you open anything — see "Sending links
   out *and* doing photo day" below to wire that up.
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

## Sending links out *and* doing photo day, without double-asking

If you send links ahead of time and also run a photo table, someone will
inevitably submit online and then show up in person a few weeks later — and
without a shared place both routes can see, the tablet has no way to know that
and will ask them to do it again.

**Email can't provide that shared place — it only reaches your inbox, which the
tablet can't read.** A form service can, if it's one you can *query back*, not
just send to. That's what `directory/sync.gs` is: a small Google Apps Script
web app, backed by a Sheet, that both sides talk to — the family form posts to
it, and the photo-day tablet asks it "who's already done?" before showing the
search results.

**Setup** (free, no server of your own, takes about five minutes):

1. Create a Google Sheet, open **Extensions → Apps Script**, and paste in the
   contents of `directory/sync.gs`.
2. **Deploy → New deployment → Web app.** Execute as **Me**; who has access,
   **Anyone**. (Not "Anyone with a Google account" — the page runs in a
   family's browser with nobody signed in.)
3. Copy the deployment URL into `postUrl` in `config.js` (or the office tool's
   settings). That's the whole integration — the same URL both accepts
   submissions and answers the tablet's "who's done" check.
4. Optional: set `SECRET` near the top of `sync.gs` to a random string, and the
   matching `syncKey` in `config.js`, so a stranger who finds the URL can't
   write junk into your sheet. Full submissions (names, addresses, phones) only
   ever go *to* the sheet, which only people with access to your Google account
   can open — the tablet's read-back query only ever receives a household ID,
   a timestamp, and a count of what changed. See the comments at the top of
   `sync.gs` for the reasoning.

**What it looks like at the table:** search a name, and a household that
already confirmed online shows a pill — *confirmed online · Aug 10* — right
next to their name, with the button relabelled **Open anyway** rather than
disappearing outright, in case they want to add something in person. Nothing
confirmed shows a plain **Open**. If two confirmations exist for the same
household — say, online in July and again at the table in September — the
newer one is what's shown.

It degrades safely: with no `postUrl` set, admin.html behaves exactly as
before. If the venue's wifi drops mid-session, the last successful check stays
cached and photo day keeps working off it; a manual **Retry** appears if the
connection is down when you land on the page.

Formspree and similar form services can't answer "who's done" — they only
accept submissions — so pointing `postUrl` at one still delivers submissions
normally, but the tablet won't show any online-confirmed pills.

## Settings

Edit `config.js` and commit. Links already sent pick up the change, because the
links carry the *family's* data, not the church's settings:

```js
export const CONFIG = {
  churchName: 'Grace Chapel',
  officeEmail: 'office@gracechapel.org',
  postUrl: '',
  syncKey: '',
  deadline: 'Sunday 6 September',
  helpContact: 'the office at (804) 555-0100',
};
```

Any of these can also be overridden on a single link with a query parameter
(`?c=`, `?to=`, `?post=`, `?key=`, `?by=`, `?help=`), which is what the office
tool does while you're trying settings out. Settings in `config.js` keep the
links shorter.

## How households are worked out

If your export has a family or household ID column, that is used and this
section doesn't apply. Many exports don't have one — including the one this was
built against, whose columns are:

```
First Name, Preferred Name, Last Name, Birthday, Age, Email,
Home Phone, Cell Phone, Address, City, State, Zip Code
```

With no family ID, **the address is the only evidence of who lives with whom**,
so people at the same address are treated as one household. Two decisions follow
from that, and both are deliberate:

- **Surnames are ignored when grouping.** Grouping on address *and* surname
  would split every household where a spouse kept their name, or where a
  grandparent or stepchild is under the same roof. Wrongly splitting a family is
  more visible — and more offensive to that family — than wrongly merging two,
  which you can spot in the review list. Mixed-surname households are counted in
  the warnings so you can glance at them.
- **People with no address become a household of one.** We genuinely don't know
  who they live with, and guessing would be worse than admitting it.

Addresses are matched loosely enough to survive real data: `Rd`/`Road`,
`St`/`Street`, punctuation, and ZIP+4 against plain ZIP all group together.
Apartment numbers keep neighbours apart. If more than eight people share one
address it's treated as a data-entry placeholder — a church office address, say
— and split, rather than mailing one link to a crowd.

Two other things about that export shape:

- **`Age` is never asked about or written back.** It's derived from `Birthday`
  ("53 yrs"), so a stale copy would be worse than none. It's read only to sort
  each household oldest-first, which puts parents above children without needing
  a relationship column.
- **`Preferred Name` is what the page shows.** Someone on file as Harold but
  going by Hal is greeted as Hal, with a quiet "on file as Harold Fielden"
  underneath so a wrong legal name can still be corrected.

Because there's no ID to match on, the update exports always carry the **old
value beside the new one** — that's how you find the right record to edit.

## About the data

**A family's details live in their link, in the part after the `#`.** Browsers
never send that part to a web server. That's the whole reason this needs no
backend: there is no copy of the congregation's data on any website, and nothing
to breach. The only copy in transit is in the link you mailed to that family.

Consequences worth knowing:

- **A link is as private as the email it was sent in.** Forwarded, it exposes
  that one household — never anyone else's.
- **Links are long.** Measured across a real 6,000-person export: about 200
  characters of encoded data for a typical household, 900 for the largest, plus
  your site's URL. Fine in email; test a text message to yourself first, as some
  apps truncate.
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
node --test 'test/*.mjs'    # directory.test.mjs, csv.test.mjs, sync.test.mjs
```

`directory.js`, `csv.js` and `sync.js` are pure functions with no DOM and no
fetch, which is what makes the interesting parts testable: what counts as a
change, whether a record survives a round trip through a link, how a real
export groups into households, and how two independent "already submitted"
lists merge when they disagree. The pages hold the DOM glue and the actual
`fetch()` calls. `sync.gs` runs on Google's servers, not in the browser, and
is exercised by hand rather than by `node --test`.

The comparison is deliberately forgiving — `(804) 555-0142` and `804.555.0142`
are the same number, and no family should be told their number changed because
of a hyphen. Birthdays keep a year if your export has one but never display it,
since directories print `Mar 4`.
