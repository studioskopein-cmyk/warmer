import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertForConditions, bandForTemp, bandViolations, buildProse, TEMP_BANDS,
  COEFFICIENTS, scoreCandidates, selectCandidate, collectAdviceSignals, computeAdvice,
  assertNotSelfEvident, ADVICE_COPY,
} from './advice-rules.js';

function slotsFor(eveningTemp) {
  return [{ temp: 0, rain: 0 }, { temp: 0, rain: 0 }, { temp: eveningTemp, rain: 0 }];
}

// nowHour anchors precipitation-timing tests to a specific "current hour"
// (findRainTiming searches forward from it) without depending on the real
// wall clock; it defaults to midnight so every test that doesn't care about
// rain timing keeps searching the whole day, same as before.
function baseP({ feels, tMax, diff, evening, maxRain = 0, wind = 0, tCode = 0, uvIndex = null, humidity = null, nowHour = 0, ...rest }) {
  const now = rest.now ?? new Date(2026, 0, 1, nowHour, 0, 0);
  return { diff, tCode, feels, tMax, maxRain, wind, slots: slotsFor(evening), uvIndex, humidity, now, ...rest };
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
  assert.ok(html.includes("UV's at 7.55 — some shade around midday helps"), `expected moderate-UV copy in: ${html}`);
  assert.ok(!html.includes('skin burns fast'), `did not expect the high-tier UV line at this (moderate) UV tier: ${html}`);
});

test('{ feels: 22, uv: 9, cloud: 90 }: high UV wins even on a cloudy day — the app\'s killer case', () => {
  const html = buildProse(baseP({ feels: 22, tMax: 22, diff: 0, evening: 22, uvIndex: 9, cloud: 90 }));
  assert.ok(html.includes("UV's at 9 — skin burns fast at midday"), `expected high-UV guidance in: ${html}`);
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
  // humidity:65 at feels:20 derives a dew point in the unremarkable 10-18°C
  // comfortable gap (see SALIENCE_BANDS.dewPoint) — deliberately not <10 or
  // >=18, to prove an "ordinary" reading doesn't spuriously cross a band.
  const p = baseP({ feels: 20, tMax: 20, diff: 1, evening: 19, maxRain: 10, wind: 10, uvIndex: 2, humidity: 65 });
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
  assert.ok(html.includes("UV's at 9 — skin burns fast at midday"), `expected high-UV guidance in: ${html}`);
});

test('{ humidity: 65, uv: 3, tMax: 26, feels: 29 }: dew point (derived from tMax+humidity, muggy tier) outscores low UV — numeric feels-like gap, not UV', () => {
  // humidity:65 at tMax:26 derives a dew point around 19°C — the muggy band
  // (18-21°C), distinct from the oppressive band (>=21°C) tested below.
  // feels:29 (a 3° gap, below apparentTempGap's own "mild" band) keeps that
  // variable from outscoring dewPoint, while still giving muggy's copy a
  // real feels-like number to quote.
  const html = buildProse(baseP({ feels: 29, tMax: 26, diff: 0, evening: 26, uvIndex: 3, humidity: 65 }));
  assert.ok(html.includes('Feels closer to 29° with the humidity.'), `expected the numeric feels-like-gap guidance in: ${html}`);
  const lower = html.toLowerCase();
  assert.ok(!lower.includes('sunscreen'), `did not expect UV wording in: ${html}`);
});

// ---- New real-data candidates (PR4): dew point, diurnal range, wind gusts,
// precipitation start time, air quality, pollen ----

test('dew point: dry tier (derived from tMax+low-humidity) states the actual dew point as a number, not an adjective list', () => {
  const html = buildProse(baseP({ feels: 15, tMax: 15, diff: 0, evening: 15, humidity: 20 }));
  assert.ok(html.includes("Dew point's down near -8°"), `expected the numeric dew-point reading in: ${html}`);
});

test('dew point: oppressive tier (derived, >=21°C) quotes the numeric feels-like gap, not vague adjectives, and never contradicts a "feels X out" trend line', () => {
  // feels:32 vs tMax:28 (a 4° gap) — big enough for the oppressive line to
  // have a distinct feels-like number to quote, small enough (below
  // apparentTempGap's own "big" band) that apparentTempGap doesn't outscore
  // dewPoint's oppressive tier (priority .3) for the win.
  const html = buildProse(baseP({ feels: 32, tMax: 28, diff: 0, evening: 28, humidity: 85 }));
  assert.ok(html.includes('Feels closer to 32° with the humidity'), `expected the numeric oppressive-tier line in: ${html}`);
  assert.ok(!html.includes("doesn't feel that hot"), `did not expect the old self-contradicting phrasing in: ${html}`);
  assert.ok(!html.includes('Feels closer to 29°'), `did not expect the muggy-tier line at oppressive severity: ${html}`);
});

test('diurnal range now reads daily temperature_2m_max/min (일교차), not the evening-slot proxy, and names the actual drop', () => {
  const html = buildProse(baseP({ feels: 22, tMax: 22, diff: 0, evening: 22, tMin: 8 }));
  assert.ok(html.includes('Drops 14° after sunset'), `expected the real 14° daily range in: ${html}`);
});

test('diurnal range stays excluded (null, not zero) when tMin is never supplied', () => {
  const signals = collectAdviceSignals(baseP({ feels: 22, tMax: 22, diff: 0, evening: 22 }));
  assert.equal(signals.diurnalRange, null);
});

test('wind gusts: a real gust reading (not sustained wind) drives the tier', () => {
  const html = buildProse(baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, wind: 10, gust: 42 }));
  assert.ok(html.includes('Gusts to 42km/h'), `expected the actual gust speed in: ${html}`);
  assert.ok(html.toLowerCase().includes("umbrellas won't hold up"), `expected the umbrella-difficulty line (Beaufort 6) in: ${html}`);
});

test('wind gusts: 39km/h fires (Beaufort 6 "umbrellas used with difficulty"), 38km/h does not', () => {
  assert.ok(buildProse(baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, gust: 39 })).includes('class="action"'));
  assert.ok(!buildProse(baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, gust: 38 })).includes('class="action"'));
});

test('precipitation timing: a rain-probability timeseries translates to a clock time, not a percentage', () => {
  const rainSeries = Array.from({ length: 24 }, (_, hour) => ({ hour, rain: hour === 16 ? 70 : 5 }));
  const html = buildProse(baseP({ feels: 18, tMax: 18, diff: 0, evening: 18, maxRain: 65, rainSeries }));
  assert.ok(html.includes('4pm'), `expected the rain start time (4pm) in: ${html}`);
  assert.ok(!html.includes('65%'), `did not expect a raw probability in the action line: ${html}`);
});

test('precipitation timing: without a rainSeries, falls back to generic umbrella copy rather than fabricating a time', () => {
  // maxRain:35 (the "possible" tier, 30-60) deliberately stays at/below the
  // buildProse headline's own maxRain>40 threshold, so this test observes
  // precipitationTiming's own fallback copy in isolation, undisturbed by the
  // item-5 headline-dedup behavior covered separately below.
  const html = buildProse(baseP({ feels: 18, tMax: 18, diff: 0, evening: 18, maxRain: 35 }));
  assert.ok(html.includes('An umbrella might be worth it today.'), `expected the generic possible-rain line in: ${html}`);
});

// ---- Rain timing bug: New York and London both said "12am" (item 1) ----
// Root cause: the old search always started at hour 0, so a day with high
// rain probability all day long matched hour 0 first regardless of when it
// actually started (or whether it already had). Fixed by searching forward
// from the current hour, and by branching on whether it's already raining.

test('precipitation timing searches forward from the current hour, not from midnight — an all-day-high-probability series never wrongly reports "12am"', () => {
  const rainSeries = Array.from({ length: 24 }, (_, hour) => ({ hour, rain: 80 }));
  const html = buildProse(baseP({ feels: 18, tMax: 18, diff: 0, evening: 18, maxRain: 80, rainSeries, nowHour: 10 }));
  assert.ok(!html.includes('12am'), `did not expect a midnight start time when it's already raining at the current hour: ${html}`);
});

test('precipitation timing: already-raining-with-no-clear-time has nothing to add beyond the headline, so it correctly stays silent rather than repeating "rain" a second time', () => {
  const rainSeries = Array.from({ length: 24 }, (_, hour) => ({ hour, rain: 80 }));
  const html = buildProse(baseP({ feels: 18, tMax: 18, diff: 0, evening: 18, maxRain: 80, rainSeries, nowHour: 10 }));
  assert.ok(!html.includes('class="action"'), `expected no action line — the headline already covers "raining all day" and there's no time to add: ${html}`);
});

test('precipitation timing: the "ongoing, no clear time" copy itself (isolated from headline-dedup via a sub-40 maxRain)', () => {
  // maxRain:35 stays under the headline's >40 threshold so this observes
  // the ongoing-phase copy on its own, decoupled from item 5's dedup.
  const rainSeries = Array.from({ length: 24 }, (_, hour) => ({ hour, rain: 80 }));
  const html = buildProse(baseP({ feels: 18, tMax: 18, diff: 0, evening: 18, maxRain: 35, rainSeries, nowHour: 10 }));
  assert.ok(html.includes('On-and-off rain for a while'), `expected the ongoing-phase copy in: ${html}`);
  assert.ok(!html.includes('12am'), `did not expect a fabricated start time in: ${html}`);
});

test('precipitation timing: rain already falling now states when it clears, not a (wrong) start time', () => {
  const rainSeries = Array.from({ length: 24 }, (_, hour) => ({ hour, rain: hour < 15 ? 80 : 10 }));
  const html = buildProse(baseP({ feels: 18, tMax: 18, diff: 0, evening: 18, maxRain: 80, rainSeries, nowHour: 10 }));
  assert.ok(html.includes('clears up around 3pm'), `expected a clearing time, not a start time, in: ${html}`);
  assert.ok(!html.includes('moves in'), `did not expect "moves in" phrasing for rain that's already falling: ${html}`);
});

// ---- Self-evident phrasing: checked once on the final rendered string,
// not per variable (item 2). "drink water" came back via dewPoint even
// after PR3 removed it from the temperature path — a per-variable check
// gets re-opened by every new variable; assertNotSelfEvident() is the one
// gate every candidate's translated text must clear, applied by computeAdvice. ----

test('assertNotSelfEvident: throws on each banned phrase, passes on clean or numeric text', () => {
  for (const phrase of [
    'please drink water often', 'stay hydrated out there', 'avoid direct sun today',
    'seek shade at noon', 'stay cool today', 'take it easy this afternoon', 'dress warmly tonight',
  ]) {
    assert.throws(() => assertNotSelfEvident(phrase), `expected "${phrase}" to be flagged as self-evident`);
  }
  assert.throws(() => assertNotSelfEvident('remember to wear sunscreen'), 'a bare imperative with no number should still be flagged');
  assert.doesNotThrow(() => assertNotSelfEvident('wear SPF 30 sunscreen'), 'a concrete number should exempt the sunscreen phrase');
  assert.doesNotThrow(() => assertNotSelfEvident("UV's at 9 today — worth a hat."));
});

test('every advice-copy variant (all variables × all tiers, representative meta) passes the self-evident gate', () => {
  const representativeMeta = { value: 9, species: 'grass', feelsLike: 34, timing: { phase: 'starting', label: '4pm' } };
  for (const [key, tiers] of Object.entries(ADVICE_COPY)) {
    for (const [tier, fn] of Object.entries(tiers)) {
      const text = fn(representativeMeta);
      assert.doesNotThrow(() => assertNotSelfEvident(text), `${key}.${tier} produced self-evident text: "${text}"`);
    }
  }
});

// ---- Cross-layer dedup: the headline shouldn't be restated by the advice
// line (item 5) ----

test('headline dedup: rain is already in the headline, and there\'s no clock time to add, so the advice line falls through to the next-ranked candidate', () => {
  // maxRain=86 triggers the "Rain coming" headline; with no rainSeries,
  // precipitationTiming has nothing new to add, so it's disqualified as a
  // duplicate and the line should fall through to UV instead.
  const html = buildProse(baseP({ feels: 22, tMax: 22, diff: 0, evening: 22, maxRain: 86, uvIndex: 9 }));
  assert.ok(html.includes('Rain'), `expected the rain headline in: ${html}`);
  assert.ok(!html.includes('Bring an umbrella'), `expected the duplicate rain advice line to be suppressed in: ${html}`);
  assert.ok(html.includes("UV's at 9"), `expected the advice line to fall through to UV in: ${html}`);
});

test('headline dedup exception: a concrete rain start/clear time is information the headline never states, so it survives even though the headline already says "rain" (Taiwan case)', () => {
  const rainSeries = Array.from({ length: 24 }, (_, hour) => ({ hour, rain: hour === 12 ? 86 : 20 }));
  const html = buildProse(baseP({ feels: 22, tMax: 22, diff: 0, evening: 22, maxRain: 86, rainSeries, nowHour: 8 }));
  assert.ok(html.includes('Rain moves in around 12pm'), `expected the advice line to keep the concrete time despite the headline already covering rain: ${html}`);
});

test('headline dedup: a big evening temperature drop already stated in the trend line is not repeated as diurnal-range advice', () => {
  const html = buildProse(baseP({ feels: 24, tMax: 24, diff: 3, evening: 10, tMin: 8 }));
  assert.ok(html.includes('in the evening'), `expected the trend line to cover the evening drop in: ${html}`);
  assert.ok(!html.includes('after sunset'), `expected diurnal-range advice to be suppressed as a headline duplicate in: ${html}`);
});

test('air quality (European AQI): poor tier frames the advice around exercise, not a raw index number', () => {
  const html = buildProse(baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, europeanAqi: 65 }));
  assert.ok(html.toLowerCase().includes('workout') || html.toLowerCase().includes('exercise'), `expected exercise-framed guidance in: ${html}`);
  assert.ok(!html.includes('65'), `did not expect the raw AQI number in: ${html}`);
});

test('pollen: names the specific species, never the generic word "pollen" alone', () => {
  const html = buildProse(baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, pollenSpecies: { grass: 80, birch: null, alder: null, mugwort: null, olive: null, ragweed: null } }));
  assert.ok(html.includes('Grass pollen'), `expected the species name in: ${html}`);
});

test('pollen: species are compared on their own thresholds, not raw grains/m³ — a low-count highly-allergenic species can outrank a high-count one', () => {
  // grass=10 is only that species' "moderate" band (5-50); ragweed=25 is
  // ragweed's "high" band (20-50) despite the smaller raw number.
  const html = buildProse(baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, pollenSpecies: { grass: 10, birch: null, alder: null, mugwort: null, olive: null, ragweed: 25 } }));
  assert.ok(html.includes('Ragweed pollen'), `expected ragweed (higher relative salience) to win over grass in: ${html}`);
});

test('pollen: outside its coverage (all species null) is excluded silently, not an error', () => {
  const p = baseP({ feels: 20, tMax: 20, diff: 0, evening: 20, pollenSpecies: { grass: null, birch: null, alder: null, mugwort: null, olive: null, ragweed: null } });
  assert.doesNotThrow(() => buildProse(p));
  assert.ok(!buildProse(p).includes('class="action"'), 'did not expect an action line with no pollen coverage');
});

// ---- Seasonal coverage: winter Berlin (item 5) ----

test('winter Berlin (UV 0-1, feels 2°C, sustained wind 30km/h, no gust/precip/pollen/AQI reading): the pipeline goes mute, and every excluded variable is null, not a fabricated zero', () => {
  const p = baseP({ feels: 2, tMax: 2, diff: 0, evening: 2, uvIndex: 0.5, wind: 30 });
  const signals = collectAdviceSignals(p);
  // uv: below the mild band (3) — genuinely unremarkable, correctly silent.
  assert.equal(scoreCandidates(signals, p).find(c => c.key === 'uvIndex')?.priority ?? 0, 0);
  // wind: 30km/h sustained is used as the gust stand-in (no real gust reading
  // this scenario), and 30 is below the 39km/h notable threshold — so this
  // reads as "no signal," not because winter has nothing to say, but because
  // this scenario never supplied a real wind_gusts_10m reading.
  assert.equal(signals.windGusts, 30);
  assert.ok(scoreCandidates(signals, p).every(c => c.priority === 0), 'expected every candidate at priority 0 in this scenario');
  // Everything else genuinely unsupplied by this scenario (diurnal range,
  // dew point, pollen, AQI) is null, not 0 — the "mute" result comes from
  // missing data, not from a judgment that winter is inherently unremarkable.
  // (precipitationTiming and apparentTempGap aren't in this list: baseP()
  // gives both feels and tMax as 2 and maxRain as 0 — real readings that
  // happen to be "0% rain" and "no feels-like gap," not missing ones. Both
  // are still excluded, just via priority=0 rather than null.)
  for (const key of ['diurnalRange', 'dewPoint', 'pollen', 'airQuality']) {
    assert.equal(signals[key], null, `expected ${key} to be null (no data supplied), not a fabricated 0`);
  }
  assert.equal(computeAdvice(p), '', 'expected no advice line for this scenario');
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
