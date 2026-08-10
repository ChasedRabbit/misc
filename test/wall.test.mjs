import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze, scoreHour, saturationSeries, saturationFromMeasured, pickMoistureLayer,
  classifySoil, fieldCapacity, hydraulicConductivity, drainRateFromKsat,
  drainRateFromHydGroup, parseSsurgo, siteWarnings,
  heatIndex, findRuns, findStretches, cureRisk, SOIL,
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

test('measured soil moisture maps onto the same scale as the estimate', () => {
  for (const soil of [SOIL.clay, SOIL.loam, SOIL.sand]) {
    // At exactly the soil's workable limit, the scale must read workLimit.
    const [atLimit] = saturationFromMeasured([soil.vwcWork], soil);
    assert.ok(Math.abs(atLimit - soil.workLimit) < 1e-9, `${soil.key}: ${atLimit} vs ${soil.workLimit}`);
    // Drier reads workable, wetter reads blocked.
    assert.ok(saturationFromMeasured([soil.vwcWork * 0.5], soil)[0] < soil.workLimit);
    assert.ok(saturationFromMeasured([soil.vwcWork * 1.4], soil)[0] > soil.workLimit);
  }
});

test('the same wetness is workable on sand and not on clay', () => {
  // 0.30 m³/m³ is past what clay can take but nowhere near sand's limit.
  assert.ok(saturationFromMeasured([0.30], SOIL.sand)[0] > SOIL.sand.workLimit);
  assert.ok(saturationFromMeasured([0.30], SOIL.clay)[0] < SOIL.clay.workLimit);
});

test('the deepest usable moisture layer is chosen, and junk columns are skipped', () => {
  const n = 10;
  const full = (v) => new Array(n).fill(v);
  assert.equal(pickMoistureLayer({ soil_moisture_9_to_27cm: full(0.2), soil_moisture_3_to_9cm: full(0.2) }, n).label, '9–27cm');
  // A model that publishes only the shallow layer.
  assert.equal(pickMoistureLayer({ soil_moisture_3_to_9cm: full(0.2) }, n).label, '3–9cm');
  // Nulls and flat zeros mean the model didn't run it here.
  assert.equal(pickMoistureLayer({ soil_moisture_9_to_27cm: full(null) }, n), null);
  assert.equal(pickMoistureLayer({ soil_moisture_9_to_27cm: full(0) }, n), null);
  assert.equal(pickMoistureLayer({}, n), null);
  // Wrong length is not trusted.
  assert.equal(pickMoistureLayer({ soil_moisture_9_to_27cm: [0.2, 0.2] }, n), null);
});

test('analyze prefers measured soil moisture and reports that it did', () => {
  const a = analyze(makeDemoData(NOW), 'loam', NOW);
  assert.equal(a.moisture.source, 'measured');
  assert.equal(a.moisture.layer, '9–27cm');
});

test('analyze falls back to the estimate when no moisture layer is published', () => {
  const data = makeDemoData(NOW);
  delete data.hourly.soil_moisture_9_to_27cm;
  const a = analyze(data, 'loam', NOW);
  assert.equal(a.moisture.source, 'estimated');
  assert.equal(a.moisture.usedEt0, true, 'should still use reference evapotranspiration');
  assert.ok(a.days.length > 0);
});

test('evapotranspiration dries the ground faster than a still, humid day', () => {
  const n = 48;
  const mk = (et) => saturationSeries({
    precip: [0.4, ...new Array(n - 1).fill(0)],
    rh: new Array(n).fill(60),
    cloud: new Array(n).fill(40),
    wind: new Array(n).fill(8),
    temp: new Array(n).fill(70),
    isDay: new Array(n).fill(true),
    et0: new Array(n).fill(et),
  }, SOIL.loam).at(-1);
  assert.ok(mk(0.02) < mk(0.002), 'higher ET0 should dry the ground faster');
});

test('snow on the ground stops work', () => {
  const data = makeDemoData(NOW);
  data.hourly.snow_depth = data.hourly.snow_depth.map(() => 0.15); // 15cm
  const a = analyze(data, 'loam', NOW);
  assert.ok(a.hours.every((h) => h.blockers.length > 0));
  assert.ok(a.hours.some((h) => h.blockers.includes('snow on the ground')));
  assert.equal(a.best, null);
});

test('field capacity reproduces textbook values for known textures', () => {
  // Published field capacities: sand ~0.10, loam ~0.27, clay ~0.39.
  const sand = fieldCapacity({ sand: 90, clay: 5, organicMatter: 1 });
  const loam = fieldCapacity({ sand: 40, clay: 20, organicMatter: 2.5 });
  const clay = fieldCapacity({ sand: 20, clay: 55, organicMatter: 3 });

  assert.ok(sand > 0.05 && sand < 0.14, `sand field capacity out of range: ${sand}`);
  assert.ok(loam > 0.23 && loam < 0.31, `loam field capacity out of range: ${loam}`);
  assert.ok(clay > 0.35 && clay < 0.47, `clay field capacity out of range: ${clay}`);
  assert.ok(sand < loam && loam < clay, 'should order sand < loam < clay');
});

test('field capacity rises with clay and falls with sand', () => {
  let prev = 0;
  for (const clay of [5, 15, 25, 35, 45, 55]) {
    const fc = fieldCapacity({ clay, sand: 30, organicMatter: 2 });
    assert.ok(fc > prev, `field capacity should rise with clay (${clay}%: ${fc})`);
    prev = fc;
  }
  let last = 1;
  for (const sand of [10, 30, 50, 70, 85]) {
    const fc = fieldCapacity({ clay: 10, sand, organicMatter: 2 });
    assert.ok(fc < last, `field capacity should fall with sand (${sand}%: ${fc})`);
    last = fc;
  }
});

test('organic matter increases water holding', () => {
  const lean = fieldCapacity({ clay: 20, sand: 40, organicMatter: 0.5 });
  const rich = fieldCapacity({ clay: 20, sand: 40, organicMatter: 6 });
  assert.ok(rich > lean, `organic matter should raise field capacity (${lean} -> ${rich})`);
});

test('field capacity rejects impossible inputs instead of inventing a number', () => {
  assert.equal(fieldCapacity({ clay: null, sand: 40 }), null);
  assert.equal(fieldCapacity({ clay: 60, sand: 70 }), null, 'clay + sand over 100%');
  assert.equal(fieldCapacity({ clay: -5, sand: 40 }), null);
  assert.equal(fieldCapacity({ clay: 120, sand: 10 }), null);
  assert.equal(fieldCapacity({}), null);
});

test('two soils that both classify as clay get different thresholds', () => {
  const modest = fieldCapacity({ clay: 36, sand: 30, organicMatter: 2 });
  const heavy = fieldCapacity({ clay: 58, sand: 12, organicMatter: 4 });
  assert.equal(classifySoil({ clay: 36, sand: 30 }), 'clay');
  assert.equal(classifySoil({ clay: 58, sand: 12 }), 'clay');
  assert.ok(heavy - modest > 0.03, `should differ meaningfully, got ${modest} vs ${heavy}`);
});

test('analyze uses measured soil properties when given them', () => {
  const data = makeDemoData(NOW);
  const bucket = analyze(data, 'clay', NOW);
  const measured = analyze(data, 'clay', NOW, { clay: 58, sand: 12, organicMatter: 4 });

  assert.equal(bucket.soilBasis.source, 'typical');
  assert.equal(bucket.soil.vwcWork, SOIL.clay.vwcWork);
  assert.equal(measured.soilBasis.source, 'measured');
  assert.ok(measured.soil.vwcWork > SOIL.clay.vwcWork, 'heavy clay should tolerate more water');

  // A higher threshold means more hours clear it.
  const count = (a) => a.days.reduce((n, d) => n + d.workableHours, 0);
  assert.ok(count(measured) >= count(bucket));
});

test('analyze ignores unusable measured properties and falls back to the bucket', () => {
  const a = analyze(makeDemoData(NOW), 'loam', NOW, { clay: 80, sand: 80 });
  assert.equal(a.soilBasis.source, 'typical');
  assert.equal(a.soil.vwcWork, SOIL.loam.vwcWork);
});

test('hydraulic conductivity lands near published values and orders correctly', () => {
  const sand = hydraulicConductivity({ sand: 90, clay: 5, organicMatter: 1 });
  const loam = hydraulicConductivity({ sand: 40, clay: 20, organicMatter: 2.5 });
  const clay = hydraulicConductivity({ sand: 20, clay: 55, organicMatter: 3 });

  // Loam is documented around 13 mm/hr; sand is an order of magnitude faster.
  assert.ok(loam > 8 && loam < 30, `loam Ksat out of range: ${loam}`);
  assert.ok(sand > loam * 3, `sand should shed water far faster (${sand} vs ${loam})`);
  assert.ok(clay < loam, `clay should be slower than loam (${clay} vs ${loam})`);
  assert.equal(hydraulicConductivity({ clay: 60, sand: 70 }), null, 'impossible texture');
});

test('drain rate keeps loam at about 1.0, matching the old scale', () => {
  const loam = drainRateFromKsat(hydraulicConductivity({ sand: 40, clay: 20, organicMatter: 2.5 }));
  assert.ok(Math.abs(loam - 1) < 0.35, `loam should stay near 1.0, got ${loam}`);
  assert.ok(drainRateFromKsat(hydraulicConductivity({ sand: 90, clay: 5 })) > loam);
  assert.equal(drainRateFromKsat(null), null);
});

test('hydrologic soil group maps to drainage, and dual groups take the wet half', () => {
  assert.ok(drainRateFromHydGroup('A') > drainRateFromHydGroup('B'));
  assert.ok(drainRateFromHydGroup('B') > drainRateFromHydGroup('C'));
  assert.ok(drainRateFromHydGroup('C') > drainRateFromHydGroup('D'));
  // A/D only drains like A once someone has tiled it; assume nobody has.
  assert.ok(drainRateFromHydGroup('A/D') < drainRateFromHydGroup('C'));
  assert.equal(drainRateFromHydGroup('nonsense'), null);
  assert.equal(drainRateFromHydGroup(null), null);
});

test('SSURGO results parse into the facts that change how you build', () => {
  const table = [
    ['muname', 'drclassdcd', 'hydgrpdcd', 'brockdepmin', 'wtdepannmin', 'flodfreqdcd'],
    ['Sequatchie loam, 2 to 5 percent slopes', 'Well drained', 'B', 200, 152, 'None'],
  ];
  const s = parseSsurgo(table);
  assert.equal(s.series, 'Sequatchie loam, 2 to 5 percent slopes');
  assert.equal(s.drainageClass, 'Well drained');
  assert.equal(s.hydGroup, 'B');
  assert.equal(s.drainRate, drainRateFromHydGroup('B'));
  assert.equal(s.bedrockCm, 200);

  assert.equal(parseSsurgo(null), null);
  assert.equal(parseSsurgo([['muname']]), null, 'headers with no rows');
  assert.equal(parseSsurgo([]), null);

  // Missing and empty columns become null rather than NaN or "".
  const sparse = parseSsurgo([['muname', 'wtdepannmin'], ['Something silty', '']]);
  assert.equal(sparse.waterTableCm, null);
  assert.equal(sparse.hydGroup, null);
  assert.equal(sparse.drainRate, null);
});

test('site warnings fire on shallow water table, bedrock, poor drainage and flooding', () => {
  const w = siteWarnings({ waterTableCm: 46, bedrockCm: 51, drainageClass: 'Somewhat poorly drained', floodFrequency: 'Occasional' });
  assert.equal(w.length, 4);
  assert.ok(w[0].includes('18"'), `should convert 46cm to inches: ${w[0]}`);
  assert.ok(w[1].includes('20"'));
  assert.ok(/drainage stone/i.test(w[0]), 'water table warning should say what to do about it');

  // A deep, well-drained, unflooded site has nothing to warn about.
  assert.deepEqual(siteWarnings({ waterTableCm: 200, bedrockCm: 300, drainageClass: 'Well drained', floodFrequency: 'None' }), []);
  assert.deepEqual(siteWarnings(null), []);
  assert.deepEqual(siteWarnings({}), []);
});

test('analyze prefers survey drainage, then texture, then the bucket', () => {
  const data = makeDemoData(NOW);
  const texture = { clay: 55, sand: 14, organicMatter: 2.4 };

  const plain = analyze(data, 'clay', NOW);
  assert.equal(plain.soilBasis.drainRate, SOIL.clay.drainRate);

  const fromTexture = analyze(data, 'clay', NOW, texture);
  assert.equal(fromTexture.soilBasis.drainFrom, 'texture');

  assert.equal(fromTexture.soilBasis.fcFrom, 'texture');

  // Drainage without texture must not be reported as a measured threshold.
  const drainageOnly = analyze(data, 'clay', NOW, { drainRate: drainRateFromHydGroup('C'), drainageClass: 'Somewhat poorly drained' });
  assert.equal(drainageOnly.soilBasis.drainFrom, 'survey');
  assert.equal(drainageOnly.soilBasis.fcFrom, 'typical');
  assert.equal(drainageOnly.soil.vwcWork, SOIL.clay.vwcWork);

  const fromSurvey = analyze(data, 'clay', NOW, { ...texture, drainRate: drainRateFromHydGroup('D'), drainageClass: 'Poorly drained' });
  assert.equal(fromSurvey.soilBasis.drainFrom, 'survey');
  assert.equal(fromSurvey.soilBasis.drainRate, drainRateFromHydGroup('D'));
  assert.equal(fromSurvey.soilBasis.drainageClass, 'Poorly drained');
  assert.ok(fromSurvey.siteWarnings.length > 0);
});

test('soil classification follows the texture triangle', () => {
  assert.equal(classifySoil({ clay: 42, sand: 20 }), 'clay');
  assert.equal(classifySoil({ clay: 8, sand: 82 }), 'sand');
  assert.equal(classifySoil({ clay: 18, sand: 40 }), 'loam');
  // High sand but also high clay is a sandy clay, which behaves like clay.
  assert.equal(classifySoil({ clay: 36, sand: 72 }), 'clay');
  assert.equal(classifySoil({ clay: null, sand: 20 }), null);
  assert.equal(classifySoil({}), null);
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
