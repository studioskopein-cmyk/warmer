import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandForTemp, bandViolations, buildProse } from './advice-rules.js';

function slotsFor(eveningTemp) {
  return [{ temp: 0, rain: 0 }, { temp: 0, rain: 0 }, { temp: eveningTemp, rain: 0 }];
}

function baseP({ feels, tMax, diff, evening, maxRain = 0, wind = 0, tCode = 0 }) {
  return { diff, tCode, feels, tMax, maxRain, wind, slots: slotsFor(evening) };
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

test('advice sentence is omitted (not padded) when the hot band has nothing to add', () => {
  const html = buildProse(baseP({ feels: 33, tMax: 33, diff: 0, evening: 33 }));
  assert.ok(!html.includes('class="action"'), `expected no action line in: ${html}`);
});
