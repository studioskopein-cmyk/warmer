import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertForConditions, bandForTemp, bandViolations, buildProse, TEMP_BANDS,
  COEFFICIENTS, scoreCandidates, selectCandidate,
} from './advice-rules.js';

function slotsFor(eveningTemp) {
  return [{ temp: 0, rain: 0 }, { temp: 0, rain: 0 }, { temp: eveningTemp, rain: 0 }];
}

function baseP({ feels, tMax, diff, evening, maxRain = 0, wind = 0, tCode = 0, uvIndex = null, humidity = null, ...rest }) {
  return { diff, tCode, feels, tMax, maxRain, wind, slots: slotsFor(evening), uvIndex, humidity, ...rest };
}

test('bandForTemp matches the spec boundaries', () => {
  assert.equal(bandForTemp(30).name, 'hot');
  assert.equal(bandForTemp(29.9).name, 'warm');
  assert.equal(bandForTemp(25).name, 'warm');
  assert.equal(bandForTemp(20).name, 'mild');
  assert.equal(bandForTemp(15).name, 'cool');
  assert.equal(bandForTemp(10).name, 'chilly');
  assert.equal(bandForTemp(5).name, 'cold');
  assert.equal(bandForTemp(4.9).name, 'freezing');
});

test('hot day + hot evening: no chilly/cold/coat/jacket, even with a big positive delta', () => {
  const p = baseP({ feels: 37, tMax: 37, diff: 7, evening: 32 });
  const html = buildProse(p);
  assert.deepEqual(bandViolations(37, html), []);
  assert.deepEqual(bandViolations(32, html), []);
  const lower = html.toLowerCase();
  for (const word of ['chilly', 'cold', 'coat', 'jacket']) {
    assert.ok(!lower.includes(word), `unexpected "${word}" in: ${html}`);
  }
});

test('30C+ never says "short sleeves" (self-evident advice is omitted)', () => {
  for (const feels of [30, 32, 35, 40]) {
    for (const diff of [-5, 0, 5]) {
      const html = buildProse(baseP({ feels, tMax: feels, diff, evening: feels - 1 }));
      assert.ok(!html.toLowerCase().includes('short sleeves'), `unexpected "short sleeves" in: ${html}`);
    }
  }
});

// ---- Score pipeline: temperature is structurally excluded, not filtered ----

test('temperature alone never produces an action line, at any temperature (coefficient verification)', () => {
  // Stays clear of the P1 alert band (feels>=36 / <=-10) so this exercises
  // the score pipeline itself, not the separate safety-override path.
  for (const feels of [-9, -5, 0, 5, 10, 15, 20, 25, 28, 30, 33, 35]) {
    const html = buildProse(baseP({ feels, tMax: feels, diff: 0, evening: feels }));
    assert.ok(!html.includes('class="action"'), `did not expect an action line from temperature alone at ${feels}°: ${html}`);
  }
});

test('cold day alone (no wind/precip/diurnal/other signal) no longer gets an automatic "coat" line — self-evident temperature advice is excluded structurally, not by a banned-word list', () => {
  // evening equals feels (no evening drop) to isolate temperature exclusion
  // from the separate, legitimate diurnalRange signal tested elsewhere.
  const html = buildProse(baseP({ feels: 8, tMax: 8, diff: 5, evening: 8 }));
  assert.ok(!html.includes('class="action"'), `did not expect an action line for cold temperature alone: ${html}`);
});

test('priority formula: temperature always scores zero regardless of salience, because selfSensible=1.0 zeroes (1-selfSensible)', () => {
  assert.equal(COEFFICIENTS.temperature.selfSensible, 1.0);
  const scored = scoreCandidates({
    temperature: 42, uvIndex: null, precipitationTiming: null, pollen: null,
    diurnalRange: null, windGusts: null, airQuality: null, dewPoint: null, apparentTempGap: null,
  });
  assert.equal(scored.find(c => c.key === 'temperature').priority, 0);
});

test('select() ties break toward higher actionability', () => {
  const tie = [
    { key: 'a', priority: 0.5, actionability: 0.6 },
    { key: 'b', priority: 0.5, actionability: 0.9 },
  ];
  assert.equal(selectCandidate(tie).key, 'b');
});

// ---- The reported bug: moderate UV at high temp used to lose to temp ----

test('{ feels: 35, uv: 7.55 }: moderate UV produces UV copy, not the old temp-triggered sun+hydration line (reported bug)', () => {
  // 35, not 37: stays below the P1 heat-alert threshold (feels>=36) so this
  // isolates the score pipeline. UV=7.55 mirrors the exact reported case.
  const html = buildProse(baseP({ feels: 35, tMax: 35, diff: 0, evening: 35, uvIndex: 7.55 }));
  assert.ok(html.includes("UV's fairly strong out — a bit of shade or sunscreen wouldn't hurt."), `expected moderate-UV copy in: ${html}`);
  assert.ok(!html.includes('Avoid direct sun around midday'), `did not expect the old temp-triggered high-UV line at this UV tier: ${html}`);
});

test('{ feels: 22, uv: 9, cloud: 90 }: high UV wins even on a cloudy day — the app\'s killer case', () => {
  const html = buildProse(baseP({ feels: 22, tMax: 22, diff: 0, evening: 22, uvIndex: 9, cloud: 90 }));
  assert.ok(html.includes('Avoid direct sun around midday and into the afternoon, and keep drinking water.'), `expected sun+hydration guidance in: ${html}`);
  const lower = html.toLowerCase();
  assert.ok(!lower.includes('long-sleeve'), `did not expect the mild-band garment line in: ${html}`);
});

test('{ feels: 35, uv: null }: no UV data means no UV copy, and no temperature fallback either — the line is omitted entirely', () => {
  const html = buildProse(baseP({ feels: 35, tMax: 35, diff: 0, evening: 35, uvIndex: null, humidity: null }));
  const lower = html.toLowerCase();
  assert.ok(!lower.includes('uv'), `did not expect any UV wording in: ${html}`);
  assert.ok(!lower.includes('sun'), `did not expect sun-avoidance wording in: ${html}`);
  assert.ok(!html.includes('class="action"'), `did not expect an action line when no signal scores above zero: ${html}`);
});

test('ordinary day across every variable at once produces no action line', () => {
  const p = baseP({ feels: 20, tMax: 20, diff: 1, evening: 19, maxRain: 10, wind: 10, uvIndex: 2, humidity: 50 });
  const html = buildProse(p);
  assert.ok(!html.includes('class="action"'), `did not expect an action line on an unremarkable day: ${html}`);
});

test('action line renders only when a candidate scores above zero — no dangling <br> either way (layout-gap regression guard)', () => {
  const withSignal = buildProse(baseP({ feels: 22, tMax: 22, diff: 0, evening: 22, uvIndex: 9 }));
  assert.ok(withSignal.includes('class="action"'), `expected an action line when UV scores above zero: ${withSignal}`);
  assert.ok(!withSignal.trimEnd().endsWith('<br>'), `did not expect a dangling <br> in: ${withSignal}`);

  const withoutSignal = buildProse(baseP({ feels: 20, tMax: 20, diff: 0, evening: 20 }));
  assert.ok(!withoutSignal.includes('class="action"'), `did not expect an action line with no scoring candidates: ${withoutSignal}`);
  assert.ok(!withoutSignal.trimEnd().endsWith('<br>'), `did not expect a dangling <br> when the action line is omitted: ${withoutSignal}`);
});

test('{ uv: 9, feels: 35 }: high UV alone still produces exactly one action line at high temp (no overlap collapsing needed — temp never contributes)', () => {
  // 35, not 37: same P1-threshold reasoning as above.
  const html = buildProse(baseP({ feels: 35, tMax: 35, diff: 0, evening: 35, uvIndex: 9 }));
  const actionMatches = html.match(/class="action"/g) || [];
  assert.equal(actionMatches.length, 1, `expected exactly one action line in: ${html}`);
  assert.ok(html.includes('Avoid direct sun around midday and into the afternoon, and keep drinking water.'), `expected sun+hydration guidance in: ${html}`);
});

test('{ humidity: 80, uv: 3, feels: 26 }: dew point (derived from temp+humidity) outscores low UV — muggy guidance, not UV', () => {
  const html = buildProse(baseP({ feels: 26, tMax: 26, diff: 0, evening: 26, uvIndex: 3, humidity: 80 }));
  assert.ok(html.includes('Humid enough to feel warmer than it reads — breathable fabric helps.'), `expected dew-point/muggy guidance in: ${html}`);
  const lower = html.toLowerCase();
  assert.ok(!lower.includes('sunscreen'), `did not expect UV wording in: ${html}`);
});

// ---- P1 safety alerts (alertForConditions) — outside the score pipeline ----

test('P1 heat alert: feels=37 produces the dangerous-heat headline with 2+ protective behaviors', () => {
  const p = baseP({ feels: 37, tMax: 37, diff: 0, evening: 37 });
  const alert = alertForConditions(p);
  assert.ok(alert, 'expected a heat alert');
  assert.match(alert.headline, /dangerous heat/i);
  const lower = alert.action.toLowerCase();
  assert.ok(lower.includes('midday') || lower.includes('sun'), `expected a shade/peak-hours behavior in: ${alert.action}`);
  assert.ok(lower.includes('water'), `expected a hydration behavior in: ${alert.action}`);
  const html = buildProse(p);
  assert.ok(html.includes(alert.headline), `expected buildProse to surface the heat headline in: ${html}`);
  assert.ok(html.includes(alert.action), `expected buildProse to surface the heat action in: ${html}`);
});

test('P1 cold alert: feels=-12 produces the hard-freeze headline with 2+ protective behaviors', () => {
  const p = baseP({ feels: -12, tMax: -12, diff: 0, evening: -12 });
  const alert = alertForConditions(p);
  assert.ok(alert, 'expected a cold alert');
  assert.match(alert.headline, /hard freeze/i);
  const lower = alert.action.toLowerCase();
  assert.ok(lower.includes('cover'), `expected a skin-cover behavior in: ${alert.action}`);
  assert.ok(lower.includes('short'), `expected a shorten-time-outside behavior in: ${alert.action}`);
  const html = buildProse(p);
  assert.ok(html.includes(alert.headline), `expected buildProse to surface the cold headline in: ${html}`);
  assert.ok(html.includes(alert.action), `expected buildProse to surface the cold action in: ${html}`);
});

test('P1 wind alert: wind=70 with heavy rain (maxRain=80) suppresses umbrella advice', () => {
  const p = baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, wind: 70, maxRain: 80 });
  const alert = alertForConditions(p);
  assert.ok(alert, 'expected a wind alert');
  assert.match(alert.headline, /strong winds/i);
  const lower = alert.action.toLowerCase();
  assert.ok(!lower.includes('umbrella'), `did not expect umbrella advice in: ${alert.action}`);
  const html = buildProse(p);
  assert.ok(!html.toLowerCase().includes('umbrella'), `did not expect umbrella advice in buildProse output: ${html}`);
});

test('P1 no-alert case: ordinary conditions return null and buildProse falls through to existing logic', () => {
  const p = baseP({ feels: 25, tMax: 25, diff: 0, evening: 25, wind: 10, maxRain: 20 });
  assert.equal(alertForConditions(p), null);
  const html = buildProse(p);
  assert.ok(!html.includes('Dangerous heat'), `did not expect a heat alert headline in: ${html}`);
  assert.ok(!html.includes('hard freeze'), `did not expect a cold alert headline in: ${html}`);
  assert.ok(!html.includes('Strong winds today'), `did not expect a wind alert headline in: ${html}`);
});

test('P1 boundary — heat: feels=36 fires (>=), feels=35 does not', () => {
  assert.notEqual(alertForConditions(baseP({ feels: 36, tMax: 36, diff: 0, evening: 36 })), null);
  assert.equal(alertForConditions(baseP({ feels: 35, tMax: 35, diff: 0, evening: 35 })), null);
});

test('P1 boundary — cold: feels=-10 fires (<=), feels=-9 does not', () => {
  assert.notEqual(alertForConditions(baseP({ feels: -10, tMax: -10, diff: 0, evening: -10 })), null);
  assert.equal(alertForConditions(baseP({ feels: -9, tMax: -9, diff: 0, evening: -9 })), null);
});

test('P1 boundary — wind: wind=60 fires (>=), wind=59 does not', () => {
  assert.notEqual(alertForConditions(baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, wind: 60 })), null);
  assert.equal(alertForConditions(baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, wind: 59 })), null);
});

test('P1 ice alert: near-freezing temp with precipitation overrides the score pipeline entirely, and avoids self-evident "it\'s cold" phrasing', () => {
  const p = baseP({ feels: 2, tMax: 2, diff: 0, evening: 2, precip: true });
  const alert = alertForConditions(p);
  assert.ok(alert, 'expected an ice alert');
  assert.match(alert.headline, /icy/i);
  const lower = alert.action.toLowerCase();
  assert.ok(!lower.includes('cold') && !lower.includes("it's"), `expected concrete surface-hazard wording, not "it's cold": ${alert.action}`);
  assert.ok(lower.includes('road') || lower.includes('step') || lower.includes('bridge'), `expected a surface-specific hazard in: ${alert.action}`);
  const html = buildProse(p);
  assert.ok(html.includes(alert.headline), `expected buildProse to surface the ice headline in: ${html}`);
});

test('P1 boundary — ice: feels=3 with precip fires, feels=4 does not, and no precip signal never fires', () => {
  assert.notEqual(alertForConditions(baseP({ feels: 3, tMax: 3, diff: 0, evening: 3, precip: true })), null);
  assert.equal(alertForConditions(baseP({ feels: 4, tMax: 4, diff: 0, evening: 4, precip: true })), null);
  assert.equal(alertForConditions(baseP({ feels: 2, tMax: 2, diff: 0, evening: 2 })), null);
});

test('P1 storm alert: WMO thunderstorm weathercodes (95-99) override the score pipeline', () => {
  const p = baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, tCode: 95 });
  const alert = alertForConditions(p);
  assert.ok(alert, 'expected a storm alert');
  assert.match(alert.headline, /thunderstorm/i);
  assert.equal(alertForConditions(baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, tCode: 80 })), null, 'rain-shower code (80) should not fire the storm alert');
});
