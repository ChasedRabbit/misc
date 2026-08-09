// wall.js — scoring engine for "when should I work on the retaining wall".
//
// Pure functions, no DOM, no network. Same shape as the mowing engine next
// door, but the job is different in two ways that drive the whole design:
//
//   1. It is a whole-day job, not a one-hour job. The question is "is Saturday
//      a work day", and better still "are Saturday and Sunday both work days",
//      because a wall is not something you start and abandon half-built.
//   2. What stops you is the state of the GROUND, not the surface. Soil drains
//      over days, not hours, so a Tuesday downpour can still be the reason you
//      can't dig on Thursday. You cannot compact saturated soil — the base
//      will settle later and the wall will lean.
//
// The formatters are duplicated from mow.js rather than shared, so this tool
// stays independently deployable and the working mow page is never touched.

// vwcWork is the volumetric water content (m³/m³) above which the soil is too
// wet to compact properly — roughly field capacity, where the soil passes its
// plastic limit and a roller or plate just kneads it instead of densifying it.
// Clay holds far more water before it gets there than sand does.
export const SOIL = {
  clay: {
    key: 'clay',
    label: 'Clay',
    examples: 'heavy and sticky, puddles sit on top',
    drainRate: 0.6,
    workLimit: 0.50,
    vwcWork: 0.34,
  },
  loam: {
    key: 'loam',
    label: 'Loam',
    examples: 'ordinary garden soil, the usual case',
    drainRate: 1.0,
    workLimit: 0.55,
    vwcWork: 0.28,
  },
  sand: {
    key: 'sand',
    label: 'Sandy',
    examples: 'gritty, water disappears fast',
    drainRate: 1.7,
    workLimit: 0.62,
    vwcWork: 0.16,
  },
};

// Deepest first: 9–27cm is about base-course depth, which is the layer that
// decides whether compaction will hold. The shallower layers are fallbacks for
// models that don't publish the deeper ones.
export const MOISTURE_LAYERS = [
  { key: 'soil_moisture_9_to_27cm', label: '9–27cm' },
  { key: 'soil_moisture_3_to_9cm', label: '3–9cm' },
  { key: 'soil_moisture_1_to_3cm', label: '1–3cm' },
  { key: 'soil_moisture_0_to_1cm', label: '0–1cm' },
];

/**
 * Field capacity (water content at -33 kPa) from measured texture and organic
 * matter, after Saxton & Rawls (2006). This replaces the three bucket
 * constants above with a continuous, site-specific number wherever the soil
 * survey answers — a 36%-clay soil and a 55%-clay soil stop being the same
 * "clay", and organic matter finally counts for something.
 *
 * @param clay  percent by weight
 * @param sand  percent by weight
 * @param organicMatter percent (roughly organic carbon x 1.724)
 * @returns m3/m3, or null if the inputs aren't usable
 */
export function fieldCapacity({ clay, sand, organicMatter = 2 }) {
  if (!Number.isFinite(clay) || !Number.isFinite(sand)) return null;
  if (clay < 0 || sand < 0 || clay > 100 || sand > 100 || clay + sand > 100.5) return null;

  const C = clay / 100;
  const S = sand / 100;
  const OM = clamp(Number.isFinite(organicMatter) ? organicMatter : 2, 0, 8);

  const t =
    -0.251 * S + 0.195 * C + 0.011 * OM +
    0.006 * (S * OM) - 0.027 * (C * OM) +
    0.452 * (S * C) + 0.299;
  const theta33 = t + (1.283 * t * t - 0.374 * t - 0.015);

  // Guard against the regression wandering outside physically sensible ground.
  if (!Number.isFinite(theta33)) return null;
  return clamp(theta33, 0.05, 0.55);
}

/**
 * Simplified USDA texture triangle — enough to choose between the three
 * settings this tool offers. Percentages by weight.
 */
export function classifySoil({ clay, sand }) {
  if (!Number.isFinite(clay) || !Number.isFinite(sand)) return null;
  if (clay >= 35) return 'clay';
  if (sand >= 70 && clay < 20) return 'sand';
  return 'loam';
}

// Working day runs 7am–7pm; nobody is setting block by phone light.
const WORK_START = 7;
const WORK_END = 19;
// An hour at or above this counts as workable.
const HOUR_OK = 55;
// A day needs this many workable hours before it's worth hauling tools out.
const FULL_DAY_HOURS = 6;
const HALF_DAY_HOURS = 3;

export const BINS = [
  { key: 'go', min: 70, label: 'Good', icon: '✓' },
  { key: 'marginal', min: 45, label: 'Marginal', icon: '~' },
  { key: 'poor', min: 1, label: 'Poor', icon: '!' },
  { key: 'blocked', min: 0, label: "Can't work", icon: '×' },
];

export function binFor(score, blockers) {
  if (blockers && blockers.length) return BINS[3];
  return BINS.find((b) => score >= b.min) || BINS[3];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function col(obj, name, len, fallback) {
  const a = obj && obj[name];
  if (!Array.isArray(a) || a.length === 0) return new Array(len).fill(fallback);
  return a.map((v) => (v === null || v === undefined || Number.isNaN(v) ? fallback : v));
}

const dayOf = (t) => String(t).slice(0, 10);
const hourOf = (t) => Number(String(t).slice(11, 13));

export function localNowKey(utcOffsetSeconds, nowMs = Date.now()) {
  const d = new Date(nowMs + (utcOffsetSeconds || 0) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:00`;
}

/**
 * NWS Rothfusz heat index. Heavy lifting in humid heat is a safety limit, not
 * a comfort preference, so this drives a hard stop rather than a penalty.
 */
export function heatIndex(tempF, rh) {
  if (tempF < 80) return tempF;
  const T = tempF;
  const R = rh;
  return (
    -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R -
    0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R +
    0.00085282 * T * R * R - 0.00000199 * T * T * R * R
  );
}

/**
 * Ground saturation, 0 (dry) to ~1.6 (waterlogged), carried hour by hour.
 * Rain soaks in; sun, wind, warmth and dry air pull it back out, scaled by how
 * freely the soil drains. Frozen ground barely drains at all.
 */
export function saturationSeries({ precip, rh, cloud, wind, temp, isDay, et0 }, soil, start = 0.35) {
  const out = new Array(precip.length);
  const hasEt0 = Array.isArray(et0) && et0.some((v) => Number.isFinite(v) && v > 0);
  let s = start;
  for (let i = 0; i < precip.length; i++) {
    s += precip[i] * 1.1; // half an inch of rain ≈ +0.55

    const frozen = temp[i] <= 32 ? 0.05 : 1;
    let dry;
    if (hasEt0) {
      // Reference evapotranspiration is the physically-derived drying rate, so
      // prefer it over inferring one from sun, wind and humidity. The constant
      // stands in for gravity drainage, which continues after dark.
      dry = (Math.max(0, et0[i]) * 1.1 + 0.003) * soil.drainRate;
    } else {
      const sun = isDay[i] ? 1 - 0.6 * (cloud[i] / 100) : 0.15;
      const windF = clamp(0.5 + wind[i] / 22, 0.35, 1.6);
      const humF = clamp((95 - rh[i]) / 45, 0.1, 1.5);
      const tempF = clamp((temp[i] - 25) / 50, 0.15, 1.5);
      dry = 0.03 * soil.drainRate * sun * windF * humF * tempF;
    }

    s -= dry * frozen;
    s = clamp(s, 0, 1.6);
    out[i] = s;
  }
  return out;
}

/**
 * Map measured volumetric water content onto the same scale the estimator
 * produces, so everything downstream is unchanged: at exactly the soil's
 * workable limit the result equals soil.workLimit.
 */
export function saturationFromMeasured(vwc, soil) {
  return vwc.map((v) =>
    Number.isFinite(v) ? clamp((v / soil.vwcWork) * soil.workLimit, 0, 1.6) : soil.workLimit
  );
}

/** First moisture layer the response actually carries usable numbers for. */
export function pickMoistureLayer(hourly, n) {
  for (const layer of MOISTURE_LAYERS) {
    const a = hourly[layer.key];
    if (!Array.isArray(a) || a.length !== n) continue;
    const usable = a.filter((v) => Number.isFinite(v) && v > 0);
    // A column of nulls or flat zeros means the model didn't run it here.
    if (usable.length >= n * 0.5) return layer;
  }
  return null;
}

export function scoreHour(h, soil) {
  const blockers = [];
  if (!h.isDay || h.hour < WORK_START || h.hour >= WORK_END) blockers.push('outside working hours');
  if (h.precip > 0.01) blockers.push('raining');
  if (h.snow) blockers.push('snow on the ground');
  if (h.groundFrozen) blockers.push('frozen ground');
  if (h.saturation > soil.workLimit) blockers.push('ground too wet');
  if (h.heatIndex >= 103) blockers.push('dangerous heat');
  if (blockers.length) return { score: 0, blockers };

  let s = 100;

  // Approaching the wet limit is still heavy, sloppy digging.
  s -= (h.saturation / soil.workLimit) * 14;

  // Heat, on a scale that matters for sustained lifting.
  if (h.heatIndex > 88) s -= (h.heatIndex - 88) * 2.4;
  else if (h.heatIndex > 80) s -= (h.heatIndex - 80) * 0.8;

  // Cold: block adhesive and mortar won't cure, and hands stop working.
  if (h.temp < 45) s -= (45 - h.temp) * 1.4;
  if (h.temp < 38) s -= (38 - h.temp) * 2.0;

  // An open trench and incoming rain is the worst combination on this job.
  if (h.rainInNext3h) s -= 22;
  if (h.precipProb >= 50) s -= 12;
  else if (h.precipProb >= 30) s -= 5;

  if (h.wind > 25) s -= (h.wind - 25) * 1.2;

  // Not enough daylight left to reach a sensible stopping point.
  if (h.hoursLeftInDay < 2) s -= 12;

  // Floor at 1. Zero is reserved for blocked hours, which always carry a
  // reason — otherwise grim-but-possible conditions would read as "can't
  // work" with nothing to explain it.
  return { score: Math.max(1, Math.round(clamp(s, 0, 100))), blockers };
}

/** Contiguous runs of workable hours within one day. */
export function findRuns(hours, min = HOUR_OK) {
  const runs = [];
  let cur = null;
  for (const h of hours) {
    if (h.score >= min) {
      if (!cur) cur = { start: h, end: h, hours: [h] };
      else { cur.end = h; cur.hours.push(h); }
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  for (const r of runs) {
    r.length = r.hours.length;
    r.mean = r.hours.reduce((a, b) => a + b.score, 0) / r.length;
  }
  runs.sort((a, b) => b.length - a.length || b.mean - a.mean);
  return runs;
}

/**
 * Consecutive workable days. A wall is a multi-day job, so a pair of decent
 * days in a row beats one perfect day flanked by washouts.
 */
export function findStretches(days, minHours = FULL_DAY_HOURS) {
  const stretches = [];
  let cur = null;
  for (const d of days) {
    if (d.workableHours >= minHours) {
      if (!cur) cur = { days: [d] };
      else cur.days.push(d);
    } else if (cur) { stretches.push(cur); cur = null; }
  }
  if (cur) stretches.push(cur);

  for (const s of stretches) {
    s.length = s.days.length;
    s.mean = s.days.reduce((a, b) => a + b.score, 0) / s.length;
    s.start = s.days[0];
    s.end = s.days[s.days.length - 1];
    // Continuity dominates. On a multi-day build, two decent days back to back
    // beat one nicer day flanked by washouts — you can set base and course in
    // the same run instead of returning to a half-dug trench.
    s.quality = s.mean + Math.min(28, (s.length - 1) * 14);
  }
  stretches.sort((a, b) => b.quality - a.quality);
  return stretches;
}

/**
 * Will fresh work survive the night? Block adhesive and mortar need a dry,
 * above-freezing window after they go down.
 */
export function cureRisk(day, hoursAfter) {
  const risks = [];
  let rain = 0;
  let minTemp = Infinity;
  for (const h of hoursAfter.slice(0, 24)) {
    rain += h.precip;
    if (h.temp < minTemp) minTemp = h.temp;
  }
  if (rain > 0.1) risks.push(`${rain.toFixed(2)}" of rain in the 24h after`);
  if (minTemp <= 32) risks.push(`drops to ${Math.round(minTemp)}° overnight`);
  else if (minTemp < 40) risks.push(`down to ${Math.round(minTemp)}° overnight`);
  return { risks, rain, minTemp: minTemp === Infinity ? null : minTemp };
}

/**
 * @param site optional measured soil properties for this exact spot
 *             ({ clay, sand, organicMatter } as percentages). When supplied,
 *             the workable water content is computed from them instead of
 *             taken from the three-bucket table.
 */
export function analyze(data, soilKey = 'loam', nowMs = Date.now(), site = null) {
  const bucket = SOIL[soilKey] || SOIL.loam;

  const measuredFc = site ? fieldCapacity(site) : null;
  const soil = measuredFc ? { ...bucket, vwcWork: measuredFc } : bucket;
  const soilBasis = measuredFc
    ? { source: 'measured', vwcWork: measuredFc, clay: site.clay, sand: site.sand, organicMatter: site.organicMatter }
    : { source: 'typical', vwcWork: bucket.vwcWork };
  const H = data.hourly || {};
  const time = H.time || [];
  const n = time.length;
  if (!n) throw new Error('No hourly data in forecast response.');

  const temp = col(H, 'temperature_2m', n, 60);
  const rh = col(H, 'relative_humidity_2m', n, 65);
  const precip = col(H, 'precipitation', n, 0);
  const precipProb = col(H, 'precipitation_probability', n, 0);
  const wind = col(H, 'wind_speed_10m', n, 6);
  const cloud = col(H, 'cloud_cover', n, 50);
  const isDayRaw = col(H, 'is_day', n, 1);
  // Real soil temperature when the model provides it; air temperature is a
  // poor stand-in but better than pretending the ground can't freeze.
  const hasSoilTemp = Array.isArray(H.soil_temperature_0cm) && H.soil_temperature_0cm.length === n;
  const soilTemp = col(H, 'soil_temperature_0cm', n, null);
  const snowDepth = col(H, 'snow_depth', n, 0);
  const et0 = Array.isArray(H.et0_fao_evapotranspiration) ? col(H, 'et0_fao_evapotranspiration', n, 0) : null;

  // Prefer the land-surface model's own soil moisture over inferring it from
  // rainfall. Fall back to the estimator when the model doesn't publish it.
  const layer = pickMoistureLayer(H, n);
  const sat = layer
    ? saturationFromMeasured(col(H, layer.key, n, null), soil)
    : saturationSeries(
        { precip, rh, cloud, wind, temp, isDay: isDayRaw.map(Boolean), et0 },
        soil
      );
  const moisture = {
    source: layer ? 'measured' : 'estimated',
    layer: layer ? layer.label : null,
    usedEt0: !layer && Array.isArray(et0) && et0.some((v) => v > 0),
  };

  const nowKey = localNowKey(data.utc_offset_seconds, nowMs);
  let nowIdx = time.indexOf(nowKey);
  if (nowIdx === -1) nowIdx = time.findIndex((t) => t >= nowKey);
  if (nowIdx === -1) nowIdx = 0;

  const hours = time.map((t, i) => {
    const hr = hourOf(t);
    const rainSoon = (k) => {
      for (let j = i + 1; j <= i + k && j < n; j++) if (precip[j] > 0.01) return true;
      return false;
    };
    const h = {
      time: t,
      day: dayOf(t),
      hour: hr,
      index: i,
      temp: temp[i],
      rh: rh[i],
      precip: precip[i],
      precipProb: precipProb[i],
      wind: wind[i],
      cloud: cloud[i],
      isDay: Boolean(isDayRaw[i]),
      saturation: sat[i],
      heatIndex: heatIndex(temp[i], rh[i]),
      // snow_depth is metres; a couple of centimetres is enough to stop work.
      snow: snowDepth[i] > 0.02,
      groundFrozen: hasSoilTemp ? soilTemp[i] <= 32 : temp[i] <= 30,
      rainInNext3h: rainSoon(3),
      hoursLeftInDay: WORK_END - hr,
      past: i < nowIdx,
    };
    const { score, blockers } = scoreHour(h, soil);
    h.score = score;
    h.blockers = blockers;
    h.bin = binFor(score, blockers);
    return h;
  });

  const future = hours.filter((h) => !h.past);

  const byDay = new Map();
  for (const h of future) {
    if (!byDay.has(h.day)) byDay.set(h.day, []);
    byDay.get(h.day).push(h);
  }

  // Only analyse the days the page actually shows, so a recommendation can
  // never point at a day the reader can't see.
  const days = [...byDay.entries()].slice(0, 7).map(([day, hs]) => {
    const workHours = hs.filter((h) => h.hour >= WORK_START && h.hour < WORK_END);
    const workable = workHours.filter((h) => h.score >= HOUR_OK);
    const runs = findRuns(workHours);
    const best = runs[0] || null;
    const lastIdx = workHours.length ? workHours[workHours.length - 1].index : 0;
    return {
      day,
      hours: hs,
      workHours,
      workableHours: workable.length,
      best,
      // Rate the day on its usable block, not on its best single hour.
      score: best ? Math.round(best.mean * Math.min(1, best.length / FULL_DAY_HOURS)) : 0,
      cure: cureRisk(null, hours.slice(lastIdx + 1)),
      blockedBy: workable.length === 0 && workHours.length
        ? [...new Set(workHours.flatMap((h) => h.blockers))][0] || null
        : null,
    };
  });

  const stretches = findStretches(days);
  // Fall back to half-days if nothing in the week clears a full day.
  const partial = stretches.length ? [] : findStretches(days, HALF_DAY_HOURS);

  const nowHour = hours[nowIdx] || null;
  const workableAt = hours
    .slice(nowIdx)
    .find((h) => h.score >= HOUR_OK) || null;

  return {
    hours,
    future,
    days,
    stretches,
    partial,
    best: stretches[0] || partial[0] || null,
    now: nowHour,
    workableAt,
    dryAt: hours.slice(nowIdx).find((h) => h.saturation <= soil.workLimit) || null,
    soil,
    soilBasis,
    hasSoilTemp,
    moisture,
    timezone: data.timezone,
  };
}

export function explainNow(a) {
  const h = a.now;
  if (!h) return 'No current conditions available.';
  if (h.blockers.includes('raining')) return "It's raining. Nothing to be done outside today.";
  if (h.blockers.includes('frozen ground')) return "The ground is frozen — you can't dig it or compact it.";
  if (h.blockers.includes('dangerous heat')) {
    return `Heat index ${Math.round(h.heatIndex)}°. Too hot for this kind of work safely.`;
  }
  if (h.blockers.includes('ground too wet')) {
    if (a.dryAt && !a.dryAt.past) {
      return `Ground is still saturated. On ${a.soil.label.toLowerCase()} soil it should be workable around ${fmtDayShort(a.dryAt.day)}.`;
    }
    return 'Ground is still saturated from recent rain — compaction now would settle later.';
  }
  if (h.blockers.includes('outside working hours')) return 'Outside working hours.';
  if (h.score >= 70) return 'Good conditions for it right now.';

  const why = [];
  if (h.heatIndex > 88) why.push(`feels like ${Math.round(h.heatIndex)}°`);
  if (h.temp < 45) why.push(`only ${Math.round(h.temp)}°`);
  if (h.rainInNext3h) why.push('rain within a few hours');
  if (h.saturation > a.soil.workLimit * 0.8) why.push('ground still heavy');
  if (h.hoursLeftInDay < 2) why.push('little daylight left');
  return why.length ? `Workable, but ${why.join(', ')}.` : 'Workable, but not ideal.';
}

export function fmtHour(h) {
  const hr = ((Math.floor(h) + 11) % 12) + 1;
  return `${hr}${Math.floor(h) < 12 ? 'am' : 'pm'}`;
}

export function fmtRun(r) {
  if (!r) return null;
  return `${fmtHour(r.start.hour)}–${fmtHour(r.end.hour + 1)}`;
}

export function fmtDay(dayStr, todayStr, tomorrowStr) {
  if (dayStr === todayStr) return 'Today';
  if (dayStr === tomorrowStr) return 'Tomorrow';
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
}

function fmtDayShort(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
}
