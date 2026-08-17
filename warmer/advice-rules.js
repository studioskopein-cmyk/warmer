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

// Approximate dew point from temp + relative humidity (Magnus-Tetens). This
// is a physical derivation from two real readings, not a fabricated default —
// it only produces a value when both inputs are real; otherwise it stays null
// like everything else in collectAdviceSignals().
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
  const { feels = null, tMax = null, uvIndex = null, humidity = null,
          maxRain = null, wind = 0, gust = null, slots = [],
          pollen = null, airQuality = null, dewPoint = null } = p;

  const temperature = feels ?? tMax ?? null;
  const eTemp = slots[2]?.temp ?? null;

  return {
    uvIndex,
    precipitationTiming: maxRain,
    pollen,
    diurnalRange: (tMax != null && eTemp != null) ? +(tMax - eTemp).toFixed(1) : null,
    // gust is the real signal; sustained wind is the best available stand-in
    // when no gust reading exists (same pattern alertForConditions() uses).
    windGusts: gust ?? (wind || null),
    airQuality,
    dewPoint: dewPoint ?? deriveDewPoint(temperature, humidity),
    apparentTempGap: (feels != null && tMax != null) ? +Math.abs(feels - tMax).toFixed(1) : null,
    temperature,
  };
}

// v1 salience: threshold bands. Isolated behind this one function so it can
// be swapped for a region/season percentile lookup later without touching
// collect/select/translate.
const SALIENCE_BANDS = {
  uvIndex: [
    { min: 11, salience: 1.0, tier: 'extreme' },
    { min: 8, salience: 0.75, tier: 'high' },
    { min: 6, salience: 0.5, tier: 'moderate' },
    { min: 3, salience: 0.2, tier: 'mild' },
  ],
  precipitationTiming: [
    { min: 60, salience: 1.0, tier: 'strong' },
    { min: 30, salience: 0.5, tier: 'possible' },
  ],
  // Placeholder bands — no pollen API is wired into the data pipeline yet,
  // so this variable is always null/excluded in production today.
  pollen: [
    { min: 4, salience: 1.0, tier: 'high' },
    { min: 3, salience: 0.6, tier: 'moderate' },
    { min: 2, salience: 0.3, tier: 'mild' },
  ],
  diurnalRange: [
    { min: 10, salience: 1.0, tier: 'big' },
    { min: 7, salience: 0.7, tier: 'notable' },
    { min: 5, salience: 0.4, tier: 'mild' },
  ],
  windGusts: [
    { min: 45, salience: 0.8, tier: 'strong' },
    { min: 35, salience: 0.6, tier: 'notable' },
    { min: 25, salience: 0.35, tier: 'mild' },
  ],
  // Placeholder bands (US AQI cut points) — no air-quality API wired in yet,
  // so this variable is always null/excluded in production today.
  airQuality: [
    { min: 151, salience: 1.0, tier: 'unhealthy' },
    { min: 101, salience: 0.6, tier: 'sensitive' },
    { min: 51, salience: 0.3, tier: 'moderate' },
  ],
  dewPoint: [
    { min: 24, salience: 1.0, tier: 'oppressive' },
    { min: 21, salience: 0.7, tier: 'muggy' },
    { min: 18, salience: 0.4, tier: 'sticky' },
  ],
  apparentTempGap: [
    { min: 6, salience: 1.0, tier: 'big' },
    { min: 4, salience: 0.6, tier: 'notable' },
    { min: 2, salience: 0.3, tier: 'mild' },
  ],
  // No bands: temperature's priority is zeroed by (1 − selfSensible) = 0
  // regardless of salience, so it never needs a tier.
  temperature: [],
};

/**
 * Stage 2a: how unusual is this one reading, today? v1 implementation is
 * threshold bands; a null value (no data) returns null rather than a fake 0,
 * so it reads as "no candidate," not "known to be unremarkable."
 */
export function scoreSalience(variable, value, context = {}) {
  if (value == null) return null;
  const bands = SALIENCE_BANDS[variable];
  if (!bands || bands.length === 0) return { salience: 0, tier: null };
  for (const band of bands) {
    if (value >= band.min) return { salience: band.salience, tier: band.tier };
  }
  return { salience: 0, tier: null };
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
      return { key, value, salience: s.salience, tier: s.tier, actionability: coeff.actionability, priority };
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

// Stage 4: translate. Copy is keyed by variable + salience tier only —
// never by temperature.
const ADVICE_COPY = {
  uvIndex: {
    mild: "UV's creeping up — sunscreen's worth it if you'll be out a while.",
    moderate: "UV's fairly strong out — a bit of shade or sunscreen wouldn't hurt.",
    high: 'Avoid direct sun around midday and into the afternoon, and keep drinking water.',
    extreme: "UV's at extreme levels — minimize midday sun and reapply sunscreen if you're out.",
  },
  precipitationTiming: {
    possible: 'An umbrella might be worth it.',
    strong: 'Bring an umbrella.',
  },
  pollen: {
    mild: 'Pollen count is creeping up — could irritate allergies today.',
    moderate: "Pollen's moderate to high — allergy meds might help if you're sensitive.",
    high: "Pollen's high today — worth taking allergy precautions before heading out.",
  },
  diurnalRange: {
    mild: 'Cools off a fair bit tonight — worth having a layer on hand.',
    notable: 'Big drop by evening — bring a layer before you head out later.',
    big: 'Big swing to a much colder evening — dress in layers you can add as it drops.',
  },
  windGusts: {
    mild: "Breezy today — a windproof layer's worth it if you'll be out a while.",
    notable: 'Gusty out there — a windproof layer makes a real difference.',
    strong: 'Strong gusts today — secure loose items and dress for the wind.',
  },
  airQuality: {
    moderate: "Air quality's a bit off today — sensitive groups may want to take it easy outside.",
    sensitive: 'Air quality is unhealthy for sensitive groups — consider limiting time outside.',
    unhealthy: "Air quality's poor today — worth limiting time outdoors if you can.",
  },
  dewPoint: {
    sticky: 'A bit sticky out — breathable fabric helps.',
    muggy: 'Humid enough to feel warmer than it reads — breathable fabric helps.',
    oppressive: "Air feels heavy and oppressive — take it easy and drink water even if it doesn't feel that hot.",
  },
  apparentTempGap: {
    mild: 'Feels a bit different than the number suggests — dress by feel, not just the reading.',
    notable: 'Feels noticeably different than the actual temperature — dress for how it feels outside.',
    big: 'What it feels like is way off the actual number — trust the feels-like reading when you dress.',
  },
};

export function translateCandidate(selected) {
  if (!selected) return '';
  return ADVICE_COPY[selected.key]?.[selected.tier] || '';
}

/**
 * Runs the full collect → score → select → translate pipeline and logs which
 * variable (if any) won, so real-world distributions can inform threshold
 * tuning later (see SALIENCE_BANDS above).
 */
export function computeAdvice(p) {
  const signals = collectAdviceSignals(p);
  const scored = scoreCandidates(signals, p);
  const selected = selectCandidate(scored);
  console.debug(selected
    ? `[advice] selected "${selected.key}" (tier=${selected.tier}, priority=${selected.priority})`
    : '[advice] no candidate scored above 0 — action line omitted');
  return translateCandidate(selected);
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
    const cw = diff >= 6 ? 'much warmer' : diff >= 3 ? 'warmer' : diff >= 2 ? 'a bit warmer'
      : diff <= -6 ? 'much colder' : diff <= -3 ? 'colder' : 'a bit chilly';
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
