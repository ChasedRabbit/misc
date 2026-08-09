// Adversarial tests for both engines: malformed API responses, physically
// extreme weather, odd timezones, and randomised fuzzing against invariants
// that must hold no matter what the weather service returns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mow from '../mow.js';
import * as wall from '../wall/wall.js';
import { makeDemoData } from '../demo-data.js';

const NOW = Date.UTC(2026, 7, 9, 9, 0, 0);
const ENGINES = [
  { name: 'mow', mod: mow, kinds: ['cool', 'warm'] },
  { name: 'wall', mod: wall, kinds: ['clay', 'loam', 'sand'] },
];

// Deterministic PRNG so a failure is reproducible from its seed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomForecast(seed, opts = {}) {
  const r = rng(seed);
  const hours = opts.hours ?? 24 * 8;
  const pick = (lo, hi) => lo + r() * (hi - lo);
  const time = [], temperature_2m = [], relative_humidity_2m = [], precipitation = [];
  const precipitation_probability = [], wind_speed_10m = [], cloud_cover = [], is_day = [];
  const soil_temperature_0cm = [];

  const start = new Date(NOW);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 3);

  for (let i = 0; i < hours; i++) {
    const d = new Date(start.getTime() + i * 3600e3);
    const p = (n) => String(n).padStart(2, '0');
    time.push(`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:00`);
    // Deliberately unreasonable ranges, including record extremes.
    temperature_2m.push(Math.round(pick(-40, 130) * 10) / 10);
    relative_humidity_2m.push(Math.round(pick(0, 100)));
    precipitation.push(r() < 0.25 ? Math.round(pick(0, 2) * 100) / 100 : 0);
    precipitation_probability.push(Math.round(pick(0, 100)));
    wind_speed_10m.push(Math.round(pick(0, 120)));
    cloud_cover.push(Math.round(pick(0, 100)));
    is_day.push(r() < 0.5 ? 1 : 0);
    soil_temperature_0cm.push(Math.round(pick(-30, 110) * 10) / 10);
  }

  const daily = { time: [], sunrise: [], sunset: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] };
  for (let d = 0; d < Math.ceil(hours / 24); d++) {
    const dt = new Date(start.getTime() + d * 86400e3);
    const p = (n) => String(n).padStart(2, '0');
    const key = `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
    daily.time.push(key);
    daily.sunrise.push(`${key}T06:00`);
    daily.sunset.push(`${key}T20:00`);
    daily.temperature_2m_max.push(Math.round(pick(-30, 125)));
    daily.temperature_2m_min.push(Math.round(pick(-45, 95)));
    daily.precipitation_sum.push(Math.round(pick(0, 4) * 100) / 100);
  }

  return {
    timezone: 'UTC', utc_offset_seconds: opts.offset ?? 0,
    hourly: {
      time, temperature_2m, relative_humidity_2m, precipitation,
      precipitation_probability, wind_speed_10m, cloud_cover, is_day, soil_temperature_0cm,
    },
    daily,
  };
}

/** Invariants that must hold for any output of either engine. */
function checkInvariants(a, label) {
  assert.ok(a.days.length <= 7, `${label}: more days than the page shows (${a.days.length})`);

  for (const h of a.hours) {
    assert.ok(Number.isInteger(h.score), `${label}: non-integer score ${h.score} at ${h.time}`);
    assert.ok(h.score >= 0 && h.score <= 100, `${label}: score out of range ${h.score} at ${h.time}`);
    assert.ok(Array.isArray(h.blockers), `${label}: blockers missing at ${h.time}`);
    // A cell the reader sees as unusable must be able to say why.
    if (h.bin.key === 'blocked') {
      assert.ok(h.blockers.length > 0, `${label}: hour ${h.time} reads "can't" with no reason given`);
    }
    if (h.blockers.length) {
      assert.equal(h.score, 0, `${label}: blocked hour ${h.time} scored ${h.score}`);
    }
  }

  const shown = new Set(a.days.map((d) => d.day));
  if (a.best) {
    const day = a.best.day || (a.best.start && (a.best.start.day || a.best.start.time?.slice(0, 10)));
    if (day) assert.ok(shown.has(day), `${label}: recommends ${day}, which is not in the visible list`);
  }
}

for (const { name, mod, kinds } of ENGINES) {
  test(`${name}: survives a response with no daily block at all`, () => {
    const data = randomForecast(1);
    delete data.daily;
    const a = mod.analyze(data, kinds[0], NOW);
    checkInvariants(a, name);
  });

  test(`${name}: survives a daily block missing its time array`, () => {
    const data = randomForecast(2);
    delete data.daily.time;
    const a = mod.analyze(data, kinds[0], NOW);
    checkInvariants(a, name);
  });

  test(`${name}: survives hourly columns full of nulls`, () => {
    const data = randomForecast(3);
    for (const k of Object.keys(data.hourly)) {
      if (k !== 'time') data.hourly[k] = data.hourly[k].map(() => null);
    }
    const a = mod.analyze(data, kinds[0], NOW);
    checkInvariants(a, name);
  });

  test(`${name}: survives polar night — every hour dark`, () => {
    const data = randomForecast(4);
    data.hourly.is_day = data.hourly.is_day.map(() => 0);
    const a = mod.analyze(data, kinds[0], NOW);
    checkInvariants(a, name);
    assert.equal(a.best, null, `${name}: should not recommend a time in permanent darkness`);
  });

  test(`${name}: survives a single hour of forecast`, () => {
    const data = randomForecast(5, { hours: 1 });
    const a = mod.analyze(data, kinds[0], NOW);
    checkInvariants(a, name);
  });

  test(`${name}: survives a "now" that is past the end of the forecast`, () => {
    const data = randomForecast(6);
    const a = mod.analyze(data, kinds[0], NOW + 1000 * 86400e3);
    checkInvariants(a, name);
  });

  test(`${name}: handles half-hour and three-quarter-hour timezone offsets`, () => {
    for (const offset of [5.5 * 3600, 5.75 * 3600, -3.5 * 3600, 12.75 * 3600, -11 * 3600]) {
      const data = randomForecast(7, { offset });
      const a = mod.analyze(data, kinds[0], NOW);
      checkInvariants(a, `${name} offset ${offset}`);
    }
  });

  test(`${name}: fuzz — 150 random forecasts hold every invariant`, () => {
    for (let seed = 1; seed <= 150; seed++) {
      const kind = kinds[seed % kinds.length];
      const data = randomForecast(seed * 7919);
      let a;
      try {
        a = mod.analyze(data, kind, NOW);
      } catch (err) {
        assert.fail(`${name}: threw on seed ${seed} (${kind}): ${err.message}`);
      }
      checkInvariants(a, `${name} seed ${seed}`);
    }
  });

  test(`${name}: an unknown soil/grass type falls back instead of crashing`, () => {
    const a = mod.analyze(randomForecast(8), 'nonsense-type', NOW);
    checkInvariants(a, name);
  });
}

test('mow: more rain never makes the grass drier', () => {
  const n = 48;
  const mk = (rate) => mow.wetnessSeries({
    precip: Array.from({ length: n }, (_, i) => (i < 6 ? rate : 0)),
    rh: new Array(n).fill(60),
    cloud: new Array(n).fill(40),
    wind: new Array(n).fill(8),
    temp: new Array(n).fill(70),
    isDay: new Array(n).fill(true),
  });
  let prev = null;
  for (const rate of [0, 0.02, 0.05, 0.1, 0.3]) {
    const series = mk(rate);
    if (prev) for (let i = 0; i < n; i++) assert.ok(series[i] >= prev[i] - 1e-9, `wetness fell with more rain at hour ${i}`);
    prev = series;
  }
});

test('wall: more rain never makes the ground drier', () => {
  const n = 96;
  const mk = (rate) => wall.saturationSeries({
    precip: Array.from({ length: n }, (_, i) => (i < 6 ? rate : 0)),
    rh: new Array(n).fill(60),
    cloud: new Array(n).fill(40),
    wind: new Array(n).fill(8),
    temp: new Array(n).fill(70),
    isDay: new Array(n).fill(true),
  }, wall.SOIL.loam);
  let prev = null;
  for (const rate of [0, 0.02, 0.05, 0.1, 0.3]) {
    const series = mk(rate);
    if (prev) for (let i = 0; i < n; i++) assert.ok(series[i] >= prev[i] - 1e-9, `saturation fell with more rain at hour ${i}`);
    prev = series;
  }
});

test('both engines agree the demo week is not a crash', () => {
  const data = makeDemoData(NOW);
  checkInvariants(mow.analyze(data, 'cool', NOW), 'mow demo');
  checkInvariants(wall.analyze(data, 'loam', NOW), 'wall demo');
});
