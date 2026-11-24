import test from 'node:test';
import assert from 'node:assert/strict';
import { cardAction } from './card-action.js';
import { decideDay } from './advice-rules.js';

const base = { tCode: 0, maxRain: 5, feels: 18, nowTemp: 18, tMax: 18, diff: 0, wind: 10, band: 'DAY', nowHour: 10, slots: [], uvIndex: 2, temperatureUnit: 'C' };

test('empty input gives empty text', () => assert.equal(cardAction(null), ''));
test('the card is the day screen\'s own decision', () => {
  for (const p of [base, { ...base, feels: -12 }, { ...base, wind: 65 }, { ...base, feels: 37 }, { ...base, europeanAqi: 70 }, { ...base, diff: -5, tMax: 10, feels: 8 }]) {
    assert.equal(cardAction(p), decideDay(p).card);
  }
});
test('thunder ahead', () => assert.match(cardAction({ ...base, ahead: { thunder: { hour: 15, chance: 70 } } }), /Storms/));
test('hard freeze', () => assert.equal(cardAction({ ...base, feels: -12 }), 'Hard freeze — bundle up.'));
test('strong wind', () => assert.match(cardAction({ ...base, wind: 65 }), /Strong wind/));
test('cold neutral day', () => assert.equal(cardAction({ ...base, feels: 5, tMax: 7, nowTemp: 7 }), 'Pack your jacket.'));
test('cool neutral day', () => assert.equal(cardAction({ ...base, feels: 12, tMax: 13, nowTemp: 13 }), 'Bring a light jacket.'));
test('mild default', () => assert.equal(cardAction(base), 'Nothing special needed.'));
test('poor air', () => assert.match(cardAction({ ...base, europeanAqi: 70 }), /Poor air/));
