import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, parse, parseAirQuality, avgRainHourly, getBandWindow } from './weather-data.js';
import { buildProse } from './advice-rules.js';

function forecast(timezone = 'America/New_York', offset = -18000) {
  const start = Date.parse('2026-11-04T00:00:00Z') / 1000;
  const time = Array.from({ length: 96 }, (_, i) => start + i * 3600);
  const hourly = { time };
  const daily = { time: [4, 5, 6].map(day => Date.UTC(2026, 10, day) / 1000 - offset) };
  for (const m of MODELS) {
    for (const [key, value] of Object.entries({ temperature_2m: 20, apparent_temperature: 20,
      precipitation_probability: 10, precipitation: 0, weathercode: 0, windspeed_10m: 5,
      wind_gusts_10m: 8, dew_point_2m: 12, relative_humidity_2m: 60, uv_index: 0 })) {
      hourly[`${key}_${m.id}`] = time.map(() => value);
    }
    daily[`temperature_2m_max_${m.id}`] = [20, 20, 20];
    daily[`temperature_2m_min_${m.id}`] = [20, 20, 20];
    daily[`weathercode_${m.id}`] = [0, 0, 0];
  }
  return { latitude: 40.71, longitude: -74.01, timezone, utc_offset_seconds: offset,
    hourly_units: { time: 'unixtime' }, daily_units: { time: 'unixtime' }, hourly, daily };
}

test('New York uses city hour and floors the current interval after half past', () => {
  const data = forecast();
  const p = parse(data, null, new Date('2026-11-05T21:40:00Z'));
  assert.equal(p.nowHour, 16);
  assert.equal(p.timeZone, 'America/New_York');
  assert.equal(p.hourlyByModel[0].hourly[0].time, Date.parse('2026-11-05T21:00Z') / 1000);
});

test('Kathmandu half-hour/quarter-hour offsets select the actual local hourly interval', () => {
  const data = forecast('Asia/Kathmandu', 20700);
  data.hourly.time = data.hourly.time.map(t => t - 20700);
  const p = parse(data, null, new Date('2026-11-05T13:55:00Z'));
  assert.equal(p.nowHour, 19);
  assert.equal(p.hourlyByModel[0].hourly[0].time, Date.parse('2026-11-05T13:15Z') / 1000);
});

test('rain prose and chart share the same available-model mean and interval start', () => {
  const data = forecast();
  // 00:00 API value describes 23:00–00:00, not rain starting at midnight.
  const idx = data.hourly.time.indexOf(Date.parse('2026-11-06T05:00Z') / 1000);
  MODELS.forEach((m, i) => {
    data.hourly[`precipitation_probability_${m.id}`][idx] = i === 0 ? 20 : 65;
    data.hourly[`precipitation_${m.id}`][idx] = i === 0 ? 0.1 : 0.4;
  });
  const p = parse(data, null, new Date('2026-11-05T21:40Z'));
  const chart = avgRainHourly(p.hourlyByModel);
  assert.equal(p.maxRain, 50);
  assert.equal(p.rainSeries.find(x => x.hour === 23).rain, 50);
  assert.equal(chart[7].r, 50);
  assert.ok(Math.abs(chart[7].mm - 0.3) < 1e-9);
  assert.match(buildProse(p).action, /Rain's possible from around 11pm/);
});

test('rain fields have independent denominators; missing readings never become dry weather', () => {
  const input = [
    { hourly: [{ r: null, mm: 0.3 }] },
    { hourly: [{ r: 90, mm: null }] },
    { hourly: [{ r: 60, mm: 0.9 }] },
  ];
  const [point, missing] = avgRainHourly(input);
  assert.equal(point.r, 75);
  assert.equal(point.mm, 0.6);
  assert.equal(point.rCount, 2);
  assert.equal(point.mmCount, 2);
  assert.equal(missing.r, null);
  assert.equal(missing.mm, null);
});

test('no precipitation probabilities stay unavailable instead of a false zero', () => {
  const data = forecast();
  MODELS.forEach(m => data.hourly[`precipitation_probability_${m.id}`].fill(null));
  const p = parse(data, null, new Date('2026-11-05T21:40Z'));
  assert.equal(p.maxRain, null);
  assert.ok(p.rainSeries.every(x => x.rain === null));
  assert.doesNotMatch(buildProse(p).html, /Rain |Rain's/);
});

test('night and evening windows include the upcoming early morning without a hidden gap', () => {
  assert.ok(getBandWindow('NIGHT', 2).some(x => x.dayOffset === 0 && x.hour === 6));
  assert.ok(getBandWindow('EVENING', 23).some(x => x.dayOffset === 1 && x.hour === 1));
  assert.ok(getBandWindow('MORNING', 10).every(x => x.hour >= 10));
});

test('air quality uses matching epoch interval, not a rounded device-local index', () => {
  const data = { hourly: { time: [1793912400, 1793916000], uv_index: [3, 7] } };
  assert.equal(parseAirQuality(data, new Date(1793912400 * 1000 + 40 * 60000)).uvIndex, 3);
});

test('expired hourly data reports an error instead of displaying fabricated temperatures', () => {
  assert.throws(() => parse(forecast(), null, new Date('2026-12-01T12:00Z')), /hourly|forecast/i);
});

test('DST fallback keeps both repeated hours as different forecast instants', () => {
  const data = forecast();
  const shift = 4 * 24 * 3600;
  data.hourly.time = data.hourly.time.map(t => t - shift);
  data.daily.time = data.daily.time.map(t => t - shift);
  const p = parse(data, null, new Date('2026-11-01T05:30Z'));
  const hours = p.hourlyByModel[0].hourly;
  assert.equal(p.nowHour, 1);
  assert.equal(hours[1].time - hours[0].time, 3600);
  assert.equal(hours[0].hour, 1);
  assert.equal(hours[1].hour, 1);
});

test('missing current primary temperature uses a model with a real current reading', () => {
  const data = forecast();
  const idx = data.hourly.time.indexOf(Date.parse('2026-11-05T21:00Z') / 1000);
  data.hourly.temperature_2m_ecmwf_ifs025[idx] = null;
  data.hourly.apparent_temperature_ecmwf_ifs025[idx] = null;
  const p = parse(data, null, new Date('2026-11-05T21:40Z'));
  assert.equal(p.primaryModel, 'icon_seamless');
  assert.equal(p.feels, 20);
  assert.doesNotMatch(buildProse(p).html, /wind chill/);
});
