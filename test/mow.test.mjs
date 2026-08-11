import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, scoreHour, wetnessSeries, growthOutlook, localNowKey, findWindows, GRASS, STANDARDS } from '../mow.js';
import { makeDemoData } from '../demo-data.js';

// Fixed "now" so every run is deterministic: 2026-08-09 09:00 UTC.
const NOW = Date.UTC(2026, 7, 9, 9, 0, 0);
const week = () => analyze(makeDemoData(NOW), 'cool', NOW);

test('localNowKey applies the location UTC offset', () => {
  assert.equal(localNowKey(0, Date.UTC(2026, 7, 9, 9, 0)), '2026-08-09T09:00');
  // UTC-5 rolls back across midnight.
  assert.equal(localNowKey(-5 * 3600, Date.UTC(2026, 7, 9, 3, 0)), '2026-08-08T22:00');
});

test('night, rain and frost are hard blockers, not penalties', () => {
  const base = { temp: 70, rh: 60, precip: 0, precipProb: 0, wind: 5, cloud: 20, wet: 0.1,
    hour: 14, isDay: true, hoursToSunset: 6, hoursAfterSunrise: 8, rainInNext1h: false, rainInNext2h: false };

  assert.equal(scoreHour({ ...base, isDay: false }, GRASS.cool).score, 0);
  assert.equal(scoreHour({ ...base, precip: 0.05 }, GRASS.cool).score, 0);

  const frost = scoreHour({ ...base, temp: 31 }, GRASS.cool);
  assert.equal(frost.score, 0);
  assert.ok(frost.blockers.includes('frost'));

  const wet = scoreHour({ ...base, wet: 0.8 }, GRASS.cool);
  assert.equal(wet.score, 0);
  assert.ok(wet.blockers.includes('wet grass'));
});

test('a clear, mild, dry afternoon scores well', () => {
  const good = scoreHour({ temp: 72, rh: 45, precip: 0, precipProb: 0, wind: 6, cloud: 25, wet: 0.05,
    hour: 17, isDay: true, hoursToSunset: 3, hoursAfterSunrise: 11, rainInNext1h: false, rainInNext2h: false }, GRASS.cool);
  assert.equal(good.blockers.length, 0);
  assert.ok(good.score >= 85, `expected >=85, got ${good.score}`);
});

test('grass type changes the heat penalty', () => {
  const hot = { temp: 88, rh: 50, precip: 0, precipProb: 0, wind: 5, cloud: 70, wet: 0.05,
    hour: 17, isDay: true, hoursToSunset: 3, hoursAfterSunrise: 11, rainInNext1h: false, rainInNext2h: false };
  const cool = scoreHour(hot, GRASS.cool).score;
  const warm = scoreHour(hot, GRASS.warm).score;
  assert.ok(warm > cool, `warm-season should tolerate 88° better (warm ${warm} vs cool ${cool})`);
});

test('wetness accumulates with rain and dries out over following hours', () => {
  const n = 24;
  const precip = new Array(n).fill(0);
  for (let i = 2; i < 6; i++) precip[i] = 0.1; // 0.4" of rain
  const series = wetnessSeries({
    precip,
    rh: new Array(n).fill(55),
    cloud: new Array(n).fill(10),
    wind: new Array(n).fill(8),
    temp: new Array(n).fill(78),
    isDay: new Array(n).fill(true),
  });

  assert.ok(series[5] > 0.33, 'should be soaked right after the rain');
  assert.ok(series[23] < 0.33, 'should dry out by end of a sunny breezy day');
  // Drying is gradual, not instant — that is the whole point of the model.
  const clearIdx = series.findIndex((w, i) => i > 5 && w <= 0.33);
  assert.ok(clearIdx > 8, `drying should take hours, cleared at index ${clearIdx}`);
});

test('sun and wind dry grass faster than damp still air', () => {
  const mk = (over) => wetnessSeries({
    precip: [0.2, 0, 0, 0, 0, 0],
    rh: new Array(6).fill(over.rh),
    cloud: new Array(6).fill(over.cloud),
    wind: new Array(6).fill(over.wind),
    temp: new Array(6).fill(75),
    isDay: new Array(6).fill(true),
  }).at(-1);

  const fast = mk({ rh: 40, cloud: 5, wind: 14 });
  const slow = mk({ rh: 92, cloud: 95, wind: 1 });
  assert.ok(fast < slow, `sunny/breezy (${fast}) should beat humid/still (${slow})`);
});

test('the morning after a soaking is blocked, and the page can say when it clears', () => {
  // Rain all afternoon on the day after "today".
  const data = makeDemoData(NOW, { rainAt: { day: 4, from: 14, to: 22, rate: 0.12 } });
  const a = analyze(data, 'cool', NOW);

  const rainDay = a.days[1].day; // the day it rained
  const morning = a.hours.filter((h) => h.day > rainDay && h.hour >= 7 && h.hour <= 9)[0];
  assert.ok(morning.blockers.includes('wet grass'), `expected wet grass at ${morning.time}`);

  const laterSameDay = a.hours.find((h) => h.day === morning.day && h.hour === 16);
  assert.ok(laterSameDay.score > 0, 'should be mowable again by late afternoon');
});

test('every window is daylight, mowable, and contiguous', () => {
  const a = week();
  assert.ok(a.windows.length > 0, 'should find at least one window in a week');
  for (const w of a.windows) {
    for (const h of w.hours) {
      assert.ok(h.isDay, `window hour ${h.time} is after dark`);
      assert.equal(h.blockers.length, 0);
      assert.ok(h.score >= 55);
    }
    for (let i = 1; i < w.hours.length; i++) {
      assert.equal(w.hours[i].index, w.hours[i - 1].index + 1, 'window must be contiguous');
    }
  }
});

test('the best window is ranked above the others and is in the future', () => {
  const a = week();
  assert.ok(a.best);
  assert.ok(!a.best.start.past, 'never recommend a time that has already passed');
  for (const w of a.windows) assert.ok(a.best.quality >= w.quality);
});

test('findWindows splits on a gap rather than bridging it', () => {
  const hs = [60, 70, 10, 80, 90].map((score, i) => ({ score, index: i, time: `2026-08-09T0${i}:00` }));
  const w = findWindows(hs);
  assert.equal(w.length, 2);
  assert.deepEqual(w.map((x) => x.hours.length).sort(), [2, 2]);
});

test('a window is rated by its best hours, not the hours it opens with', () => {
  // One long window that starts mediocre and peaks late.
  const hs = [56, 58, 60, 95, 96, 97].map((score, i) => ({ score, index: i, time: `2026-08-09T1${i}:00` }));
  const [w] = findWindows(hs, { decayPerDay: 0 });
  assert.equal(w.peak.start.score, 95);
  assert.ok(w.quality > 90, `should be rated on its peak, got ${w.quality}`);
});

test('sooner beats later when two windows are otherwise equal', () => {
  const mk = (offset) => Array.from({ length: 3 }, (_, i) => ({
    score: 80, index: offset + i, time: `2026-08-09T${String(offset + i).padStart(2, '0')}:00`,
  }));
  // Two identical 3-hour windows, four days apart, separated by a dead hour.
  const hours = [...mk(0), { score: 0, index: 3, time: 'x' }, ...mk(100)];
  const ws = findWindows(hours);
  assert.equal(ws[0].hours[0].index, 0, 'the earlier window should win');
  assert.ok(ws[0].quality > ws[1].quality);
});

test('recency discount does not override a genuinely better day', () => {
  const soonBad = Array.from({ length: 2 }, (_, i) => ({ score: 58, index: i, time: `a${i}` }));
  const laterGood = Array.from({ length: 4 }, (_, i) => ({ score: 96, index: 30 + i, time: `b${i}` }));
  const ws = findWindows([...soonBad, { score: 0, index: 2, time: 'gap' }, ...laterGood]);
  assert.equal(ws[0].hours[0].score, 96, 'a much better day later should still win');
});

test('a damp lawn blocks the fussy standard and not the relaxed one', () => {
  // Between balanced's limit (0.45) and relaxed's (0.80): a damp lawn, not a swamp.
  const damp = { temp: 70, rh: 70, precip: 0, precipProb: 0, wind: 5, cloud: 40, wet: 0.55,
    hour: 14, isDay: true, hoursToSunset: 5, hoursAfterSunrise: 8, rainInNext1h: false, rainInNext2h: false };

  assert.ok(scoreHour(damp, GRASS.cool, STANDARDS.fussy).blockers.includes('wet grass'));
  assert.ok(scoreHour(damp, GRASS.cool, STANDARDS.balanced).blockers.includes('wet grass'));

  const relaxed = scoreHour(damp, GRASS.cool, STANDARDS.relaxed);
  assert.equal(relaxed.blockers.length, 0, 'get-it-done should still cut a damp lawn');
  assert.ok(relaxed.score > 0);
  // It should still say the lawn is damp, just not refuse.
  assert.ok(relaxed.factors.some((f) => f.label === 'damp grass'), 'damp should remain a stated downside');
});

test('genuinely soaked ground stops every standard', () => {
  const soaked = { temp: 70, rh: 95, precip: 0, precipProb: 0, wind: 3, cloud: 90, wet: 1.2,
    hour: 14, isDay: true, hoursToSunset: 5, hoursAfterSunrise: 8, rainInNext1h: false, rainInNext2h: false };
  for (const std of Object.values(STANDARDS)) {
    assert.ok(scoreHour(soaked, GRASS.cool, std).blockers.includes('wet grass'), `${std.key} should refuse a swamp`);
  }
});

test('rain and darkness stop every standard', () => {
  const base = { temp: 70, rh: 60, precip: 0, precipProb: 0, wind: 5, cloud: 30, wet: 0.1,
    hour: 14, isDay: true, hoursToSunset: 5, hoursAfterSunrise: 8, rainInNext1h: false, rainInNext2h: false };
  for (const std of Object.values(STANDARDS)) {
    assert.ok(scoreHour({ ...base, precip: 0.2 }, GRASS.cool, std).blockers.includes('raining'));
    assert.ok(scoreHour({ ...base, isDay: false }, GRASS.cool, std).blockers.includes('dark'));
    assert.ok(scoreHour({ ...base, temp: 30 }, GRASS.cool, std).blockers.includes('frost'));
  }
});

test('relaxed cares less about heat and turf stress than lawn pride', () => {
  const hot = { temp: 92, rh: 40, precip: 0, precipProb: 0, wind: 5, cloud: 10, wet: 0.05,
    hour: 13, isDay: true, hoursToSunset: 7, hoursAfterSunrise: 7, rainInNext1h: false, rainInNext2h: false };
  const relaxed = scoreHour(hot, GRASS.cool, STANDARDS.relaxed).score;
  const balanced = scoreHour(hot, GRASS.cool, STANDARDS.balanced).score;
  const fussy = scoreHour(hot, GRASS.cool, STANDARDS.fussy).score;
  assert.ok(relaxed > balanced && balanced > fussy, `expected relaxed > balanced > fussy, got ${relaxed}/${balanced}/${fussy}`);
});

test('the standards are ordered — relaxed never offers fewer hours than fussy', () => {
  for (const seed of [0, 1, 2, 3]) {
    const data = makeDemoData(NOW, { rainAt: { day: 3 + seed, from: 10, to: 16, rate: 0.06 } });
    const count = (key) => analyze(data, 'cool', NOW, key)
      .days.reduce((n, d) => n + d.hours.filter((h) => h.score > 0).length, 0);
    const [relaxed, balanced, fussy] = ['relaxed', 'balanced', 'fussy'].map(count);
    assert.ok(relaxed >= balanced, `seed ${seed}: relaxed ${relaxed} < balanced ${balanced}`);
    assert.ok(balanced >= fussy, `seed ${seed}: balanced ${balanced} < fussy ${fussy}`);
  }
});

test('an unknown standard falls back to balanced', () => {
  const a = analyze(makeDemoData(NOW), 'cool', NOW, 'nonsense');
  assert.equal(a.standard.key, 'balanced');
});

test('the chosen standard is reported so the page can name it', () => {
  assert.equal(analyze(makeDemoData(NOW), 'cool', NOW, 'relaxed').standard.label, 'Get it done');
});

test('growth outlook responds to heat and moisture', () => {
  const mkDaily = (max, min, rain) => ({
    time: Array.from({ length: 10 }, (_, i) => `2026-08-0${i}`),
    temperature_2m_max: new Array(10).fill(max),
    temperature_2m_min: new Array(10).fill(min),
    precipitation_sum: new Array(10).fill(rain),
    pastDays: 3,
  });

  assert.equal(growthOutlook(mkDaily(88, 68, 0.2), GRASS.cool).label, 'Fast');
  assert.equal(growthOutlook(mkDaily(45, 33, 0), GRASS.cool).label, 'Barely growing');

  // Same heat, no water — growth should be damped, not ignored.
  const wet = growthOutlook(mkDaily(85, 65, 0.3), GRASS.cool).index;
  const dry = growthOutlook(mkDaily(85, 65, 0), GRASS.cool).index;
  assert.ok(dry < wet, 'drought should slow growth');
});

test('missing optional columns fall back instead of throwing', () => {
  const data = makeDemoData(NOW);
  delete data.hourly.precipitation_probability;
  delete data.hourly.cloud_cover;
  delete data.daily.sunrise;
  const a = analyze(data, 'cool', NOW);
  assert.ok(a.days.length > 0);
  assert.ok(a.hours.every((h) => Number.isFinite(h.score)));
});

test('an empty forecast is reported, not silently rendered', () => {
  assert.throws(() => analyze({ hourly: { time: [] } }, 'cool', NOW), /No hourly data/);
});
