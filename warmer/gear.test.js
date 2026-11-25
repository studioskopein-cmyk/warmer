import test from 'node:test';
import assert from 'node:assert/strict';
import { gearFor, GEAR_ITEMS, MAX_GEAR } from './gear.js';

const base = { band: 'mild', precip: null, strongWind: false, uv: 0, aqi: 0, pollen: false, humidity: 40, tempDrop: false, settles: false };

test('freezing day: puffer coat first, hands and head covered', () => {
  const g = gearFor({ ...base, band: 'freezing' });
  assert.equal(g[0], 'heavy puffer coat');
  for (const x of ['hat', 'thick gloves', 'wool socks']) assert.ok(g.includes(x), x);
});

test('cold rain swaps the outer layer for a waterproof one', () => {
  const g = gearFor({ ...base, band: 'chilly', precip: { kind: 'rain', level: 'rain' } });
  assert.equal(g[0], 'waterproof coat');
  assert.ok(g.includes('umbrella') && g.includes('waterproof boots'));
});

test('rain with strong wind: no umbrella, windproof layer instead', () => {
  const g = gearFor({ ...base, band: 'cool', precip: { kind: 'rain', level: 'rain' }, strongWind: true });
  assert.ok(!g.includes('umbrella'));
  assert.ok(g.includes('windproof layer'));
});

test('snow that settles brings boots with grip; light snow only grip shoes', () => {
  assert.ok(gearFor({ ...base, band: 'nearFreezing', precip: { kind: 'snow', level: 'settles' }, settles: true }).includes('waterproof boots with grip'));
  assert.ok(gearFor({ ...base, band: 'nearFreezing', precip: { kind: 'snow', level: 'light' } }).includes('shoes with grip'));
});

test('hot, strong sun: light clothes, brim hat, sunscreen, water', () => {
  const g = gearFor({ ...base, band: 'hot', uv: 9 });
  for (const x of ['linen shirt', 'hat with brim', 'sunscreen', 'sunglasses', 'water bottle']) assert.ok(g.includes(x), x);
  assert.ok(!g.includes('cap'));
});

test('poor air adds a mask; never more than MAX_GEAR items; all from the closed list', () => {
  assert.ok(gearFor({ ...base, aqi: 60 }).includes('mask'));
  const worst = gearFor({ ...base, band: 'freezing', precip: { kind: 'snow', level: 'settles' }, settles: true, strongWind: true, uv: 9, aqi: 90, pollen: true, tempDrop: true });
  assert.ok(worst.length <= MAX_GEAR);
  assert.ok(worst.every(x => GEAR_ITEMS.has(x)));
});

test('outer layer is always first, whatever the weather', () => {
  for (const band of ['hot', 'warm', 'mild', 'cool', 'chilly', 'cold', 'nearFreezing', 'freezing']) {
    const g = gearFor({ ...base, band, precip: { kind: 'rain', level: 'rain' } });
    assert.ok(/jacket|coat/.test(g[0]), `${band}: ${g[0]}`);
  }
});
