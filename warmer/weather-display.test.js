import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProse, buildAddendum } from './advice-rules.js';
import { temperatureValue, formatAmount } from './weather-display.js';

const base = { tMax: 20, tMin: 18, yMax: 18, diff: 2, feels: 20, wind: 0, maxRain: 0,
  slots: [{ h: 8, temp: 18 }, { h: 13, temp: 20 }, { h: 19, temp: 18 }] };

test('Fahrenheit converts absolute temperature and temperature difference separately', () => {
  const { html } = buildProse({ ...base, temperatureUnit: 'F' });
  assert.match(html, /68°F/);
  assert.match(html, /4°F/);
  assert.doesNotMatch(html, /20°|36°F|°C/);
});

test('Fahrenheit presentation preserves Celsius hazard thresholds', () => {
  const { html } = buildProse({ ...base, feels: 37, temperatureUnit: 'F' });
  assert.match(html, /Dangerous heat/);
  assert.match(html, /99°F/);
  assert.match(buildProse({ ...base, feels: -12, temperatureUnit: 'F' }).html, /10°F/);
});

test('Fahrenheit advisory and model-spread caption never leak Celsius numbers', () => {
  const { html } = buildProse({ ...base, tMax: 22, feels: 29, temperatureUnit: 'F' });
  assert.match(html, /84°F/);
  assert.doesNotMatch(html, /29°/);
  assert.match(buildAddendum({ consensus: 'LOW', maxSpread: 5, temperatureUnit: 'F' }, true), /9°F/);
});

test('missing Fahrenheit chart readings remain missing, never a false 32 degrees', () => {
  assert.ok(!Number.isFinite(temperatureValue(null, 'F')));
  assert.ok(!Number.isFinite(temperatureValue(undefined, 'F')));
});

test('small nonzero precipitation remains visible and missing differs from dry', () => {
  assert.equal(formatAmount(0.02), '<0.1 mm');
  assert.equal(formatAmount(0), '0.0 mm');
  assert.equal(formatAmount(null), '—');
});

test('rain start badge quotes its own hour probability, not a later peak', () => {
  const p = { ...base, nowHour: 16, maxRain: 90,
    rainSeries: [{ hour: 16, rain: 5 }, { hour: 23, rain: 45 }, { hour: 24, rain: 90 }] };
  assert.match(buildProse(p).html, /from 11pm · 45%/);
  assert.doesNotMatch(buildProse(p).html, /11pm · 90%/);
});

test('rain clearing badge states a falling chance instead of pairing a dry hour with peak rain', () => {
  const p = { ...base, nowHour: 20, maxRain: 90,
    rainSeries: [{ hour: 20, rain: 90 }, { hour: 23, rain: 10 }] };
  const { html, action } = buildProse(p);
  assert.match(html, /below 40% from 11pm/);
  assert.doesNotMatch(html, /11pm · 90%/);
  assert.match(action, /less likely around 11pm/);
});

test('after midnight the upcoming morning belongs to this day', () => {
  const { html } = buildProse({ ...base, band: 'NIGHT', todayMorningTemp: 8, tomorrowMorningTemp: 18 });
  assert.match(html, /this morning/);
  assert.doesNotMatch(html, /tomorrow morning/);
});
