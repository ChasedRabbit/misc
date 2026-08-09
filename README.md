# Mow Window

A single web page that answers one question: **when should I mow this week?**

Open it on a phone, pick a location once, and it tells you the best block of
hours in the next seven days — and, more usefully, why the obvious-looking ones
are no good. The morning after an evening rain looks perfect on a normal weather
app: sunny, 75°, no rain in the forecast. It's still the wrong time to mow,
because the grass is soaked and a mower will tear it, clump, and spread disease.

No accounts, no API keys, no app to install, no build step. Static files.

## Try it without setting anything up

Open `index.html?demo=1` for a made-up sample week — including a rain event, so
you can see the wet-grass logic do its thing.

## Putting it online

The page is static, so GitHub Pages will host it for free:

1. Push this branch (or merge it to `main`).
2. Repo **Settings → Pages → Source: Deploy from a branch**, pick the branch and
   the `/ (root)` folder.
3. Wait a minute, then open `https://<user>.github.io/misc/`.
4. Text that link to whoever needs it. On an iPhone, Share → *Add to Home
   Screen* makes it behave like an app.

It needs to be served over HTTPS (Pages is) for the "use my current location"
button to work. Locally, `python3 -m http.server` and visit
`http://127.0.0.1:8000` — the files are ES modules, so opening `index.html`
directly off the disk with `file://` won't work.

## How it decides

Weather comes from [Open-Meteo](https://open-meteo.com) — free, no key, no
attribution requirement beyond a link. The judgment is in `mow.js`.

**Hard blockers** (the hour scores zero, and the page says which one):

| Blocker | Why |
|---|---|
| Dark | Sunrise/sunset from the forecast, per day. |
| Raining | More than a trace in that hour. |
| Frost (≤34°F) | Mowing frosted grass ruptures the leaf cells and leaves brown tracks. |
| Wet grass | The interesting one — see below. |

**Wetness** is not "did it rain." It's a running balance carried hour by hour
across the whole forecast, starting three days in the past so it has a realistic
starting point. Rain adds to it. Dew adds to it on humid nights. Sun, wind,
warmth, and dry air pull it back off, and how *fast* they do that depends on all
four together — a soaking dries in an afternoon if it's breezy and clear, and
sits there all day if it's still and overcast.

**Soft penalties** then rank the hours that aren't blocked: heat (weighted by
grass type), hot-sunny-midday, wind over 18 mph, rain probability, rain arriving
within two hours, and too little daylight left to finish. Late afternoon gets a
small bonus — the plant has time to recover before the next hot day.

**Grass type** matters enough to be a toggle. Cool-season grass (fescue,
bluegrass, rye) is genuinely damaged by a cut above ~80°F; warm-season grass
(bermuda, zoysia, St. Augustine) shrugs it off until ~90°F.

**Windows** are runs of consecutive workable hours, rated by their best three
hours rather than the hours they happen to open with, with a small discount for
being further out — "mow next Saturday" is bad advice when Tuesday is just as
good and the grass grows the whole time.

**Growth** is a separate question from timing: growing degree days over the
coming week, damped when there's no moisture, answering "does it even need
cutting?" A dry, dormant lawn is better left alone.

## The numbers are estimates

The thresholds are reasonable turf-management defaults, not measurements of your
lawn. Shade, slope, thatch, and drainage all shift how fast a given yard dries.
The page says so in the footer. Look at the sky.

## Development

```sh
node --test 'test/*.mjs'    # 16 tests, no network, no browser
```

`mow.js` is pure functions with no DOM and no fetch, which is what makes the
agronomy testable. `demo-data.js` generates an Open-Meteo-shaped week and is
shared by the tests and by `?demo=1`.

Units are °F / mph / inches, set in the forecast request in `index.html` and
assumed by the thresholds in `mow.js`; switching to metric means changing both.
