// mow.js — scoring engine for "when should I mow this week".
//
// Pure functions, no DOM, no network. index.html imports this; test/mow.test.mjs
// imports the same module so the agronomy is verified without a browser.
//
// The model in one paragraph: grass should be cut dry, never frosted, and not
// during the hottest, sunniest part of a hot day. Wetness is the hard part —
// it is not "did it rain", it is a running balance of rain and overnight dew
// against how fast sun, wind, warmth and dry air pull the water back off the
// leaf. So we carry a wetness value hour by hour across the whole forecast
// rather than looking at any single hour in isolation.

export const GRASS = {
  cool: {
    key: 'cool',
    label: 'Cool-season',
    examples: 'fescue, bluegrass, rye',
    gddBase: 50,
    // Cool-season turf is genuinely damaged by a cut in high heat.
    heatStart: 80,
    heatSlope: 2.2,
    gddWeekStrong: 140,
  },
  warm: {
    key: 'warm',
    label: 'Warm-season',
    examples: 'bermuda, zoysia, St. Augustine',
    gddBase: 65,
    heatStart: 90,
    heatSlope: 1.5,
    gddWeekStrong: 110,
  },
};

/**
 * How much the lawn's preferences are allowed to stop you.
 *
 * The engine originally encoded one standard — the one a greenkeeper would
 * use — and presented it as though it were physics. It isn't. Mowing damp
 * grass clumps, tears a bit and is harder work; on most lawns that is a
 * cosmetic cost, not a reason to wait two days. Only rain, darkness, frost
 * and genuinely soaked ground are hard stops for everyone.
 */
export const STANDARDS = {
  relaxed: {
    key: 'relaxed',
    label: 'Relaxed',
    blurb: 'Says yes unless it is raining, dark, frozen or properly soaked. A damp lawn will clump a bit — that is your call to make.',
    wetLimit: 0.80,
    frostAt: 32,
    rainAt: 0.03,
    heatScale: 0.6,
    turfStress: false,
    lateBonus: false,
    dewPenalty: false,
    windowMin: 40,
  },
  balanced: {
    key: 'balanced',
    label: 'Balanced',
    blurb: 'Waits for the grass to be mostly dry, but does not hold out for perfect.',
    wetLimit: 0.45,
    frostAt: 34,
    rainAt: 0.012,
    heatScale: 1,
    turfStress: true,
    lateBonus: true,
    dewPenalty: false,
    windowMin: 55,
  },
  fussy: {
    key: 'fussy',
    label: 'Strict',
    blurb: 'Dry grass only, out of the midday heat, at the time of day that suits the turf best.',
    wetLimit: 0.25,
    frostAt: 36,
    rainAt: 0.01,
    heatScale: 1.3,
    turfStress: true,
    lateBonus: true,
    dewPenalty: true,
    windowMin: 65,
  },
};

export const BINS = [
  { key: 'go', min: 70, label: 'Good', icon: '✓' },
  { key: 'marginal', min: 45, label: 'Marginal', icon: '~' },
  { key: 'poor', min: 1, label: 'Poor', icon: '!' },
  { key: 'blocked', min: 0, label: "Can't mow", icon: '×' },
];

export function binFor(score, blockers) {
  if (blockers && blockers.length) return BINS[3];
  return BINS.find((b) => score >= b.min) || BINS[3];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Open-Meteo omits a column entirely if the model has no data for it, so every
// read goes through here and the page degrades instead of throwing.
function col(obj, name, len, fallback) {
  const a = obj && obj[name];
  if (!Array.isArray(a) || a.length === 0) return new Array(len).fill(fallback);
  return a.map((v) => (v === null || v === undefined || Number.isNaN(v) ? fallback : v));
}

const dayOf = (t) => String(t).slice(0, 10);
const hourOf = (t) => Number(String(t).slice(11, 13));

/**
 * Local wall-clock "YYYY-MM-DDTHH:00" at the forecast location, derived from
 * the UTC offset the API reports. Avoids pulling in a timezone library.
 */
export function localNowKey(utcOffsetSeconds, nowMs = Date.now()) {
  const d = new Date(nowMs + (utcOffsetSeconds || 0) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:00`;
}

/**
 * Running leaf-wetness balance. Returns one value per hour, 0 (bone dry) to
 * ~1.6 (soaked). Rain and dew add; sun, wind, warmth and dry air subtract.
 */
export function wetnessSeries({ precip, rh, cloud, wind, temp, isDay }, start = 0.15) {
  const out = new Array(precip.length);
  let w = start;
  for (let i = 0; i < precip.length; i++) {
    w += precip[i] * 9; // 0.10" of rain ≈ +0.9

    if (!isDay[i]) {
      // Dew forms on clear, still, humid nights.
      if (rh[i] >= 92) w += 0.14;
      else if (rh[i] >= 85) w += 0.07;
      else if (rh[i] >= 75) w += 0.03;
    }

    const sun = isDay[i] ? 1 - 0.65 * (cloud[i] / 100) : 0.1;
    const windF = clamp(0.45 + wind[i] / 16, 0.3, 2.0);
    const humF = clamp((96 - rh[i]) / 42, 0.08, 1.6);
    const tempF = clamp((temp[i] - 28) / 45, 0.25, 1.6);
    w -= 0.26 * sun * windF * humF * tempF;

    w = clamp(w, 0, 1.6);
    out[i] = w;
  }
  return out;
}

/**
 * Score one hour 0–100, plus the human-readable reasons it is unmowable.
 * A blocked hour scores 0 — blockers are not penalties, they are gates.
 */
export function scoreHour(h, grass, standard = STANDARDS.balanced) {
  const std = standard || STANDARDS.balanced;
  const blockers = [];
  if (!h.isDay) blockers.push('dark');
  if (h.precip > std.rainAt) blockers.push('raining');
  if (h.temp <= std.frostAt) blockers.push('frost');
  if (h.wet > std.wetLimit) blockers.push('wet grass');
  if (blockers.length) return { score: 0, blockers, factors: [] };

  let s = 100;

  // Every adjustment is recorded as it is applied, so the score can always
  // show its own working rather than arriving as a bare number.
  const factors = [];
  const take = (label, amount) => {
    if (amount >= 0.5) { s -= amount; factors.push({ label, delta: -amount }); }
  };
  const give = (label, amount) => {
    if (amount >= 0.5) { s += amount; factors.push({ label, delta: amount }); }
  };

  // Still a little damp, even if under the limit.
  take('damp grass', (h.wet / std.wetLimit) * 12);

  // Heat is the main soft penalty, and where grass type matters most. The
  // midday-sun part is turf stress, which only matters if you care about it;
  // the rest is the person pushing the mower, which everyone feels.
  let heat = 0;
  if (h.temp > grass.heatStart) heat += (h.temp - grass.heatStart) * grass.heatSlope * std.heatScale;
  if (h.temp > 95) heat += (h.temp - 95) * 2.5;
  if (std.turfStress && h.temp >= grass.heatStart - 6 && h.cloud < 45 && h.hour >= 11 && h.hour <= 16) heat += 8;
  take('heat', heat);

  let cold = 0;
  if (h.temp < 50) cold += (50 - h.temp) * 0.9;
  if (h.temp < 40) cold += (40 - h.temp) * 1.6;
  take('cold', cold);

  if (h.wind > 18) take('wind', (h.wind - 18) * 1.6);

  // Forecast rain that hasn't committed yet.
  if (h.precipProb >= 60) take('rain likely', 14);
  else if (h.precipProb >= 40) take('rain possible', 6);

  // Don't start a cut you can't finish.
  if (h.rainInNext1h) take('rain within the hour', 26);
  else if (h.rainInNext2h) take('rain coming', 12);
  if (h.hoursToSunset !== null) {
    if (h.hoursToSunset < 1.5) take('light almost gone', 18);
    else if (h.hoursToSunset < 2.5) take('light fading', 7);
  }
  if (std.dewPenalty && h.hoursAfterSunrise !== null && h.hoursAfterSunrise < 2) take('dew only just off', 6);

  // Late afternoon leaves the plant time to recover before the next hot day.
  if (std.lateBonus && h.hour >= 16 && h.hour <= 19) give('late afternoon', 6);

  // Floor at 1. Zero is reserved for blocked hours, which always carry a
  // reason — otherwise punishing-but-possible conditions (a 110° afternoon)
  // would read as "can't mow" with nothing to explain it.
  return { score: Math.max(1, Math.round(clamp(s, 0, 100))), blockers, factors };
}

/**
 * Group consecutive mowable hours into windows and rank them.
 *
 * A window is rated by the best few hours *inside* it, not by the hours it
 * happens to start with — otherwise a long window that opens at noon loses to
 * a short one that opens at 4pm. Windows further out are discounted, because
 * "mow next Saturday" is bad advice when Tuesday is just as good and the grass
 * is growing the whole time.
 */
export function findWindows(hours, { decayPerDay = 1.5, min = 55 } = {}) {
  const windows = [];
  let cur = null;
  for (const h of hours) {
    if (h.score >= min) {
      if (!cur) cur = { start: h, end: h, hours: [h] };
      else {
        cur.end = h;
        cur.hours.push(h);
      }
    } else if (cur) {
      windows.push(cur);
      cur = null;
    }
  }
  if (cur) windows.push(cur);

  const origin = hours.length ? hours[0].index : 0;
  for (const w of windows) {
    const scores = w.hours.map((h) => h.score);
    const run = Math.min(3, scores.length);
    let bestMean = -1;
    let bestAt = 0;
    for (let i = 0; i + run <= scores.length; i++) {
      const m = scores.slice(i, i + run).reduce((a, b) => a + b, 0) / run;
      if (m > bestMean) {
        bestMean = m;
        bestAt = i;
      }
    }
    w.peak = { start: w.hours[bestAt], end: w.hours[bestAt + run - 1], mean: bestMean };
    // Room to work beats a knife-edge window, but only up to a point.
    const lengthBonus = Math.min(6, (w.hours.length - 1) * 2);
    const daysOut = (w.start.index - origin) / 24;
    w.quality = bestMean + lengthBonus - daysOut * decayPerDay;
    w.day = dayOf(w.start.time);
  }
  windows.sort((a, b) => b.quality - a.quality);
  return windows;
}

/**
 * How fast the grass is actually growing — i.e. whether he needs to mow at all.
 * Growing degree days over the coming week, damped when there's no moisture.
 */
/**
 * Daily highs, lows and rainfall rebuilt from the hourly series, for when the
 * response has no daily block. Losing the growth estimate entirely would be a
 * worse answer than deriving it.
 */
export function dailyFromHourly(hours) {
  const byDay = new Map();
  for (const h of hours) {
    let e = byDay.get(h.day);
    if (!e) byDay.set(h.day, (e = { max: -Infinity, min: Infinity, sum: 0 }));
    if (h.temp > e.max) e.max = h.temp;
    if (h.temp < e.min) e.min = h.temp;
    e.sum += h.precip;
  }
  const out = { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] };
  for (const [day, e] of byDay) {
    out.time.push(day);
    out.temperature_2m_max.push(e.max);
    out.temperature_2m_min.push(e.min);
    out.precipitation_sum.push(Math.round(e.sum * 100) / 100);
  }
  return out;
}

export function growthOutlook(daily, grass) {
  const times = (daily && daily.time) || [];
  const n = times.length;
  if (!n) {
    return { label: 'Unknown', daysBetween: 7, note: 'No daily summary available, so growth cannot be estimated.', gdd: 0, rain: 0, index: 0, avgTemp: null };
  }
  const tmax = col(daily, 'temperature_2m_max', n, 70);
  const tmin = col(daily, 'temperature_2m_min', n, 50);
  const rain = col(daily, 'precipitation_sum', n, 0);

  const todayIdx = Math.max(0, daily.pastDays || 0);
  let gdd = 0;
  let futureRain = 0;
  let tempSum = 0;
  let days = 0;
  for (let i = todayIdx; i < n && days < 7; i++, days++) {
    const mean = (tmax[i] + tmin[i]) / 2;
    gdd += Math.max(0, mean - grass.gddBase);
    tempSum += mean;
    futureRain += rain[i];
  }
  let pastRain = 0;
  for (let i = 0; i < todayIdx; i++) pastRain += rain[i];

  const heatRatio = gdd / grass.gddWeekStrong;
  const moisture = pastRain + futureRain;
  // Turf goes semi-dormant when it's dry, however warm it is.
  const moistureFactor = moisture >= 0.75 ? 1 : moisture >= 0.35 ? 0.75 : 0.5;
  const index = heatRatio * moistureFactor;

  let label, daysBetween, note;
  if (index >= 0.85) {
    label = 'Fast';
    daysBetween = 5;
    note = 'Warm and wet — it will get away from you. Plan on two cuts this week.';
  } else if (index >= 0.5) {
    label = 'Moderate';
    daysBetween = 7;
    note = 'Normal growth. One cut this week should hold it.';
  } else if (index >= 0.25) {
    label = 'Slow';
    daysBetween = 10;
    note = 'Growing slowly. You can stretch it to a week and a half.';
  } else {
    label = 'Barely growing';
    daysBetween = 14;
    note = moisture < 0.35
      ? 'Dry enough that the lawn is coasting. Cutting a stressed lawn does more harm than good — consider skipping.'
      : 'Too cool for much growth. Skipping a week is fine.';
  }
  return {
    label, daysBetween, note, index,
    gdd: Math.round(gdd),
    rain: Math.round(moisture * 100) / 100,
    // The plain figure behind the degree-day sum, for saying it in English.
    avgTemp: days ? Math.round(tempSum / days) : null,
  };
}

/**
 * Main entry point. Takes a raw Open-Meteo response and returns everything the
 * page renders.
 */
export function analyze(data, grassKey = 'cool', nowMs = Date.now(), standardKey = 'balanced') {
  const grass = GRASS[grassKey] || GRASS.cool;
  const standard = STANDARDS[standardKey] || STANDARDS.balanced;
  const H = data.hourly || {};
  const time = H.time || [];
  const n = time.length;
  if (!n) throw new Error('No hourly data in forecast response.');

  const temp = col(H, 'temperature_2m', n, 65);
  const rh = col(H, 'relative_humidity_2m', n, 70);
  const precip = col(H, 'precipitation', n, 0);
  const precipProb = col(H, 'precipitation_probability', n, 0);
  const wind = col(H, 'wind_speed_10m', n, 5);
  const cloud = col(H, 'cloud_cover', n, 50);
  const isDayRaw = col(H, 'is_day', n, 1);

  const wet = wetnessSeries({ precip, rh, cloud, wind, temp, isDay: isDayRaw.map(Boolean) });

  // Sunrise/sunset per calendar day, for "can I finish before dark".
  const sun = {};
  const D = data.daily || {};
  (D.time || []).forEach((d, i) => {
    sun[d] = {
      rise: D.sunrise && D.sunrise[i] ? hourOf(D.sunrise[i]) + Number(String(D.sunrise[i]).slice(14, 16)) / 60 : 6.5,
      set: D.sunset && D.sunset[i] ? hourOf(D.sunset[i]) + Number(String(D.sunset[i]).slice(14, 16)) / 60 : 20,
    };
  });

  const nowKey = localNowKey(data.utc_offset_seconds, nowMs);
  let nowIdx = time.indexOf(nowKey);
  if (nowIdx === -1) nowIdx = time.findIndex((t) => t >= nowKey);
  if (nowIdx === -1) nowIdx = 0;

  const hours = time.map((t, i) => {
    const d = dayOf(t);
    const hr = hourOf(t);
    const s = sun[d] || { rise: 6.5, set: 20 };
    const rainSoon = (k) => {
      for (let j = i + 1; j <= i + k && j < n; j++) if (precip[j] > 0.012) return true;
      return false;
    };
    const h = {
      time: t,
      day: d,
      hour: hr,
      index: i,
      temp: temp[i],
      rh: rh[i],
      precip: precip[i],
      precipProb: precipProb[i],
      wind: wind[i],
      cloud: cloud[i],
      isDay: Boolean(isDayRaw[i]),
      wet: wet[i],
      hoursToSunset: s.set - hr,
      hoursAfterSunrise: hr - s.rise,
      rainInNext1h: rainSoon(1),
      rainInNext2h: rainSoon(2),
      past: i < nowIdx,
    };
    const { score, blockers, factors } = scoreHour(h, grass, standard);
    h.score = score;
    h.blockers = blockers;
    h.factors = factors || [];
    h.bin = binFor(score, blockers);
    return h;
  });

  const allFuture = hours.filter((h) => !h.past);

  // One row per calendar day, today forward.
  const byDay = new Map();
  for (const h of allFuture) {
    if (!byDay.has(h.day)) byDay.set(h.day, []);
    byDay.get(h.day).push(h);
  }

  // Only consider the days the page actually shows, so the recommended window
  // can never land on a day the reader can't see in the list.
  const shownDays = new Set([...byDay.keys()].slice(0, 7));
  const future = allFuture.filter((h) => shownDays.has(h.day));
  const windows = findWindows(future, { min: standard.windowMin });

  const days = [...byDay.entries()].slice(0, 7).map(([day, hs]) => {
    // No recency discount within a single day — we just want that day's best.
    const dayWindows = findWindows(hs, { decayPerDay: 0, min: standard.windowMin });
    return { day, hours: hs, best: dayWindows[0] || null, peak: Math.max(0, ...hs.map((h) => h.score)) };
  });

  const dailyBase = Array.isArray(D.time) && D.time.length ? D : dailyFromHourly(hours);
  const daily = { ...dailyBase, pastDays: (dailyBase.time || []).findIndex((d) => d === dayOf(nowKey)) };
  if (daily.pastDays < 0) daily.pastDays = 0;

  return {
    hours,
    future,
    days,
    windows,
    best: windows[0] || null,
    now: hours[nowIdx] || null,
    // When it's too wet right now, when does that clear?
    dryAt: hours.slice(nowIdx).find((h) => h.wet <= standard.wetLimit && h.isDay) || null,
    growth: growthOutlook(daily, grass),
    grass,
    standard,
    timezone: data.timezone,
  };
}

/** One plain-English sentence explaining the current hour. */
export function explainNow(a) {
  const h = a.now;
  if (!h) return 'No current conditions available.';
  if (h.blockers.includes('raining')) return "It's raining. Wet grass tears instead of cutting.";
  if (h.blockers.includes('frost')) return 'Frost on the grass — mowing now will damage the lawn.';
  if (h.blockers.includes('dark')) return "It's dark out.";
  if (h.blockers.includes('wet grass')) {
    if (a.dryAt) return `Grass is still wet. Should be dry enough around ${fmtHour(a.dryAt.hour)}.`;
    return 'Grass is still wet from recent rain.';
  }
  if (h.score >= 70) return 'Conditions are good right now.';
  const why = [];
  if (h.temp > a.grass.heatStart) why.push(`it's ${Math.round(h.temp)}°`);
  if (h.wind > 18) why.push(`wind at ${Math.round(h.wind)} mph`);
  if (h.rainInNext2h) why.push('rain moving in');
  if (h.precipProb >= 40) why.push(`${h.precipProb}% chance of rain`);
  if (h.hoursToSunset < 2.5) why.push('not much daylight left');
  return why.length ? `Doable, but ${why.join(', ')}.` : 'Doable, but not ideal.';
}

export function fmtHour(h) {
  const hr = ((Math.floor(h) + 11) % 12) + 1;
  return `${hr}${Math.floor(h) < 12 ? 'am' : 'pm'}`;
}

export function fmtWindow(w) {
  if (!w) return null;
  return `${fmtHour(w.start.hour)}–${fmtHour(w.end.hour + 1)}`;
}

export function fmtDay(dayStr, todayStr, tomorrowStr) {
  if (dayStr === todayStr) return 'Today';
  if (dayStr === tomorrowStr) return 'Tomorrow';
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
}
