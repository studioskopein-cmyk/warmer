import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertForConditions, bandForTemp, bandViolations, buildProse, heatAdviceForTemp, TEMP_BANDS } from './advice-rules.js';

function slotsFor(eveningTemp) {
  return [{ temp: 0, rain: 0 }, { temp: 0, rain: 0 }, { temp: eveningTemp, rain: 0 }];
}

function baseP({ feels, tMax, diff, evening, maxRain = 0, wind = 0, tCode = 0, uvIndex = null, humidity = null }) {
  return { diff, tCode, feels, tMax, maxRain, wind, slots: slotsFor(evening), uvIndex, humidity };
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

test('cold day stays coat weather even when warmer than yesterday', () => {
  const p = baseP({ feels: 8, tMax: 8, diff: 5, evening: 3 });
  const html = buildProse(p);
  assert.ok(html.toLowerCase().includes('coat'), `expected coat guidance in: ${html}`);
});

test('mild evening cooldown gets a light layer, not a coat', () => {
  const p = baseP({ feels: 26, tMax: 26, diff: -4, evening: 19 });
  const html = buildProse(p);
  assert.ok(!html.toLowerCase().includes('coat'), `did not expect coat in: ${html}`);
});

test('30C+ never says "short sleeves" (self-evident advice is omitted)', () => {
  for (const feels of [30, 32, 35, 40]) {
    for (const diff of [-5, 0, 5]) {
      const html = buildProse(baseP({ feels, tMax: feels, diff, evening: feels - 1 }));
      assert.ok(!html.toLowerCase().includes('short sleeves'), `unexpected "short sleeves" in: ${html}`);
    }
  }
});

test('hot band always fills the action line with heat guidance (no empty layout gap)', () => {
  const html = buildProse(baseP({ feels: 33, tMax: 33, diff: 0, evening: 33 }));
  assert.ok(html.includes('class="action"'), `expected a heat-guidance action line in: ${html}`);
  assert.ok(html.includes(heatAdviceForTemp(33)), `expected heatAdvice text in: ${html}`);
});

test('{ high: 35 } includes heat guidance, never "short sleeves" or "coat"', () => {
  // 35, not 37: stays below the P1 heat-alert threshold (feels>=36) added later, while
  // still landing in the 34°C heatAdvice tier this test targets.
  const html = buildProse(baseP({ feels: 35, tMax: 35, diff: 0, evening: 35 }));
  assert.equal(heatAdviceForTemp(35), 'Avoid direct sun around midday and into the afternoon, and keep drinking water.');
  assert.ok(html.includes(heatAdviceForTemp(35)), `expected heatAdvice text in: ${html}`);
  const lower = html.toLowerCase();
  assert.ok(!lower.includes('short sleeves'), `unexpected "short sleeves" in: ${html}`);
  assert.ok(!lower.includes('coat'), `unexpected "coat" in: ${html}`);
});

test('{ high: 31 } gets the light 30-33 tier, not a warning tone', () => {
  const html = buildProse(baseP({ feels: 31, tMax: 31, diff: 0, evening: 31 }));
  assert.equal(heatAdviceForTemp(31), "It's warm enough to take it easy — pace yourself, nothing dramatic.");
  assert.ok(html.includes(heatAdviceForTemp(31)), `expected the light-tier text in: ${html}`);
  const lower = html.toLowerCase();
  assert.ok(!lower.includes('serious'), `did not expect a warning tone in: ${html}`);
  assert.ok(!lower.includes('avoid direct sun'), `did not expect the 34+ tier wording in: ${html}`);
});

test('{ high: 22 } (mild band) has no heat guidance at all', () => {
  const html = buildProse(baseP({ feels: 22, tMax: 22, diff: 0, evening: 22 }));
  for (const tier of TEMP_BANDS.find(b => b.name === 'hot').heatAdvice) {
    assert.ok(!html.includes(tier.text), `did not expect hot-band heat guidance in: ${html}`);
  }
});

test('uv: null never generates UV-based copy, even when temp/humidity would otherwise be silent', () => {
  const html = buildProse(baseP({ feels: 26, tMax: 26, diff: 0, evening: 26, uvIndex: null, humidity: null }));
  const lower = html.toLowerCase();
  assert.ok(!lower.includes('uv'), `did not expect any UV wording in: ${html}`);
  assert.ok(!lower.includes('sun'), `did not expect sun-avoidance wording in: ${html}`);
  // falls all the way back to the warm band's plain garment line
  assert.ok(html.includes('Keep it light and stay hydrated.'), `expected the warm band fallback in: ${html}`);
});

test('{ uv: 9, high: 22 } (mild band): strong UV alone triggers sun+hydration guidance', () => {
  const html = buildProse(baseP({ feels: 22, tMax: 22, diff: 0, evening: 22, uvIndex: 9 }));
  assert.ok(html.includes('Avoid direct sun around midday and into the afternoon, and keep drinking water.'), `expected sun+hydration guidance in: ${html}`);
  const lower = html.toLowerCase();
  assert.ok(!lower.includes('long-sleeve'), `did not expect the mild-band garment line in: ${html}`);
});

test('{ uv: 9, high: 35 }: heat and UV overlap collapses to a single line, not two', () => {
  // 35, not 37: same P1-threshold reasoning as the test above.
  const html = buildProse(baseP({ feels: 35, tMax: 35, diff: 0, evening: 35, uvIndex: 9 }));
  const actionMatches = html.match(/class="action"/g) || [];
  assert.equal(actionMatches.length, 1, `expected exactly one action line in: ${html}`);
  assert.ok(html.includes('Avoid direct sun around midday and into the afternoon, and keep drinking water.'), `expected sun+hydration guidance in: ${html}`);
});

test('{ humidity: 80, uv: 3, high: 26 }: humidity guidance, not UV (UV too low to qualify)', () => {
  const html = buildProse(baseP({ feels: 26, tMax: 26, diff: 0, evening: 26, uvIndex: 3, humidity: 80 }));
  assert.ok(html.includes("Humid enough to feel warmer than it reads — breathable fabric helps."), `expected humidity guidance in: ${html}`);
  const lower = html.toLowerCase();
  assert.ok(!lower.includes('sunscreen'), `did not expect UV wording in: ${html}`);
});

// ---- P1 safety alerts (alertForConditions) ----

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
