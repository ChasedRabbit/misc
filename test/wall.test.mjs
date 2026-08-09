import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze, scoreHour, saturationSeries, heatIndex, findRuns, findStretches, cureRisk, SOIL,
} from '../wall/wall.js';
import { makeDemoData } from '../demo-data.js';

const NOW = Date.UTC(2026, 7, 9, 9, 0, 0);
const base = {
  temp: 68, rh: 50, precip: 0, precipProb: 0, wind: 6, cloud: 30,
  saturation: 0.2, heatIndex: 68, groundFrozen: false, isDay: true,
  hour: 10, rainInNext3h: false, hoursLeftInDay: 9,
};

test('heat index matches the NWS formula in its valid range', () => {
  // Below 80F the formula is not applied.
  assert.equal(heatIndex(70, 90), 70);
  // 90F at 70% RH is about 106F.
  assert.ok(Math.abs(heatIndex(90, 70) - 106) < 2, `got ${heatIndex(90, 70)}`);
  // Dry heat feels close to the air temperature.
  assert.ok(Math.abs(heatIndex(95, 15) - 95) < 5, `got ${heatIndex(95, 15)}`);
});

test('rain, frozen ground, saturation and dangerous heat all block outright', () => {
  assert.equal(scoreHour({ ...base, precip: 0.05 }, SOIL.loam).score, 0);

  const frozen = scoreHour({ ...base, groundFrozen: true }, SOIL.loam);
  assert.equal(frozen.score, 0);
  assert.ok(frozen.blockers.includes('frozen ground'));

  const wet = scoreHour({ ...base, saturation: 0.9 }, SOIL.loam);
  assert.equal(wet.score, 0);
  assert.ok(wet.blockers.includes('ground too wet'));

  const hot = scoreHour({ ...base, temp: 96, rh: 60, heatIndex: heatIndex(96, 60) }, SOIL.loam);
  assert.equal(hot.score, 0);
  assert.ok(hot.blockers.includes('dangerous heat'));
});

test('work is confined to daylight working hours', () => {
  assert.equal(scoreHour({ ...base, hour: 5 }, SOIL.loam).score, 0);
  assert.equal(scoreHour({ ...base, hour: 20 }, SOIL.loam).score, 0);
  assert.equal(scoreHour({ ...base, hour: 6, isDay: false }, SOIL.loam).score, 0);
  assert.ok(scoreHour({ ...base, hour: 8 }, SOIL.loam).score > 0);
});

test('a mild dry day scores well', () => {
  const good = scoreHour(base, SOIL.loam);
  assert.equal(good.blockers.length, 0);
  assert.ok(good.score >= 85, `expected >=85, got ${good.score}`);
});

test('soil type changes how wet is too wet', () => {
  const damp = { ...base, saturation: 0.58 };
  assert.ok(scoreHour(damp, SOIL.clay).blockers.includes('ground too wet'), 'clay should be blocked');
  assert.equal(scoreHour(damp, SOIL.sand).blockers.length, 0, 'sand should still be workable');
});

test('sandy soil drains faster than clay after the same rain', () => {
  const n = 72;
  const precip = new Array(n).fill(0);
  for (let i = 2; i < 6; i++) precip[i] = 0.125; // half an inch
  const cond = {
    precip,
    rh: new Array(n).fill(55),
    cloud: new Array(n).fill(20),
    wind: new Array(n).fill(8),
    temp: new Array(n).fill(72),
    isDay: Array.from({ length: n }, (_, i) => i % 24 >= 6 && i % 24 < 20),
  };
  const clay = saturationSeries(cond, SOIL.clay);
  const sand = saturationSeries(cond, SOIL.sand);
  assert.ok(sand.at(-1) < clay.at(-1), `sand ${sand.at(-1)} should be drier than clay ${clay.at(-1)}`);

  const clears = (series) => series.findIndex((v, i) => i > 6 && v <= 0.55);
  assert.ok(clears(sand) < clears(clay), 'sand should become workable sooner');
});

test('the ground stays unworkable for days, not hours, after a soaking', () => {
  const n = 120;
  const precip = new Array(n).fill(0);
  for (let i = 2; i < 10; i++) precip[i] = 0.15; // 1.2 inches
  const series = saturationSeries({
    precip,
    rh: new Array(n).fill(60),
    cloud: new Array(n).fill(25),
    wind: new Array(n).fill(7),
    temp: new Array(n).fill(70),
    isDay: Array.from({ length: n }, (_, i) => i % 24 >= 6 && i % 24 < 20),
  }, SOIL.loam);

  const clearIdx = series.findIndex((v, i) => i > 10 && v <= SOIL.loam.workLimit);
  assert.ok(clearIdx > 24, `should take more than a day to drain, cleared at hour ${clearIdx}`);
  assert.ok(clearIdx < 120, 'but it should drain eventually');
});

test('frozen ground barely drains', () => {
  const mk = (temp) => saturationSeries({
    precip: [0.5, 0, 0, 0, 0, 0, 0, 0],
    rh: new Array(8).fill(70),
    cloud: new Array(8).fill(30),
    wind: new Array(8).fill(8),
    temp: new Array(8).fill(temp),
    isDay: new Array(8).fill(true),
  }, SOIL.loam).at(-1);
  assert.ok(mk(30) > mk(60), 'frozen ground should hold water');
});

test('a two-day stretch outranks a single better day', () => {
  const mk = (day, hours, score) => ({ day, workableHours: hours, score });
  const stretches = findStretches([
    mk('2026-08-10', 8, 88),  // lone excellent day
    mk('2026-08-11', 0, 0),
    mk('2026-08-12', 7, 78),  // two decent days in a row
    mk('2026-08-13', 7, 79),
  ]);
  assert.equal(stretches[0].length, 2, 'the pair should win');
  assert.equal(stretches[0].start.day, '2026-08-12');
});

test('a day is rated on its usable block, not its best single hour', () => {
  const hs = [95, 20, 20, 20, 20, 20].map((score, i) => ({ score, index: i, hour: 7 + i }));
  const runs = findRuns(hs);
  assert.equal(runs[0].length, 1);
  // One brilliant hour is not a work day.
  const dayScore = Math.round(runs[0].mean * Math.min(1, runs[0].length / 6));
  assert.ok(dayScore < 20, `one hour should not read as a good day, got ${dayScore}`);
});

test('cure risk flags rain and freezing in the 24h after work', () => {
  const mk = (precip, temp) => Array.from({ length: 24 }, () => ({ precip, temp }));
  assert.equal(cureRisk(null, mk(0, 60)).risks.length, 0);
  assert.ok(cureRisk(null, mk(0.02, 60)).risks[0].includes('rain'));
  assert.ok(cureRisk(null, mk(0, 28)).risks.some((r) => r.includes('28')));
});

test('real soil temperature is preferred over air temperature when present', () => {
  const data = makeDemoData(NOW);
  assert.ok(analyze(data, 'loam', NOW).hasSoilTemp, 'demo data provides soil temperature');

  delete data.hourly.soil_temperature_0cm;
  const a = analyze(data, 'loam', NOW);
  assert.equal(a.hasSoilTemp, false);
  assert.ok(a.days.length > 0, 'still works on air temperature alone');
});

test('a normal summer week yields a workable stretch', () => {
  const a = analyze(makeDemoData(NOW), 'loam', NOW);
  assert.ok(a.best, 'should find somewhere to work');
  for (const h of a.best.start.best.hours) {
    assert.equal(h.blockers.length, 0);
    assert.ok(h.hour >= 7 && h.hour < 19, `hour ${h.hour} outside working hours`);
  }
});

test('a week of rain reports no workable stretch rather than inventing one', () => {
  const data = makeDemoData(NOW, { rainAt: { day: 0, from: 0, to: 24, rate: 0.08 } });
  // Soak every day of the forecast.
  data.hourly.precipitation = data.hourly.precipitation.map(() => 0.08);
  const a = analyze(data, 'clay', NOW);
  assert.equal(a.stretches.length, 0);
  assert.equal(a.best, null);
  assert.ok(a.days.every((d) => d.workableHours === 0));
});

test('missing optional columns fall back instead of throwing', () => {
  const data = makeDemoData(NOW);
  delete data.hourly.precipitation_probability;
  delete data.hourly.cloud_cover;
  delete data.hourly.soil_temperature_0cm;
  const a = analyze(data, 'loam', NOW);
  assert.ok(a.hours.every((h) => Number.isFinite(h.score)));
});

test('an empty forecast is reported, not silently rendered', () => {
  assert.throws(() => analyze({ hourly: { time: [] } }, 'loam', NOW), /No hourly data/);
});
