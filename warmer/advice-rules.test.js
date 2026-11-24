import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertForConditions, bandForTemp, bandViolations, buildProse, decideDay, pillDetailHTML,
  assertNotSelfEvident, coldWordingAccurate, buildAddendum, cardSentence,
} from './advice-rules.js';

// A day with no hourly series unless a test gives one. nowHour anchors rain
// timing; band defaults to DAY.
function baseP({ feels = 18, tMax = 18, diff = 0, evening = 18, maxRain = 0, wind = 0, tCode = 0, nowHour = 10, ...rest } = {}) {
  return { diff, tCode, feels, tMax, nowTemp: rest.nowTemp ?? tMax, maxRain, wind, nowHour, band: 'DAY',
    slots: [{ temp: 0 }, { temp: 0 }, { temp: evening }], temperatureUnit: 'C', ...rest };
}
// Hourly series from nowHour to 23 (inWindow) plus tomorrow to 33.
function series(nowHour, f) {
  return Array.from({ length: 24 }, (_, i) => {
    const hour = nowHour + i;
    return { hour, rain: 0, mm: 0, cm: 0, t: 10, feels: 10, gust: 10, code: 0, uv: 0, inWindow: hour <= 23, ...f(hour) };
  });
}
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const sentence = html => text(html.replace(/<(button|span) [^>]*class="pill[^"]*"[\s\S]*?<span class="pv">[^<]*<\/span>[\s\S]*?<\/(button|span)>/g, ' '));

// ---- temperature wording ----
test('bandForTemp boundaries, with 0–5°C called cold rather than freezing', () => {
  assert.equal(bandForTemp(30).name, 'hot');
  assert.equal(bandForTemp(25).name, 'warm');
  assert.equal(bandForTemp(20).name, 'mild');
  assert.equal(bandForTemp(15).name, 'cool');
  assert.equal(bandForTemp(10).name, 'chilly');
  assert.equal(bandForTemp(5).name, 'cold');
  assert.equal(bandForTemp(4).name, 'nearFreezing');
  assert.equal(bandForTemp(4).adjective, 'cold');
  assert.equal(bandForTemp(-1).name, 'freezing');
});

test('a 36° day that cooled never says chilly or colder; a cool day does', () => {
  for (const diff of [-2, -4, -7]) {
    const html = buildProse(baseP({ feels: 36, tMax: 36, diff, evening: 33 })).html;
    assert.ok(!/chilly|colder/.test(html), html);
  }
  assert.ok(/a bit colder/.test(buildProse(baseP({ feels: 12, tMax: 12, diff: -2, evening: 10 })).html));
  assert.ok(coldWordingAccurate(12) && !coldWordingAccurate(20));
});

test('hot day: no cold or garment words in the headline', () => {
  const html = buildProse(baseP({ feels: 33, tMax: 33, diff: 7, evening: 31 })).html;
  assert.deepEqual(bandViolations(33, html), []);
});

test('no 0° pill for "Same as yesterday"', () => {
  const html = buildProse(baseP({ diff: 0 })).html;
  assert.ok(/Same/.test(html) && !/data-pill="change"/.test(html), html);
});

test('a colder headline joins its evening drop with "and", a warmer one with "but"', () => {
  assert.ok(/and <\/span><span class="w">turning/.test(buildProse(baseP({ tMax: 12, feels: 12, diff: -4, evening: 5 })).html));
  assert.ok(/but <\/span><span class="w">turning/.test(buildProse(baseP({ tMax: 12, feels: 12, diff: 4, evening: 5 })).html));
});

test('overnight, a warmer morning is not called a drop', () => {
  const html = buildProse(baseP({ band: 'NIGHT', nowHour: 3, tMax: 21, nowTemp: 9, feels: 9, diff: -1, todayMorningTemp: 12 })).html;
  assert.ok(!/turning chilly this morning/.test(html), html);
});

// ---- C4: numbers in pills, not sentences ----
test('feels-like advice carries its number in a pill, not in the sentence', () => {
  const html = buildProse(baseP({ tMax: 6, nowTemp: 6, feels: 0, diff: 0 })).html;
  assert.ok(!/\d/.test(sentence(html).replace(/yesterday/g, '')), sentence(html));
  assert.ok(/data-pill="feels"/.test(html));
});

// ---- precipitation (C1, C2) ----
test('rain starting later: headline says what and when, action says what to do', () => {
  const p = baseP({ nowHour: 8, rainSeries: series(8, h => (h === 16 ? { rain: 70, mm: 1 } : {})) });
  const { html } = buildProse(p);
  assert.ok(/Rain .*from 4pm/.test(text(html)), html);
  assert.ok(/Take an umbrella\./.test(html));
  assert.equal(cardSentence(p), 'Rain from 4pm — take an umbrella.');
});

test('a chance with no measurable amount, or below 40%, is not a rain event', () => {
  assert.ok(!/Rain|Drizzle/.test(buildProse(baseP({ nowHour: 10, rainSeries: series(10, () => ({ rain: 80, mm: 0 })) })).html));
  assert.ok(!/Rain|Drizzle/.test(buildProse(baseP({ nowHour: 10, rainSeries: series(10, () => ({ rain: 35, mm: 1 })) })).html));
});

test('C2: strength words describe the first hours; a heavier spell later gets its own time', () => {
  const p = baseP({ nowHour: 9, rainSeries: series(9, h => ({ rain: 90, mm: h >= 20 ? 4 : 0.6 })) });
  const html = buildProse(p).html;
  assert.ok(/>Rain <\/span>/.test(html) && !/Heavy rain/.test(html), html);
  assert.ok(/heavier around 8pm/.test(html), html);
});

test('C1: snow is called snow, and settling snow shows its amount', () => {
  const p = baseP({ tMax: -1, nowTemp: -1, feels: -5, nowHour: 18, band: 'EVENING',
    rainSeries: series(18, () => ({ rain: 95, mm: 1, cm: 0.8, t: -1 })), ahead: { snowCm: 0 } });
  const { html } = buildProse(p);
  assert.ok(/Snow/.test(html) && !/>Rain </.test(html), html);
  assert.ok(/data-pill="snow"[\s\S]*?\d+cm/.test(html), html);
  assert.ok(/settle/.test(html));
  assert.match(pillDetailHTML('snow', p).html, /pd-scale/);
});

test('C1: rain mixed with snow says both', () => {
  const p = baseP({ tMax: 1, nowTemp: 1, feels: -2, nowHour: 10, rainSeries: series(10, h => ({ rain: 90, mm: 1, cm: h % 3 ? 0 : 0.7, t: 1 })) });
  assert.ok(/and snow/.test(buildProse(p).html));
});

test('daytime rain from tomorrow says dry today', () => {
  const p = baseP({ nowHour: 16, rainSeries: series(16, h => (h >= 28 ? { rain: 80, mm: 1 } : {})) });
  assert.ok(/Dry today\. Pack an umbrella for tomorrow\./.test(buildProse(p).html));
  assert.equal(cardSentence(p), 'Dry today, umbrella tomorrow.');
});

// ---- alerts (C5) ----
test('heat, freeze and wind alerts fire at their thresholds and show the proving number', () => {
  assert.equal(alertForConditions(baseP({ feels: 36 }))?.kind, 'heat');
  assert.equal(alertForConditions(baseP({ feels: 35 })), null);
  assert.equal(alertForConditions(baseP({ feels: -10 }))?.kind, 'freeze');
  assert.equal(alertForConditions(baseP({ feels: -9 })), null);
  assert.equal(alertForConditions(baseP({ wind: 60 }))?.kind, 'wind');
  assert.equal(alertForConditions(baseP({ wind: 59 })), null);
  assert.match(buildProse(baseP({ feels: -12 })).html, /pill-warn[\s\S]*?-12°C/);
});

test('alerts read the hours ahead: tonight\'s hard freeze is announced this afternoon', () => {
  const a = alertForConditions(baseP({ feels: 2, nowHour: 15, ahead: { feelsMin: { value: -12, hour: 22 } } }));
  assert.equal(a.kind, 'freeze');
  assert.match(a.headline, /tonight/);
});

test('ice: rain near 0°C warns of ice, shows the air temperature and names what falls', () => {
  const p = baseP({ tMax: 1, nowTemp: 1, feels: -2, nowHour: 10, ahead: { tLow: 0 }, rainSeries: series(10, () => ({ rain: 80, mm: 0.6, t: 0.5 })) });
  const { html } = buildProse(p);
  assert.match(html, /Icy surfaces/);
  assert.match(html, /data-pill="warn:ice"[\s\S]*?0°C/);
  assert.match(pillDetailHTML('warn:ice', p).html, /Rain · 80%/);
});

test('thunder ahead becomes a storm alert with its start time', () => {
  const p = baseP({ nowHour: 10, ahead: { thunder: { hour: 15, chance: 70 } } });
  const { html } = buildProse(p);
  assert.match(html, /Thunderstorms possible from 3pm/);
  assert.match(html, /data-pill="warn:storm"[\s\S]*?3pm/);
});

// ---- heads-up notes (C6, C7) ----
test('UV, air quality, pollen and gusts come with a pill that opens a low-to-high scale', () => {
  const p = baseP({ uvIndex: 9, europeanAqi: 85, pollenSpecies: { grass: 120 }, gust: 52, ahead: { uvMax: { value: 9, hour: 13 }, gustMax: { value: 52, hour: 15 } } });
  const { html } = buildProse(p);
  for (const key of ['uv', 'aqi', 'pollen', 'wind']) {
    assert.match(html, new RegExp(`data-pill="${key}"`), key);
    assert.match(pillDetailHTML(key, p).html, /pd-scale/, key);
  }
});

test('the action line holds at most two sentences; other must-mention items become pills', () => {
  const p = baseP({ uvIndex: 9, europeanAqi: 85, pollenSpecies: { grass: 120 }, ahead: { uvMax: { value: 9, hour: 13 } } });
  const d = decideDay(p);
  assert.ok(d.action && d.more);
  assert.equal((d.pills.match(/data-pill=/g) || []).length, 3);
});

test('a big swing gives a layer note only when the cool end is cool', () => {
  const cool = baseP({ nowHour: 9, tMax: 22, rainSeries: series(9, h => ({ t: h <= 14 ? 10 + h - 9 : 22 - (h - 14) * 1.5 })), ahead: { swing: 12 } });
  assert.match(buildProse(cool).html, /layer/);
  const tropical = baseP({ nowHour: 2, band: 'NIGHT', tMax: 31, nowTemp: 22, feels: 25, rainSeries: series(2, h => ({ t: 22 + Math.min(9, h - 2), inWindow: h <= 11 })), ahead: { swing: 10 } });
  assert.ok(!/layer/.test(buildProse(tropical).html));
});

test('C6: the action line never repeats the headline', () => {
  const p = baseP({ nowHour: 9, rainSeries: series(9, () => ({ rain: 95, mm: 4 })) });
  const d = decideDay(p);
  assert.ok(/Heavy rain/.test(d.lines[0]) && !/[Hh]eavy rain/.test(d.action), d.action);
});

// ---- card (C3) ----
test('the card repeats the day screen\'s lead in a few words', () => {
  assert.equal(cardSentence(baseP({ tMax: 12, feels: 10, diff: -4 })), 'Colder than yesterday — layer up.');
  assert.equal(cardSentence(baseP({ tMax: 26, feels: 27, diff: -2 })), 'A touch cooler than yesterday — T-shirt weather.');
  assert.equal(cardSentence(baseP({ feels: -12 })), 'Hard freeze — bundle up.');
});

test('a warmer but still cold day never tells the card to dress lighter', () => {
  assert.ok(!/lighter/.test(cardSentence(baseP({ tMax: 9, nowTemp: 9, feels: 6, diff: 3 }))));
});

// ---- self-evident gate and caption (kept from v1) ----
test('assertNotSelfEvident rejects empty text and banned phrases', () => {
  assert.throws(() => assertNotSelfEvident(''));
  assert.throws(() => assertNotSelfEvident('Stay hydrated today.'));
  assert.doesNotThrow(() => assertNotSelfEvident('Sunscreen and a hat today — skin burns fast at midday.'));
});

test('every action and card sentence across many inputs passes the self-evident gate', () => {
  const ps = [baseP(), baseP({ feels: 33, ahead: { feelsMax: { value: 33, hour: 14 } } }), baseP({ feels: -6, ahead: { feelsMin: { value: -6, hour: 22 } } }),
    baseP({ europeanAqi: 70 }), baseP({ uvIndex: 8 }), baseP({ feels: 37 }), baseP({ wind: 65 })];
  for (const p of ps) {
    const d = decideDay(p);
    for (const s of [d.action, d.more, d.card].filter(Boolean)) assert.doesNotThrow(() => assertNotSelfEvident(s), s);
  }
});

test('buildAddendum: the LOW caption needs an action line', () => {
  assert.equal(buildAddendum({ consensus: 'LOW', maxSpread: 5, temperatureUnit: 'C' }, false), '');
  assert.match(buildAddendum({ consensus: 'LOW', maxSpread: 5, temperatureUnit: 'C' }, true), /forecasts disagree/);
});
