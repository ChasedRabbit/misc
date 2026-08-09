// demo-data.js — synthetic but realistic week, shaped exactly like an
// Open-Meteo response. Used by ?demo=1 and by the tests, so the page and the
// engine can both be exercised with no network.

const pad = (n) => String(n).padStart(2, '0');
const iso = (d, h) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(h)}:00`;
const dstr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/**
 * @param {number} nowMs   pretend "now"
 * @param {object} opts    pastDays / forecastDays / rain schedule overrides
 */
export function makeDemoData(nowMs = Date.now(), opts = {}) {
  const pastDays = opts.pastDays ?? 3;
  const forecastDays = opts.forecastDays ?? 8;
  const totalDays = pastDays + forecastDays;

  // Rain: a soaking front the evening of relative day +1, clearing overnight.
  const rainAt = opts.rainAt ?? { day: pastDays + 1, from: 15, to: 21, rate: 0.09 };
  const frostAt = opts.frostAt ?? null; // e.g. { day, from, to }

  const start = new Date(nowMs);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - pastDays);

  const time = [];
  const temperature_2m = [];
  const relative_humidity_2m = [];
  const precipitation = [];
  const precipitation_probability = [];
  const wind_speed_10m = [];
  const cloud_cover = [];
  const is_day = [];
  // Ground temperature lags and damps the air temperature. The mowing tool
  // ignores this column; the retaining-wall tool uses it for frozen ground.
  const soil_temperature_0cm = [];

  const daily = {
    time: [],
    sunrise: [],
    sunset: [],
    temperature_2m_max: [],
    temperature_2m_min: [],
    precipitation_sum: [],
  };

  const SUNRISE = 6;
  const SUNSET = 20;

  for (let d = 0; d < totalDays; d++) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + d);
    const key = dstr(date);

    const baseHigh = (opts.high ?? 84) + Math.sin(d * 0.7) * 4;
    const baseLow = (opts.low ?? 63) + Math.sin(d * 0.7) * 3;
    let daySum = 0;

    for (let h = 0; h < 24; h++) {
      // Diurnal curve: coolest at sunrise, peak around 16:00.
      const phase = Math.cos(((h - 16) / 24) * 2 * Math.PI);
      let t = baseLow + (baseHigh - baseLow) * (phase * 0.5 + 0.5);

      const raining = d === rainAt.day && h >= rainAt.from && h < rainAt.to;
      const frosty = frostAt && d === frostAt.day && h >= frostAt.from && h < frostAt.to;
      if (frosty) t = 31;

      const p = raining ? rainAt.rate : 0;
      daySum += p;

      // Humidity tracks inversely with temperature, pinned high while raining.
      let rh = clamp(112 - (t - 40) * 1.35, 38, 99);
      if (raining) rh = 97;
      if (h < SUNRISE + 1 || h > SUNSET - 1) rh = Math.min(99, rh + 12);

      let cloud = raining ? 96 : clamp(28 + Math.sin(d * 1.3 + h / 7) * 30, 5, 95);
      if (d === rainAt.day && h >= rainAt.from - 4 && h < rainAt.from) cloud = 85;

      let prob = raining ? 95 : 8;
      if (d === rainAt.day && h >= rainAt.from - 5 && h < rainAt.from) prob = 65;
      if (d === rainAt.day + 1 && h < 6) prob = 30;

      time.push(iso(date, h));
      temperature_2m.push(Math.round(t * 10) / 10);
      relative_humidity_2m.push(Math.round(rh));
      precipitation.push(p);
      precipitation_probability.push(prob);
      wind_speed_10m.push(Math.round((5 + Math.sin(d + h / 5) * 4 + (raining ? 9 : 0)) * 10) / 10);
      cloud_cover.push(Math.round(cloud));
      is_day.push(h >= SUNRISE && h < SUNSET ? 1 : 0);
      // Damped toward the day's mean and shifted a few hours later.
      const dayMean = (baseHigh + baseLow) / 2;
      soil_temperature_0cm.push(Math.round((dayMean + (t - dayMean) * 0.45) * 10) / 10);
    }

    daily.time.push(key);
    daily.sunrise.push(`${key}T0${SUNRISE}:12`);
    daily.sunset.push(`${key}T${SUNSET}:04`);
    daily.temperature_2m_max.push(Math.round(baseHigh));
    daily.temperature_2m_min.push(Math.round(baseLow));
    daily.precipitation_sum.push(Math.round(daySum * 100) / 100);
  }

  return {
    latitude: 35.05,
    longitude: -85.31,
    timezone: 'UTC',
    utc_offset_seconds: 0,
    demo: true,
    hourly: {
      time,
      temperature_2m,
      relative_humidity_2m,
      precipitation,
      precipitation_probability,
      wind_speed_10m,
      cloud_cover,
      is_day,
      soil_temperature_0cm,
    },
    daily,
  };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
