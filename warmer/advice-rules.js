// ============================================================================
// Warmer — headline copy rules for index.html's buildProse().
//
// Two independent layers, kept structurally separate so one can never leak
// into the other:
//   - trend sentence   ("It's much warmer than yesterday") — reads `diff`
//     (delta vs. yesterday) only. Lives inline in buildProse().
//   - advice sentence  (the action line) — a score pipeline over signals the
//     user can't sense on their own. See "ADVICE SCORE PIPELINE" below.
//
// Priority used to be "how dangerous is this" (temperature checked before
// UV), which meant a 37°C day would always say "avoid the sun" regardless of
// UV, and UV — the one reading nobody can eyeball — never got a look in.
// Priority is now "how much can the user NOT already tell from outside":
// priority = salience × actionability × (1 − selfSensible). Temperature has
// selfSensible = 1.0, which makes its priority zero by construction — this
// keeps temp out of the advice line structurally, not via a banned-word list.
// ============================================================================

export const TEMP_BANDS = [
  {
    name: 'hot', min: 30,
    adjective: 'hot',
    eveningPhrase: 'still hot, just a touch easier',
    bannedWords: ['chilly', 'cold', 'coat', 'jacket', 'short sleeves'],
  },
  {
    name: 'warm', min: 25,
    adjective: 'warm',
    eveningPhrase: 'still warm as it eases off',
    bannedWords: ['chilly', 'cold', 'coat'],
  },
  {
    name: 'mild', min: 20,
    adjective: 'mild',
    eveningPhrase: 'turning mild',
    bannedWords: ['coat', 'freezing'],
  },
  {
    name: 'cool', min: 15,
    adjective: 'cool',
    eveningPhrase: 'turning cool',
    bannedWords: ['freezing'],
  },
  {
    name: 'chilly', min: 10,
    adjective: 'chilly',
    eveningPhrase: 'turning chilly',
    bannedWords: [],
  },
  {
    name: 'cold', min: 5,
    adjective: 'quite cold',
    eveningPhrase: 'turning cold',
    bannedWords: [],
  },
  {
    name: 'freezing', min: -Infinity,
    adjective: 'freezing',
    eveningPhrase: 'dropping toward freezing',
    bannedWords: [],
  },
];

export function bandForTemp(temp) {
  return TEMP_BANDS.find(b => temp >= b.min);
}

// Words a band's own copy must never contain — for tests, not runtime filtering.
export function bandViolations(temp, text) {
  const lower = text.toLowerCase();
  return bandForTemp(temp).bannedWords.filter(w => lower.includes(w));
}

// The one place "is chilly/cold/freezing wording (or garment advice)
// accurate at this temperature" gets decided. This bug kept reappearing in
// a new code path each time — the evening phrase, the old action-line
// temperature fallback, the trend headline, now diurnalRange — because each
// one re-derived its own threshold instead of asking bandForTemp(). Every
// consumer that needs this gate reads this function; none of them re-judge
// temperature on their own.
const COLD_WORDING_BANDS = new Set(['chilly', 'cold', 'freezing']);
export function coldWordingAccurate(temp) {
  return COLD_WORDING_BANDS.has(bandForTemp(temp).name);
}

// ---- HTML fragment helpers (presentation only, no weather logic) ----
const ic = (temp, delta) => {
  const sign = delta > 0 ? '<span class="up">' : delta < 0 ? '<span class="dn">' : '<span>';
  const arr = delta > 0 ? '↑' : delta < 0 ? '↓' : '';
  const abs = Math.abs(delta);
  const deltaStr = delta === 0 ? `±0°` : `${delta < 0 ? '-' : ''}${abs}°${arr}`;
  return `<span class="pcip">${temp}° <span class="ddot"></span> ${sign}${deltaStr}</span></span>`;
};
const proof = (icon, text) => `<span class="pcip-proof"><span class="mi">${icon}</span>${text}</span>`;
const iconChip = (icon, text) => `<span class="pcip"><span class="mi">${icon}</span> ${text}</span>`;

// ============================================================================
// ADVICE SCORE PIPELINE — collect → score → select → translate
//
// Each variable carries two fixed coefficients and one that moves daily:
//   selfSensible   (0-1, constant) — how obvious this is by just being outside.
//   actionability  (0-1, constant) — how much it should actually change what
//                                    you do.
//   salience       (0-1, computed per reading) — how unusual today's value is.
//
// priority = salience × actionability × (1 − selfSensible)
//
// temperature is in this table on purpose: selfSensible = 1.0 makes its
// priority zero no matter what salience/actionability say, which is what
// permanently excludes it from the advice line without a special case.
// ============================================================================
export const COEFFICIENTS = {
  uvIndex:             { selfSensible: 0.0, actionability: 0.9 },
  precipitationTiming:  { selfSensible: 0.1, actionability: 1.0 },
  pollen:               { selfSensible: 0.0, actionability: 0.8 },
  diurnalRange:         { selfSensible: 0.2, actionability: 0.9 },
  windGusts:            { selfSensible: 0.3, actionability: 0.8 },
  airQuality:           { selfSensible: 0.0, actionability: 0.6 },
  dewPoint:             { selfSensible: 0.5, actionability: 0.6 },
  apparentTempGap:      { selfSensible: 0.4, actionability: 0.7 },
  temperature:          { selfSensible: 1.0, actionability: 0 }, // actionability is moot — see comment above
};

// Approximate dew point from temp + relative humidity (Magnus-Tetens). Used
// only when a real dew_point_2m reading isn't available — a physical
// derivation from two real readings, not a fabricated default; it only
// produces a value when both inputs are real, otherwise it stays null like
// everything else in collectAdviceSignals().
function deriveDewPoint(tempC, relHumidityPct) {
  if (tempC == null || relHumidityPct == null) return null;
  const a = 17.27, b = 237.7;
  const alpha = (a * tempC) / (b + tempC) + Math.log(relHumidityPct / 100);
  return +((b * alpha) / (a - alpha)).toFixed(1);
}

/**
 * Stage 1: collect. Reads raw fields off `p` into the variable names the
 * rest of the pipeline knows about. No thresholds, no fallback constants —
 * a variable with no real reading comes out null and is excluded downstream.
 */
export function collectAdviceSignals(p) {
  const { feels = null, tMax = null, tMin = null, uvIndex = null, humidity = null,
          maxRain = null, wind = 0, gust = null,
          pollenSpecies = null, europeanAqi = null, dewPoint = null } = p;

  const temperature = feels ?? tMax ?? null;

  return {
    uvIndex,
    precipitationTiming: maxRain,
    pollen: pollenSpecies,
    // Daily max−min (일교차), not just the evening-slot drop — a real
    // temperature_2m_min reading, not derived.
    diurnalRange: (tMax != null && tMin != null) ? +(tMax - tMin).toFixed(1) : null,
    // gust is the real signal (wind_gusts_10m); sustained wind is the best
    // available stand-in only when no gust reading exists (same pattern
    // alertForConditions() uses).
    windGusts: gust ?? (wind || null),
    airQuality: europeanAqi,
    // Derived from tMax (actual air temperature), not feels — dew point is a
    // physical property of actual temp + humidity; using the apparent
    // (feels-like) temperature here would double-count the humidity effect
    // dew point is already meant to capture.
    dewPoint: dewPoint ?? deriveDewPoint(tMax ?? temperature, humidity),
    apparentTempGap: (feels != null && tMax != null) ? +Math.abs(feels - tMax).toFixed(1) : null,
    temperature,
  };
}

// ============================================================================
// SALIENCE THRESHOLDS — single source of truth. Everything that decides
// "is today's reading unusual" lives in this block (SALIENCE_BANDS +
// POLLEN_SPECIES_BANDS below), so tuning after a month of real distributions
// means editing here only, nothing scattered across index.html/translate.ts.
// v1 is threshold bands; scoreSalience() is the one function to swap for a
// region/season percentile lookup later — collect/select/translate don't change.
//
// Ranges are [min, max) unless noted. Sourcing notes per variable:
//   - windGusts: Beaufort scale, Force 6 (39-49km/h) = "umbrellas used with
//     difficulty" (Royal Meteorological Society / National Geographic Beaufort
//     descriptions); Force 8 (62-74km/h) = "twigs break off trees" — the point
//     real structural umbrella damage becomes likely, not just awkward.
//   - airQuality: European Environment Agency's official European AQI (EAQI)
//     bands — 0-20 good, 20-40 fair, 40-60 moderate, 60-80 poor, 80-100 very
//     poor, 100+ extremely poor.
//   - pollen (POLLEN_SPECIES_BANDS below): grass/birch cutoffs are UK Met
//     Office published high-range thresholds; alder/mugwort/olive/ragweed are
//     reasonable approximations from general aeroallergen literature, not
//     independently verified per-species EAN cutoffs — revisit with real
//     regional data if this matters more than "roughly right."
//   - dewPoint: standard meteorological comfort bands (NWS/AccuWeather-style
//     dew-point comfort scale) — both a "too dry" and a "too muggy" tail are
//     notable; the 10-18°C middle is unremarkable on purpose.
//   - uvIndex: WHO's official UV Index categories (0-2 low, 3-5 moderate,
//     6-7 high, 8-10 very high, 11+ extreme). Re-tuned after Madrid/Cairo
//     live testing: the old curve (0.2/0.5/0.75/1.0) put UV in a near-tie
//     with diurnalRange even on genuinely high-UV days (Madrid's actual
//     CAMS peak of 7.95 scored only 0.45 priority vs. diurnalRange's 0.43 —
//     a coin-flip that real day-to-day forecast noise could tip either
//     way), so UV rarely won even when it should. Raised so a "high" WHO
//     day (6-7) already scores meaningfully, and "very high"/"extreme"
//     (8+) score close to the ceiling.
// ============================================================================
const SALIENCE_BANDS = {
  uvIndex: [
    { min: 3, max: 6, salience: 0.3, tier: 'mild' },
    { min: 6, max: 8, salience: 0.7, tier: 'moderate' },
    { min: 8, max: 11, salience: 0.95, tier: 'high' },
    { min: 11, max: Infinity, salience: 1.0, tier: 'extreme' },
  ],
  precipitationTiming: [
    { min: 30, max: 60, salience: 0.5, tier: 'possible' },
    { min: 60, max: Infinity, salience: 1.0, tier: 'strong' },
  ],
  // Daily max−min, °C.
  diurnalRange: [
    { min: 8, max: 12, salience: 0.3, tier: 'mild' },
    { min: 12, max: 16, salience: 0.6, tier: 'notable' },
    { min: 16, max: Infinity, salience: 1.0, tier: 'big' },
  ],
  // km/h, gust — see Beaufort sourcing note above. Capped at 60: anything at
  // or above that is already claimed by the P1 wind safety alert in
  // alertForConditions() (windValue >= 60), so a tier above 60 here would be
  // dead code — the pipeline never sees a reading that high.
  windGusts: [
    { min: 39, max: 50, salience: 0.4, tier: 'notable' },
    { min: 50, max: 60, salience: 0.75, tier: 'strong' },
  ],
  // European AQI (0-100+) — see EAQI sourcing note above.
  airQuality: [
    { min: 40, max: 60, salience: 0.25, tier: 'moderate' },
    { min: 60, max: 80, salience: 0.5, tier: 'poor' },
    { min: 80, max: 100, salience: 0.75, tier: 'veryPoor' },
    { min: 100, max: Infinity, salience: 1.0, tier: 'extremelyPoor' },
  ],
  // °C — two-sided: both very dry and very muggy air are notable; 10-18°C is
  // the unremarkable comfortable middle (no band = salience 0).
  dewPoint: [
    { min: -Infinity, max: 10, salience: 0.4, tier: 'dry' },
    { min: 18, max: 21, salience: 0.7, tier: 'muggy' },
    { min: 21, max: Infinity, salience: 1.0, tier: 'oppressive' },
  ],
  apparentTempGap: [
    { min: 2, max: 4, salience: 0.3, tier: 'mild' },
    { min: 4, max: 6, salience: 0.6, tier: 'notable' },
    { min: 6, max: Infinity, salience: 1.0, tier: 'big' },
  ],
  // No bands: temperature's priority is zeroed by (1 − selfSensible) = 0
  // regardless of salience, so it never needs a tier.
  temperature: [],
};

// Pollen needs its own table per species (grains/m³) — raw counts aren't
// comparable across species (see sourcing note above), so each species is
// scored against its own bands and the pipeline picks the single most
// salient species as "the" pollen candidate.
const POLLEN_SPECIES_BANDS = {
  grass: [
    { min: 5, max: 50, salience: 0.35, tier: 'moderate' },
    { min: 50, max: 150, salience: 0.7, tier: 'high' },
    { min: 150, max: Infinity, salience: 1.0, tier: 'veryHigh' },
  ],
  birch: [
    { min: 20, max: 81, salience: 0.35, tier: 'moderate' },
    { min: 81, max: 200, salience: 0.7, tier: 'high' },
    { min: 200, max: Infinity, salience: 1.0, tier: 'veryHigh' },
  ],
  alder: [
    { min: 10, max: 100, salience: 0.35, tier: 'moderate' },
    { min: 100, max: 200, salience: 0.7, tier: 'high' },
    { min: 200, max: Infinity, salience: 1.0, tier: 'veryHigh' },
  ],
  mugwort: [
    { min: 5, max: 10, salience: 0.35, tier: 'moderate' },
    { min: 10, max: 50, salience: 0.7, tier: 'high' },
    { min: 50, max: Infinity, salience: 1.0, tier: 'veryHigh' },
  ],
  olive: [
    { min: 10, max: 100, salience: 0.35, tier: 'moderate' },
    { min: 100, max: 200, salience: 0.7, tier: 'high' },
    { min: 200, max: Infinity, salience: 1.0, tier: 'veryHigh' },
  ],
  ragweed: [
    { min: 10, max: 20, salience: 0.35, tier: 'moderate' },
    { min: 20, max: 50, salience: 0.7, tier: 'high' },
    { min: 50, max: Infinity, salience: 1.0, tier: 'veryHigh' },
  ],
};

function scorePollenSalience(speciesReadings) {
  let best = null;
  for (const [species, reading] of Object.entries(speciesReadings || {})) {
    if (reading == null) continue;
    const bands = POLLEN_SPECIES_BANDS[species];
    if (!bands) continue;
    const hit = bands.find(b => reading >= b.min && reading < b.max);
    if (hit && (!best || hit.salience > best.salience)) {
      best = { salience: hit.salience, tier: hit.tier, meta: { species, value: reading } };
    }
  }
  return best; // null when every species is null/unremarkable — no candidate
}

// Searches forward from *now*, never from midnight — searching from hour 0
// meant an all-day-high-probability rain series always matched hour 0 first,
// so two cities with completely different actual timing both got "12am."
// If it's already raining now, a start time would be wrong (it already
// started) — this looks for when it *clears* instead; if it doesn't clear
// within the rest of the day, there's no honest hour to name at all.
function findRainTiming(context) {
  const series = context?.rainSeries;
  const nowHour = context?.now instanceof Date ? context.now.getHours() : null;
  if (!Array.isArray(series) || nowHour == null) return null;
  const upcoming = series.filter(pt => pt.hour >= nowHour);
  if (upcoming.length === 0) return null;
  if (upcoming[0].rain >= 40) {
    const clears = upcoming.find(pt => pt.rain < 40);
    return clears ? { phase: 'clearing', label: formatHourLabel(clears.hour) } : { phase: 'ongoing', label: null };
  }
  const starts = upcoming.find(pt => pt.rain >= 40);
  return starts ? { phase: 'starting', label: formatHourLabel(starts.hour) } : null;
}
function formatHourLabel(hour) {
  if (hour === 0) return '12am';
  if (hour < 12) return `${hour}am`;
  if (hour === 12) return '12pm';
  return `${hour - 12}pm`;
}

/**
 * Stage 2a: how unusual is this one reading, today? v1 implementation is
 * threshold bands; a null value (no data) returns null rather than a fake 0,
 * so it reads as "no candidate," not "known to be unremarkable." `meta`
 * carries whatever raw context translate() needs (the actual number, a
 * pollen species, a rain start time) — scoreSalience is the only place that
 * computes it, so a future percentile-based version just needs to keep
 * returning the same {salience, tier, meta} shape.
 */
export function scoreSalience(variable, value, context = {}) {
  if (variable === 'pollen') return value ? scorePollenSalience(value) : null;
  if (value == null) return null;
  const bands = SALIENCE_BANDS[variable] || [];
  const hit = bands.find(b => value >= b.min && value < b.max);
  const meta = { value };
  if (variable === 'precipitationTiming') meta.timing = findRainTiming(context);
  // dewPoint's copy states the feels-like gap as a number (see ADVICE_COPY)
  // instead of adjectives — apparent_temperature is the only source for that.
  if (variable === 'dewPoint') meta.feelsLike = context?.feels ?? null;
  // diurnalRange's copy needs the actual overnight low (tMin), not just the
  // size of the drop — a 16° drop from 36° still lands at a shirt-sleeve
  // 20°, and garment wording is only accurate below coldWordingAccurate()'s
  // threshold. Without this, translate can only see the delta, which is
  // exactly how a 34° evening got "dress in layers."
  if (variable === 'diurnalRange') meta.eveningTemp = context?.tMin ?? null;
  return hit ? { salience: hit.salience, tier: hit.tier, meta } : { salience: 0, tier: null, meta };
}

/**
 * Stage 2b: score. priority = salience × actionability × (1 − selfSensible).
 */
export function scoreCandidates(signals, context = {}) {
  return Object.entries(signals)
    .map(([key, value]) => {
      const s = scoreSalience(key, value, context);
      if (!s) return null;
      const coeff = COEFFICIENTS[key];
      const priority = +(s.salience * coeff.actionability * (1 - coeff.selfSensible)).toFixed(4);
      return { key, value, salience: s.salience, tier: s.tier, meta: s.meta, actionability: coeff.actionability, priority };
    })
    .filter(Boolean);
}

/**
 * Stage 3: select. Highest priority wins; ties broken by actionability.
 * Returns null when nothing scores above zero.
 */
export function selectCandidate(scored) {
  const positive = scored.filter(c => c.priority > 0);
  if (positive.length === 0) return null;
  positive.sort((a, b) => b.priority - a.priority || b.actionability - a.actionability);
  return positive[0];
}

const pollenLabel = species => species.charAt(0).toUpperCase() + species.slice(1);

function describeRainTiming(meta, strong) {
  const t = meta.timing;
  if (t?.phase === 'starting') {
    return strong ? `Rain moves in around ${t.label} — bring an umbrella.` : `Rain's possible from around ${t.label}.`;
  }
  if (t?.phase === 'clearing') {
    return strong ? `Rain clears up around ${t.label} — bring an umbrella until then.` : `Rain should ease up around ${t.label}.`;
  }
  if (t?.phase === 'ongoing') {
    return strong ? "Rain's set in for a while — bring an umbrella." : 'On-and-off rain for a while — an umbrella might be worth it.';
  }
  return strong ? 'Bring an umbrella.' : 'An umbrella might be worth it today.';
}

// Stage 4: translate. Copy is keyed by variable + salience tier, as a
// function of that candidate's meta (the actual number/species/time) —
// never by temperature. Every string here is re-checked by
// assertNotSelfEvident() before it can reach the screen (see computeAdvice
// below); SELF_EVIDENT_PHRASES lists what it rejects.
export const ADVICE_COPY = {
  uvIndex: {
    mild: meta => `UV's at ${meta.value} — SPF 30+ is worth it if you'll be out a while.`,
    moderate: meta => `UV's at ${meta.value} — some shade around midday helps if you're out long.`,
    high: meta => `UV's at ${meta.value} — skin burns fast at midday; SPF 30+ and a hat earn their keep.`,
    extreme: meta => `UV's at ${meta.value}, the extreme end — worth planning errands outside midday hours.`,
  },
  precipitationTiming: {
    possible: meta => describeRainTiming(meta, false),
    strong: meta => describeRainTiming(meta, true),
  },
  pollen: {
    moderate: meta => `${pollenLabel(meta.species)} pollen is creeping up — could irritate allergies today.`,
    high: meta => `${pollenLabel(meta.species)} pollen is high today — worth an antihistamine before heading out.`,
    veryHigh: meta => `${pollenLabel(meta.species)} pollen is very high today — an antihistamine earns its keep if you're sensitive.`,
  },
  // Garment wording ("grab a layer") is only accurate if the overnight low
  // itself is cool — a 16° drop from 36° still lands at a shirt-sleeve 20°.
  // Gated by coldWordingAccurate(meta.eveningTemp), same shared bandForTemp()
  // table as the trend headline and evening phrase — never a fresh
  // threshold. Below that gate, still worth naming the swing as information,
  // just without garment advice. "overnight," not "after sunset": the daily
  // low consistently lands within an hour of sunrise, not shortly after
  // sunset — see the timing note on findRainTiming's neighbors above.
  diurnalRange: {
    mild: meta => coldWordingAccurate(meta.eveningTemp)
      ? `Drops ${Math.round(meta.value)}° overnight — worth having a layer on hand.`
      : `Cools to about ${Math.round(meta.eveningTemp)}° overnight — a comfortable night, nothing dramatic.`,
    notable: meta => coldWordingAccurate(meta.eveningTemp)
      ? `Drops ${Math.round(meta.value)}° overnight — bring a layer before you head out later.`
      : `Nights ease down to about ${Math.round(meta.eveningTemp)}° — well below the daytime high, but still warm.`,
    big: meta => coldWordingAccurate(meta.eveningTemp)
      ? `Drops ${Math.round(meta.value)}° overnight — dress in layers you can add as it falls.`
      : `Big swing to about ${Math.round(meta.eveningTemp)}° overnight — a lot cooler than the day, though still mild out.`,
  },
  windGusts: {
    notable: meta => `Gusts to ${Math.round(meta.value)}km/h — umbrellas won't hold up well; a windproof layer's worth it.`,
    strong: meta => `Gusts to ${Math.round(meta.value)}km/h — secure loose items and dress for the wind.`,
  },
  airQuality: {
    moderate: () => "Air quality's fair today — fine for a walk, maybe ease off a hard outdoor workout.",
    poor: () => "Air quality's poor — worth moving an intense workout indoors today.",
    veryPoor: () => 'Air quality is very poor — skip strenuous exercise outside today.',
    extremelyPoor: () => "Air quality's extremely poor — best to skip outdoor exercise entirely today.",
  },
  dewPoint: {
    dry: meta => `Dew point's down near ${Math.round(meta.value)}° — air's dry; lip balm or lotion helps.`,
    muggy: meta => meta.feelsLike != null ? `Feels closer to ${meta.feelsLike}° with the humidity.` : 'Feels a few degrees warmer than the reading, thanks to the humidity.',
    oppressive: meta => meta.feelsLike != null ? `Feels closer to ${meta.feelsLike}° with the humidity — that gap is doing real work today.` : 'Feels well above the actual reading today, thanks to the humidity.',
  },
  apparentTempGap: {
    mild: () => 'Feels a bit different than the number suggests — dress by feel, not just the reading.',
    notable: () => 'Feels noticeably different than the actual temperature — dress for how it feels outside.',
    big: () => 'What it feels like is way off the actual number — trust the feels-like reading when you dress.',
  },
};

export function translateCandidate(selected) {
  if (!selected) return '';
  const fn = ADVICE_COPY[selected.key]?.[selected.tier];
  return fn ? fn(selected.meta || {}) : '';
}

// Final gate, applied once to the rendered string — not per variable. A
// per-variable check gets re-opened every time a new variable is added (this
// is exactly how "drink water" came back via dewPoint after PR3 had already
// removed it from the temperature path); checking the actual output text
// closes that loophole regardless of which variable produced it.
// "wear sunscreen" only counts as self-evident when it's not attached to a
// concrete number (an SPF value, a UV reading) — a bare imperative is
// boilerplate, a number is information.
export const SELF_EVIDENT_PHRASES = [
  'drink water', 'stay hydrated', 'avoid direct sun', 'seek shade',
  'stay cool', 'take it easy', 'dress warmly',
];
export function assertNotSelfEvident(text) {
  const lower = text.toLowerCase();
  const hit = SELF_EVIDENT_PHRASES.find(p => lower.includes(p));
  if (hit) throw new Error(`self-evident phrase "${hit}" in advice text: "${text}"`);
  if (lower.includes('wear sunscreen') && !/\d/.test(text)) {
    throw new Error(`self-evident phrase "wear sunscreen" (no concrete number) in advice text: "${text}"`);
  }
}

// Cross-layer dedup: buildProse's own headline/trend copy already states
// some of these signals in plain language (rain in the "Rain coming"
// headline, the day's temperature swing in the evening-drop trend line) —
// mirrors buildProse()'s exact branch conditions below so the advice line
// never restates what the headline already said.
export function coveredHeadlineTopics(p) {
  const { diff = 0, tMax, maxRain = 0, slots = [], wind = 0 } = p;
  const eTemp = slots?.[2]?.temp ?? null;
  const eDrop = (tMax != null && eTemp != null) ? tMax - eTemp : 0;
  const abs = Math.abs(diff);
  const covered = new Set();
  if (maxRain > 40) {
    covered.add('precipitationTiming');
  } else if (abs >= 2) {
    if (eDrop >= 5 && eTemp != null) covered.add('diurnalRange');
  } else if (wind < 25 && eDrop >= 5 && eTemp != null) {
    covered.add('diurnalRange');
  }
  return covered;
}

// precipitationTiming keeps an exception: the headline never states a clock
// time, so if this candidate has one to add (a real "starting"/"clearing"
// hour, not the no-op "ongoing" case), it's still new information even
// though the headline already said "rain."
function isDuplicateOfHeadline(candidate, covered) {
  if (!covered.has(candidate.key)) return false;
  if (candidate.key === 'precipitationTiming' && candidate.meta?.timing?.label) return false;
  return true;
}

/**
 * Runs the full collect → score → select → translate pipeline: picks the
 * highest-priority candidate, and if it either duplicates the headline or
 * fails assertNotSelfEvident, disqualifies it and retries with the
 * next-highest instead — never falls back to a disqualified candidate's
 * text. Logs which variable (if any) won, so real-world distributions can
 * inform threshold tuning later (see SALIENCE_BANDS above).
 */
export function computeAdvice(p) {
  const signals = collectAdviceSignals(p);
  const covered = coveredHeadlineTopics(p);
  let pool = scoreCandidates(signals, p);
  let selected = null;
  let text = '';
  while (pool.length > 0) {
    const candidate = selectCandidate(pool);
    if (!candidate) break;
    if (isDuplicateOfHeadline(candidate, covered)) {
      pool = pool.filter(c => c.key !== candidate.key);
      continue;
    }
    const candidateText = translateCandidate(candidate);
    try {
      assertNotSelfEvident(candidateText);
      selected = candidate;
      text = candidateText;
      break;
    } catch {
      pool = pool.filter(c => c.key !== candidate.key);
    }
  }
  console.debug(selected
    ? `[advice] selected "${selected.key}" (tier=${selected.tier}, priority=${selected.priority})`
    : '[advice] no candidate scored above 0, or all disqualified (headline duplicate / self-evident) — action line omitted');
  return text;
}

// ---- P1: safety alerts — a hard top-level branch above everything else. ----
// Independent of the score pipeline/the trend-and-advice logic in buildProse():
// reads its own fields and never calls into that pipeline, so it can't be
// perturbed by anything above. First match wins. These fire on danger, not on
// how unsensed the reading is — so unlike the pipeline above, it's fine (and
// intended) for these to sometimes state something already obvious from
// outside; the raw wording still avoids the fully self-evident phrasing
// ("it's cold") in favor of the concrete hazard ("icy roads").
const HEAT_ALERT_ACTION = 'Keep out of the midday sun, and drink more water than usual.';
const COLD_ALERT_ACTION = 'Cover hands and face, and keep outdoor trips short.';
// Wind alert deliberately never mentions umbrellas, even when maxRain is high —
// this is the conflict-suppression the wind branch owns; it doesn't read maxRain at all.
const WIND_ALERT_ACTION = 'Stay in if you can, and avoid loose objects, trees, and coastal areas outside.';
const ICE_ALERT_ACTION = 'Watch for icy patches on roads, steps, and bridges, and give yourself extra time to get around.';
const STORM_ALERT_ACTION = 'Head indoors when you hear thunder, and steer clear of open areas, tall trees, and metal railings.';

export function alertForConditions(p) {
  const { feels, wind, gust = null, diff = 0, tCode = 0, maxRain = 0 } = p;
  const windValue = gust != null ? gust : wind;
  // Explicit p.precip (if ever supplied) wins; otherwise a real precipitation
  // probability reading of 50%+ stands in — this is a derived read of actual
  // data, not a fabricated constant.
  const precip = p.precip ?? (maxRain >= 50);
  const trendSuffix = Math.abs(diff) >= 3 ? ` · ${Math.abs(diff)}° ${diff > 0 ? 'warmer' : 'cooler'} than yesterday` : '';

  if (feels >= 36) {
    return {
      headline: 'Dangerous heat today — plan around it',
      action: HEAT_ALERT_ACTION,
      proof: `${feels}° feels-like${trendSuffix}`,
      icon: 'thermostat',
    };
  }
  if (feels <= -10) {
    return {
      headline: 'A hard freeze — dress for far colder',
      action: COLD_ALERT_ACTION,
      proof: `Feels like ${feels}°${trendSuffix}`,
      icon: 'thermostat',
    };
  }
  if (windValue >= 60) {
    return {
      headline: 'Strong winds today — stay in if you can',
      action: WIND_ALERT_ACTION,
      proof: `${windValue}km/h`,
      icon: 'air',
    };
  }
  // Road/bridge surfaces can ice up several degrees above freezing air temp
  // (radiative cooling), so this band runs up to +3°C, not just below 0°C.
  if (feels <= 3 && precip) {
    return {
      headline: 'Icy surfaces possible today',
      action: ICE_ALERT_ACTION,
      proof: `${feels}° with precipitation${trendSuffix}`,
      icon: 'ac_unit',
    };
  }
  if (tCode >= 95 && tCode <= 99) {
    return {
      headline: 'Thunderstorms in the forecast',
      action: STORM_ALERT_ACTION,
      proof: `Storm risk today${trendSuffix}`,
      icon: 'thunderstorm',
    };
  }
  return null;
}

/**
 * p: { diff, tCode, feels, slots, tMax, maxRain, wind, uvIndex, humidity, ... }
 * Returns the headline HTML. Trend line is delta-based; evening line is
 * absolute-temperature-based; the advice/action line runs the score
 * pipeline above and never reads temperature into its output.
 */
export function buildProse(p) {
  const alert = alertForConditions(p);
  if (alert) {
    return `<span class="w">${alert.headline}</span>${proof(alert.icon, alert.proof)}<br><span class="action">${alert.action}</span>`;
  }

  const { diff, tCode, feels, slots, tMax, maxRain, wind } = p;
  const eTemp = slots[2]?.temp;
  const eDrop = eTemp != null ? tMax - eTemp : 0;
  const abs = Math.abs(diff);
  const dChip = ic(tMax, diff);
  const eChip = eDrop >= 5 && eTemp != null ? iconChip('nights_stay', `${eTemp}°C`) : '';

  const action = computeAdvice(p);

  let prose = '';
  if (maxRain > 40) {
    prose = `<span class="g">Rain </span><span class="w">${maxRain > 85 ? 'coming' : maxRain > 70 ? 'likely' : 'possible'}</span>`;
    const rainHour = slots.find(s => s.rain > 40);
    const rainWindow = rainHour ? proof('water_drop', `${rainHour.label} · ${Math.round(maxRain)}%`) : '';
    if (rainWindow) prose += rainWindow;
    if (abs >= 3) prose += ` <span class="g">and ${diff > 0 ? 'warmer' : 'cooler'} than yesterday</span>${dChip}`;
  } else if (abs >= 2) {
    // The cold-side words here used to come from `diff` alone, with no gate
    // on the actual temperature — so a 36° day that's 2° cooler than
    // yesterday got called "a bit chilly" (Cairo). The evening phrase below
    // was already gated by absolute temp via bandForTemp(); this line
    // wasn't. "chilly/colder" only describe genuinely cool conditions now —
    // above that, the same-size drop is "cooler," a comparison to
    // yesterday, not a claim about how the day itself feels. Reads
    // coldWordingAccurate() (same bandForTemp() table as everywhere else)
    // rather than its own threshold.
    const cold = coldWordingAccurate(tMax);
    const cw = diff >= 6 ? 'much warmer' : diff >= 3 ? 'warmer' : diff >= 2 ? 'a bit warmer'
      : diff <= -6 ? (cold ? 'much colder' : 'much cooler')
      : diff <= -3 ? (cold ? 'colder' : 'cooler')
      : (cold ? 'a bit chilly' : 'a touch cooler');
    prose = `<span class="g">It's </span><span class="w">${cw}</span><span class="g"> than yesterday</span>${dChip}`;
    if (eChip) {
      const phrase = bandForTemp(eTemp).eveningPhrase;
      prose += `<br><span class="g">but </span><span class="w">${phrase}</span><span class="g"> in the evening</span>${eChip}`;
    }
  } else {
    const sameLabel = diff === 0 ? 'Same' : 'Similar';
    const samePrep = diff === 0 ? 'as' : 'to';
    prose = `<span class="w">${sameLabel}</span><span class="g"> ${samePrep} yesterday</span>${dChip}`;
    const windProof = wind >= 25 ? proof('air', `${wind}km/h`) : '';
    const eveProof = eDrop >= 5 && eTemp != null ? iconChip('nights_stay', `${eTemp}°C`) : '';
    const secondary = wind >= 25
      ? `<br><span class="g">but </span><span class="w">windier</span><span class="g"> today</span>${windProof}`
      : eDrop >= 5 && eTemp != null
      ? `<br><span class="g">but </span><span class="w">${bandForTemp(eTemp).eveningPhrase}</span><span class="g"> tonight</span>${eveProof}`
      : feels <= tMax - 4
      ? `<br><span class="g">but feels </span><span class="w">colder</span><span class="g"> with wind chill</span>${proof('thermostat', `${feels}°`)}`
      : `<br><span class="g">feels </span><span class="w">${bandForTemp(feels).adjective}</span><span class="g"> out.</span>`;
    prose += secondary;
  }

  return action ? `${prose}<br><span class="action">${action}</span>` : prose;
}
