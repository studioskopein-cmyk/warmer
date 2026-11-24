import { findRainEvent } from './rain-events.js';
import { formatTemperature, formatDelta, formatHourLabel } from './weather-display.js';

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
    name: 'nearFreezing', min: 0,
    adjective: 'cold',
    eveningPhrase: 'dropping toward freezing',
    bannedWords: [],
  },
  {
    name: 'freezing', min: -Infinity,
    adjective: 'freezing',
    eveningPhrase: 'dropping below freezing',
    bannedWords: [],
  },
];

export function bandForTemp(temp) {
  return TEMP_BANDS.find(b => temp >= b.min);
}

// ============================================================================
// GEMINI PHRASING PILOT — scope, selection exposure, validation.
//
// Selection (which signal, which tier) stays entirely in the score pipeline
// above. Gemini is only ever asked to reword an ALREADY-CHOSEN, ALREADY-
// TEMPLATED sentence for two tiers that repeat most in real data. Every
// other tier keeps its deterministic template untouched.
// ============================================================================
export const GEMINI_PILOT_SCOPE = [
  { key: 'apparentTempGap', tier: 'big' },
  { key: 'diurnalRange', tier: 'notable' },
];

export function isInGeminiPilotScope(selected) {
  if (!selected) return false;
  return GEMINI_PILOT_SCOPE.some(s => s.key === selected.key && s.tier === selected.tier);
}

// The one number each pilot template actually surfaces. Used to catch the
// model silently drifting a figure while it rewords around it — checking
// every numeric field on `meta` would false-positive, because the
// deterministic template itself doesn't use all of them (e.g. the raw gap
// size on apparentTempGap is never rendered, only feelsLike is).
export const GEMINI_PILOT_RELEVANT_FIELD = {
  apparentTempGap: 'feelsLike',
  diurnalRange: 'eveningTemp',
};

export function geminiNumbersMatch(text, key, meta) {
  const field = GEMINI_PILOT_RELEVANT_FIELD[key];
  const expected = field != null && meta?.[field] != null ? Math.round(meta[field]) : null;
  if (expected == null) return true;
  const found = (text.match(/-?\d+(\.\d+)?/g) || []).map(s => Math.round(parseFloat(s)));
  return found.includes(expected);
}

// A sentence can pass every other gate and still fail the reader who only
// gets through half of it (truncated in a notification, skimmed, cut off by
// a screen reader interruption) — the standard isn't "does the action come
// first," it's "is the decision-relevant information (a number or a
// concrete recommendation) present by the midpoint," so the sentence still
// works if it's cut there.
const DECISION_WORDS = /\b(bring|take|wear|dress|trust|skip|bundle|layer|umbrella|worth|grab|pack)\b/i;
export function buriesPayoff(text) {
  if (!text) return true;
  const mid = Math.ceil(text.length / 2);
  const firstHalf = text.slice(0, mid);
  return !(/\d/.test(firstHalf) || DECISION_WORDS.test(firstHalf));
}

// Full validation gate for a Gemini-phrased line. All five must pass or the
// caller must discard the line and keep the deterministic template — no
// retry (a rejected line re-prompted back to the model tends to come back
// either over-hedged or stranger, not better; discard-and-fall-back is safer
// than a second generation attempt).
export function validateGeminiLine(text, selected, tMax) {
  if (!text || typeof text !== 'string') return { ok: false, reason: 'empty' };
  const violations = bandViolations(tMax, text);
  if (violations.length) return { ok: false, reason: `band:${violations.join('/')}` };
  try { assertNotSelfEvident(text); } catch { return { ok: false, reason: 'self-evident' }; }
  if (!geminiNumbersMatch(text, selected.key, selected.meta)) {
    return { ok: false, reason: 'number-drift' };
  }
  if (buriesPayoff(text)) {
    return { ok: false, reason: 'buries-payoff' };
  }
  return { ok: true };
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
const COLD_WORDING_BANDS = new Set(['chilly', 'cold', 'nearFreezing', 'freezing']);
export function coldWordingAccurate(temp) {
  return COLD_WORDING_BANDS.has(bandForTemp(temp).name);
}

// ---- HTML fragment helpers (presentation only, no weather logic) ----
// Unified pill component (Figma "Pill system"): standard (static), expandable
// (button, opens a detail card) and warning (expandable, coral). The detail
// card content comes from pillDetailHTML() and is shown by index.html.
const CHEV = '<svg class="pill-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>';
const pillIcon = (name) => `<span class="pi" aria-hidden="true">${name}</span>`;
// kind: 'std' | 'exp' | 'warn'. key: detail id (exp/warn only).
export function pill({ kind = 'std', icon, value, key = '', label = '' }) {
  if (kind === 'std') return `<span class="pill">${pillIcon(icon)}<span class="pv">${value}</span></span>`;
  const cls = kind === 'warn' ? 'pill pill-x pill-warn' : 'pill pill-x';
  const aria = label ? ` aria-label="${label}"` : '';
  return `<button type="button" class="${cls}" data-pill="${key}" aria-expanded="false"${aria}>${pillIcon(icon)}<span class="pv">${value}</span>${CHEV}</button>`;
}
const deltaPill = (diff, unit) => pill({ kind: 'exp', icon: diff > 0 ? 'thermometer_gain' : diff < 0 ? 'thermometer_loss' : 'drag_handle', value: formatDelta(Math.abs(diff), unit), key: 'change', label: `${formatDelta(Math.abs(diff), unit)} ${diff > 0 ? 'warmer' : 'cooler'} than yesterday, details` });
const eveningPill = (temp, unit) => pill({ kind: 'std', icon: 'wb_twilight', value: formatTemperature(temp, unit || 'C') });
const windPill = (kmh, label) => pill({ kind: 'exp', icon: 'air', value: `${kmh}km/h`, key: 'wind', label: label || `Wind ${kmh}km/h, details` });
const feelsPill = (p) => pill({ kind: 'exp', icon: p.feels >= (p.nowTemp ?? p.tMax) ? 'heat' : 'thermostat', value: formatTemperature(p.feels, p.temperatureUnit), key: 'feels', label: 'Feels-like temperature, details' });
const feelsPillAt = (value, unit, label, key) => pill({ kind: 'exp', icon: value >= 20 ? 'heat' : 'thermostat', value: formatTemperature(value, unit), key, label });

// Pollen thresholds (grains/m³), per species: grass/birch cutoffs are UK Met
// Office published high-range thresholds; alder/mugwort/olive/ragweed are
// approximations from general aeroallergen literature, not verified per-species
// cutoffs. UV bands are WHO categories, air quality bands the European AQI
// (EEA), wind bands follow the Beaufort descriptions (see DAY MESSAGE below).
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

// Searches forward from *now*, never from midnight — searching from hour 0
// meant an all-day-high-probability rain series always matched hour 0 first,
// so two cities with completely different actual timing both got "12am."
// If it's already raining now, a start time would be wrong (it already
// started) — this looks for when it *clears* instead; if it doesn't clear
// within the rest of the day, there's no honest hour to name at all.
function findRainTiming(context) {
  const nowHour = context?.nowHour ?? (context?.now instanceof Date ? context.now.getHours() : null);
  const ev = findRainEvent(context?.rainSeries, nowHour);
  if (!ev) return null;
  return {
    phase: ev.phase,
    // starting: the hour it begins; clearing: the hour it stops; ongoing: none.
    label: ev.phase === 'starting' ? formatHourLabel(ev.startHour) : ev.phase === 'clearing' ? formatHourLabel(ev.endHour) : null,
    // Series hours 24+ are tomorrow: the action line must not read as "today".
    // Daytime: anything from midnight on is tomorrow's. Evening and night:
    // rain from midnight to 4am is tonight's, from 5am on tomorrow's.
    nextDay: ev.phase === 'starting' && ev.startHour >= (context?.band === 'EVENING' || context?.band === 'NIGHT' ? 29 : 24),
    probability: ev.startProb,
    peak: ev.peak,
    level: ev.level,
    type: ev.type || 'rain',
    nearLevel: ev.nearLevel || ev.level,
    heavyLaterHour: ev.heavyLaterHour ?? null,
    // Snow that lies: the event's own total, or everything falling in the
    // hours ahead if that is more (a dusting now plus more overnight).
    snowCm: Math.max(ev.snowCm ?? 0, ev.type === 'snow' || ev.snowHours ? (context?.ahead?.snowCm ?? 0) : 0),
    snowHours: ev.snowHours ?? 0,
    startHour: ev.startHour,
    endHour: ev.endHour,
  };
}
const pollenLabel = species => species.charAt(0).toUpperCase() + species.slice(1);

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
  // Blank text used to pass silently — ''.includes(anyBannedPhrase) is
  // always false, so an empty translateCandidate() output was accepted as
  // "selected" instead of being disqualified and falling through to the
  // next candidate (the London bug: precipitationTiming's own copy was
  // fine, but a candidate that legitimately had nothing to add still needs
  // this same disqualify-and-retry path, not a silent accept).
  if (!text || !text.trim()) {
    throw new Error('advice text is empty');
  }
  const lower = text.toLowerCase();
  const hit = SELF_EVIDENT_PHRASES.find(p => lower.includes(p));
  if (hit) throw new Error(`self-evident phrase "${hit}" in advice text: "${text}"`);
  if (lower.includes('wear sunscreen') && !/\d/.test(text)) {
    throw new Error(`self-evident phrase "wear sunscreen" (no concrete number) in advice text: "${text}"`);
  }
}

// EVENING/NIGHT read the evening-drop framing off tomorrow morning instead
// of today's fixed evening slot — by then today's evening has either already
// happened or is about to, never upcoming. Shared by buildProse and
// coveredHeadlineTopics below so the two branch conditions can't drift out
// of sync (see the dedup comment on coveredHeadlineTopics).
function nextWindowTemp(p) {
  if (p.band === 'NIGHT') return { temp: p.todayMorningTemp ?? null, when: 'this morning' };
  const nightFrame = p.band === 'EVENING';
  if (nightFrame && p.tomorrowMorningTemp != null) return { temp: p.tomorrowMorningTemp, when: 'tomorrow morning' };
  return { temp: p.slots?.[2]?.temp ?? null, when: null };
}

// ============================================================================
// DAY MESSAGE — what the day screen and the city card say.
//
// One decision, two outputs: buildProse() renders it for the day screen and
// cardSentence() shortens the same decision for the city card, so the two
// can never say different things.
//
// Rules (from the random-city test criteria, Nov 2026):
//   C1 snow is called snow, and settling snow is announced with its amount.
//   C2 strength words describe the next hours; a heavier spell later gets
//      its own time.
//   C4 numbers live in pills, not in sentences (clock times are fine).
//   C5 a warning pill shows the number that proves the warning.
//   C6 the action line never repeats the headline; hard numbers (UV, air
//      quality, pollen, wind) open a scale from low to high.
//   C7 everything that will get in the way of the day ahead is mentioned:
//      the lead and its action, then the next most important item as a
//      second sentence, then the rest as pills.
// ============================================================================

const HEAT_ALERT_ACTION = 'Keep out of the midday sun, and drink more water than usual.';
const COLD_ALERT_ACTION = 'Cover hands and face, and keep outdoor trips short.';
const WIND_ALERT_ACTION = 'Stay in if you can, and avoid loose objects, trees, and coastal areas outside.';
const ICE_ALERT_ACTION = 'Watch for icy patches on roads, steps, and bridges, and give yourself extra time to get around.';
const STORM_ALERT_ACTION = 'Head indoors when you hear thunder, and steer clear of open areas, tall trees, and metal railings.';

// Series hours run 0-23 today, 24+ tomorrow (see weather-data.js).
function whenWord(hour, p) {
  if (hour == null) return 'today';
  if (hour >= 24) return hour - 24 < 10 ? 'tomorrow morning' : 'tomorrow';
  const h = hour % 24;
  return h >= 18 || (h < 5 && p?.band === 'NIGHT') ? 'tonight' : 'today';
}

const seriesOf = p => (Array.isArray(p.rainSeries) ? p.rainSeries : []);
function inWindow(p, hour) {
  const pt = seriesOf(p).find(x => x.hour === hour);
  return pt ? !!pt.inWindow : false;
}

// ---- P1: safety alerts. Read across the hours ahead (p.ahead), not just now,
// so tonight's freeze or tomorrow's storm is known before leaving the house.
export function alertForConditions(p) {
  const A = p.ahead || {};
  const unit = p.temperatureUnit;
  const fMax = A.feelsMax?.value ?? p.feels;
  const fMin = A.feelsMin?.value ?? p.feels;
  const gust = A.gustMax?.value ?? (p.gust != null ? Math.round(p.gust) : p.wind);
  if (fMax >= 36) {
    const when = whenWord(A.feelsMax?.hour, p);
    return { kind: 'heat', icon: 'heat', headline: `Dangerous heat ${when}`, action: HEAT_ALERT_ACTION, value: formatTemperature(fMax, unit), raw: fMax, card: 'Plan around the heat.' };
  }
  if (fMin <= -10) {
    const when = whenWord(A.feelsMin?.hour, p);
    return { kind: 'freeze', icon: 'ac_unit', headline: `A hard freeze ${when}`, action: COLD_ALERT_ACTION, value: formatTemperature(fMin, unit), raw: fMin, card: 'Hard freeze — bundle up.' };
  }
  if (gust >= 60) {
    const when = whenWord(A.gustMax?.hour, p);
    return { kind: 'wind', icon: 'air', headline: `Strong winds ${when}`, action: WIND_ALERT_ACTION, value: `${gust}km/h`, raw: gust, card: 'Strong wind — stay in if you can.' };
  }
  // Ice: freezing rain, or rain/sleet falling while the air sits near 0°C.
  // Snow on its own is announced as snow (see the precipitation lead).
  const ev = findRainTiming(p);
  const evInWindow = ev && inWindow(p, ev.startHour);
  const low = A.tLow ?? p.nowTemp ?? p.tMax;
  const wetNearZero = evInWindow && ev.type !== 'snow' && low != null && low <= 1;
  const legacyIce = !Array.isArray(p.rainSeries) && p.feels <= 3 && (p.precip ?? ((p.maxRain ?? 0) >= 50));
  if (A.freezingRain || wetNearZero || legacyIce) {
    const when = ev ? whenWord(ev.startHour, p) : 'today';
    return { kind: 'ice', icon: 'snowflake', headline: `Icy surfaces possible ${when}`, action: ICE_ALERT_ACTION, value: formatTemperature(low ?? p.feels, unit), raw: low, card: 'Watch for ice underfoot.' };
  }
  const storm = A.thunder || (!p.ahead && p.tCode >= 95 && p.tCode <= 99 ? { hour: null } : null);
  if (storm) {
    const from = storm.hour != null && storm.hour > p.nowHour ? `from ${formatHourLabel(storm.hour)}` : whenWord(storm.hour, p);
    return { kind: 'storm', icon: 'thunderstorm', headline: `Thunderstorms possible ${from}`, action: STORM_ALERT_ACTION, value: storm.hour != null ? formatHourLabel(storm.hour % 24) : 'Today', raw: storm.chance, card: 'Storms ahead — plan to be indoors.' };
  }
  return null;
}

// ---- Precipitation lead ----
// Snow from about 1cm (0.8 rounds to 1) lies on the ground: say it settles.
const SNOW_SETTLES_CM = 0.8;
const PRECIP_NOUN = {
  rain: { drizzle: 'Drizzle', rain: 'Rain', heavy: 'Heavy rain' },
  snow: { drizzle: 'Light snow', rain: 'Snow', heavy: 'Heavy snow' },
  sleet: { drizzle: 'Sleet', rain: 'Sleet', heavy: 'Heavy sleet' },
  freezing: { drizzle: 'Freezing rain', rain: 'Freezing rain', heavy: 'Freezing rain' },
};
function precipHeadline(t) {
  let noun = PRECIP_NOUN[t.type || 'rain'][t.nearLevel || t.level] || 'Rain';
  // Mixed events: rain or sleet with some hours of snow say both.
  if ((t.type === 'rain' || t.type === 'sleet') && t.snowHours > 0) noun = `${noun} and snow`;
  const when = t.phase === 'starting' ? `from ${t.label}` : t.phase === 'clearing' ? `until ${t.label}` : 'for hours';
  return { noun, when };
}
function precipPill(t) {
  if (t.type === 'snow' || (t.snowHours > 0 && t.snowCm >= SNOW_SETTLES_CM)) {
    const settles = t.snowCm >= SNOW_SETTLES_CM, cm = Math.max(1, Math.round(t.snowCm));
    return pill({ kind: 'exp', icon: 'weather_snowy', value: settles ? `${cm}cm` : `${Math.round(t.peak)}%`, key: 'snow', label: settles ? `About ${cm}cm of snow, details` : 'Snow chance, details' });
  }
  return pill({ kind: 'exp', icon: 'water_drop', value: `${Math.round(t.peak)}%`, key: 'rain', label: 'Rain chance, hourly chart' });
}
// What to do about it. No numbers here: the pill carries them.
function precipAction(t) {
  const later = t.heavyLaterHour != null ? ` It gets heavier around ${formatHourLabel(t.heavyLaterHour)}.` : '';
  if (t.type === 'snow') {
    if (t.nextDay) return 'Dry for now — boots with grip for tomorrow.';
    return (t.snowCm >= SNOW_SETTLES_CM ? 'It will settle — wear boots with grip and give yourself extra time.' : 'A light dusting — mind slippery steps.') + later;
  }
  const mixedSettles = t.snowHours > 0 && t.snowCm >= SNOW_SETTLES_CM ? ' Snow may settle.' : '';
  if (t.type === 'sleet') return (t.nextDay ? 'Dry for now — waterproof shoes for tomorrow.' : 'Wet and slushy — waterproof shoes and an umbrella.') + mixedSettles + later;
  if (mixedSettles && !t.nextDay) return 'Take an umbrella, and shoes with grip.' + mixedSettles + later;
  if (t.type === 'freezing') return 'Roads and steps can glaze over — careful footing and extra time.';
  if (t.nextDay) return t.nearLevel === 'drizzle' ? 'Dry today. A hood will do tomorrow.' : 'Dry today. Pack an umbrella for tomorrow.';
  if (t.nearLevel === 'drizzle') return 'Just a few drops — a hood will do.' + later;
  if (t.nearLevel === 'heavy') return 'Take a sturdy umbrella, and waterproof shoes if you can.';
  return 'Take an umbrella.' + later;
}
function precipCard(t) {
  if (t.type === 'snow') return t.nextDay ? 'Snow tomorrow — boots with grip.' : t.snowCm >= SNOW_SETTLES_CM ? 'Snow — boots with grip.' : 'Light snow — mind your step.';
  if (t.type === 'sleet') return t.nextDay ? 'Sleet tomorrow — waterproof shoes.' : 'Sleet — umbrella and waterproof shoes.';
  if (t.type === 'freezing') return 'Freezing rain — mind the ice.';
  if (t.nextDay) return t.nearLevel === 'drizzle' ? 'Dry today, drizzle tomorrow.' : 'Dry today, umbrella tomorrow.';
  const { noun, when } = precipHeadline(t);
  return `${noun} ${when} — ${t.nearLevel === 'drizzle' ? 'a hood will do.' : 'take an umbrella.'}`;
}

// ---- Heads-up notes: everything else worth knowing before heading out ----
// prio >= 50 must be mentioned (sentence or pill); lower ones only fill an
// empty action line.
const UV_BANDS = [{ to: 3, label: 'Low' }, { to: 6, label: 'Moderate' }, { to: 8, label: 'High' }, { to: 11, label: 'Very high' }, { to: Infinity, label: 'Extreme' }];
const AQI_BANDS = [{ to: 20, label: 'Good' }, { to: 40, label: 'Fair' }, { to: 60, label: 'Moderate' }, { to: 80, label: 'Poor' }, { to: 100, label: 'Very poor' }, { to: Infinity, label: 'Extremely poor' }];
const WIND_BANDS = [{ to: 20, label: 'Light' }, { to: 39, label: 'Breezy' }, { to: 50, label: 'Windy' }, { to: 62, label: 'Very windy' }, { to: 89, label: 'Gale' }, { to: Infinity, label: 'Storm' }];
const SNOW_BANDS = [{ to: 1, label: 'Dusting' }, { to: 5, label: 'Settles' }, { to: 15, label: 'Heavy' }, { to: Infinity, label: 'Very heavy' }];
const bandLabel = (bands, v) => bands.find(b => v < b.to)?.label;

function pollenTop(p) {
  let best = null;
  for (const [species, v] of Object.entries(p.pollenSpecies || {})) {
    if (v == null) continue;
    const hit = (POLLEN_SPECIES_BANDS[species] || []).find(b => v >= b.min && v < b.max);
    if (hit && (!best || hit.salience > best.salience)) best = { species, value: v, tier: hit.tier, salience: hit.salience };
  }
  return best;
}

export function headsUp(p, lead) {
  const A = p.ahead || {};
  const unit = p.temperatureUnit;
  const notes = [];
  const add = n => notes.push(n);
  const ev = findRainTiming(p);
  const skip = new Set(lead?.covers || []);
  // A note says "tonight"/"tomorrow morning" only if the headline did not already.
  const said = (lead?.text || '').toLowerCase();
  const when = h => { const w = whenWord(h, p); return said.includes(w) ? '' : ` ${w}`; };

  if (A.thunder && !skip.has('storm')) {
    add({ key: 'storm', prio: 95, text: `Thunder possible from ${formatHourLabel(A.thunder.hour)} — head indoors when it rumbles.`, pill: pill({ kind: 'exp', icon: 'thunderstorm', value: formatHourLabel(A.thunder.hour % 24), key: 'storm', label: 'Thunderstorm timing, details' }), card: 'Storms ahead — plan to be indoors.' });
  }
  if (ev && !skip.has('precip') && inWindow(p, ev.startHour)) {
    add({ key: 'precip', prio: 90, text: precipCard(ev), pill: precipPill(ev), card: precipCard(ev) });
  }
  const gust = A.gustMax?.value ?? (p.gust != null ? Math.round(p.gust) : null);
  if (gust != null && gust >= 39 && gust < 60 && !skip.has('wind')) {
    add({ key: 'wind', prio: gust >= 50 ? 70 : 30, text: `Gusty${when(A.gustMax?.hour)} — ${ev ? "umbrellas won't hold up well; " : ''}a windproof layer helps.`, pill: windPill(gust, `Gusts to ${gust}km/h, details`), card: 'Gusty — hold onto your hat.' });
  }
  const fMax = A.feelsMax?.value ?? null;
  if (fMax != null && fMax >= 32 && fMax < 36 && !skip.has('heat')) {
    add({ key: 'heat', prio: 65, text: `Hot${when(A.feelsMax.hour)} — save long walks for the cooler hours.`, pill: feelsPillAt(fMax, unit, `Feels like ${formatTemperature(fMax, unit)} at its hottest, details`, 'feelsHigh'), card: 'Hot — keep to the shade.' });
  }
  const fMin = A.feelsMin?.value ?? null;
  if (fMin != null && fMin <= -5 && fMin > -10 && !skip.has('cold')) {
    add({ key: 'cold', prio: 65, text: `Bitter cold${when(A.feelsMin.hour)} — hat and gloves.`, pill: feelsPillAt(fMin, unit, `Feels like ${formatTemperature(fMin, unit)} at its coldest, bitter cold, details`, 'feelsLow'), card: 'Bitter cold — hat and gloves.' });
  }
  if ((A.swing ?? 0) >= 10 && !skip.has('swing')) {
    // Which way the swing runs from now: a sharp drop after the day's high,
    // or a cold start that warms up a lot by the afternoon.
    const pts = seriesOf(p).filter(x => x.inWindow && Number.isFinite(x.t));
    const hi = pts.reduce((a, b) => (b.t > a.t ? b : a), pts[0]);
    const after = pts.filter(x => x.hour > hi.hour);
    const lowAfter = after.length ? after.reduce((a, b) => (b.t < a.t ? b : a), after[0]) : null;
    const nowT = pts[0].t;
    // Only worth a layer when the cool end really is cool (below about 17°C).
    if (lowAfter && hi.t - lowAfter.t >= 8 && lowAfter.t < 17) {
      const when = lowAfter.hour >= 24 ? 'by morning' : lowAfter.hour % 24 >= 18 ? 'tonight' : 'later';
      add({ key: 'swing', prio: 60, text: `Drops sharply ${when} — bring a layer for later.`, pill: eveningPill(Math.round(lowAfter.t), unit), card: 'Layer up for later.' });
    } else if (hi.hour > p.nowHour && hi.t - nowT >= 8 && nowT < 17) {
      add({ key: 'swing', prio: 60, text: `Warms up a lot by ${hi.hour >= 24 ? 'tomorrow ' : ''}${hi.hour % 24 < 12 ? 'late morning' : 'the afternoon'} — wear layers you can take off later.`, pill: pill({ kind: 'std', icon: 'trending_up', value: formatTemperature(Math.round(hi.t), unit) }), card: 'Cool start, warm later — wear layers.' });
    }
  }
  const aqi = p.europeanAqi;
  if (aqi != null && aqi >= 40) {
    const tier = aqi >= 100 ? 'extremelyPoor' : aqi >= 80 ? 'veryPoor' : aqi >= 60 ? 'poor' : 'moderate';
    const text = {
      moderate: "Air's moderate — fine for a walk; ease off hard workouts outside.",
      poor: 'Air quality is poor — move intense workouts indoors.',
      veryPoor: 'Air quality is very poor — skip strenuous exercise outside.',
      extremelyPoor: 'Air quality is extremely poor — keep time outdoors short.',
    }[tier];
    add({ key: 'aqi', prio: aqi >= 60 ? 55 : 20, text, pill: pill({ kind: 'exp', icon: 'masks', value: `AQI ${Math.round(aqi)}`, key: 'aqi', label: `Air quality ${Math.round(aqi)}, details` }), card: aqi >= 100 ? 'Very poor air — keep outdoor time short.' : aqi >= 60 ? 'Poor air — go easy outdoors.' : 'Air is so-so — go easy on hard runs.' });
  }
  // Tiers use the rounded value, the same number the pill shows.
  const uvRaw = A.uvMax?.value ?? (p.uvIndex ?? null);
  const uv = uvRaw == null ? null : Math.round(uvRaw);
  if (uv != null && uv >= 6) {
    const tomorrow = (A.uvMax?.hour ?? 0) >= 24;
    const text = uv >= 8
      ? `Sunscreen and a hat ${tomorrow ? 'tomorrow' : 'today'} — skin burns fast at midday.`
      : `Some shade around midday helps ${tomorrow ? 'tomorrow' : 'today'}.`;
    add({ key: 'uv', prio: uv >= 8 ? 50 : 25, text, pill: pill({ kind: 'exp', icon: 'sunny', value: `UV ${Math.round(uv)}`, key: 'uv', label: `UV index ${Math.round(uv)}, details` }), card: uv >= 8 ? 'Sunscreen and a hat today.' : 'UV is up — some shade at midday helps.' });
  }
  const pol = pollenTop(p);
  if (pol) {
    const name = pollenLabel(pol.species);
    const text = pol.tier === 'moderate' ? `${name} pollen is creeping up — could irritate allergies.` : `${name} pollen is ${pol.tier === 'veryHigh' ? 'very high' : 'high'} — take your antihistamine before heading out.`;
    add({ key: 'pollen', prio: pol.tier === 'moderate' ? 15 : 50, text, pill: pill({ kind: 'exp', icon: 'local_florist', value: `${name} ${pol.tier === 'veryHigh' ? 'very high' : pol.tier}`, key: 'pollen', label: `${name} pollen ${pol.tier}, details` }), card: 'Pollen is up — take your antihistamine.' });
  }
  // Low-priority fillers: they only take an empty action line.
  const air = p.nowTemp ?? p.tMax;
  if (p.feels != null && air != null && Math.abs(p.feels - air) >= 4 && !skip.has('feels')) {
    add({ key: 'feels', prio: 10, text: p.feels < air ? 'Feels colder than it reads — dress for the feel.' : 'Feels warmer than it reads — dress light.', pill: feelsPill(p), card: p.feels < air ? 'Dress for the chill.' : 'Dress light.' });
  }
  return notes.sort((a, b) => b.prio - a.prio);
}

// ---- Temperature lead (no event, no alert) ----
// "much colder", "a touch cooler"...: one wording for the headline and the card.
function changeWord(p) {
  const { diff } = p;
  const cold = coldWordingAccurate(p.tMax);
  return diff >= 6 ? 'much warmer' : diff >= 3 ? 'warmer' : diff >= 2 ? 'a bit warmer'
    : diff <= -6 ? (cold ? 'much colder' : 'much cooler')
    : diff <= -3 ? (cold ? 'colder' : 'cooler')
    : (cold ? 'a bit colder' : 'a touch cooler');
}
function temperatureLines(p, used) {
  const { diff, feels, tMax, wind } = p;
  const unit = p.temperatureUnit;
  const { temp: eTemp, when: eWhen } = nextWindowTemp(p);
  // Overnight the "next window" is this morning, which can be warmer than
  // now: only call it a drop when it is actually lower than the air now.
  const eDrop = eTemp == null ? 0 : p.band === 'NIGHT' && eTemp >= (p.nowTemp ?? tMax) - 2 ? 0 : tMax - eTemp;
  const abs = Math.abs(diff);
  const dChip = diff === 0 ? '' : deltaPill(diff, unit);
  let html;
  if (abs >= 2) {
    html = `<span class="g">It's </span><span class="w">${changeWord(p)}</span><span class="g"> than yesterday</span>${dChip}`;
  } else {
    html = `<span class="w">${diff === 0 ? 'Same' : 'Similar'}</span><span class="g"> ${diff === 0 ? 'as' : 'to'} yesterday</span>${dChip}`;
  }
  if (eDrop >= 5 && eTemp != null) {
    used.add('swing');
    // Same direction as a colder headline: "and", not "but".
    html += `<br><span class="g">${diff < 0 ? 'and' : 'but'} </span><span class="w">${bandForTemp(eTemp).eveningPhrase}</span><span class="g"> ${eWhen || 'in the evening'}</span>${eveningPill(eTemp, unit)}`;
  } else if (wind >= 25 || (p.gust ?? 0) >= 39) {
    used.add('wind');
    const g = Math.round(Math.max(p.gust ?? 0, wind));
    html += `<br><span class="g">but </span><span class="w">windier</span><span class="g"> today</span>${windPill(g, `Wind up to ${g}km/h, details`)}`;
  } else if (feels != null && feels <= (p.nowTemp ?? tMax) - 4) {
    used.add('feels');
    html += diff < 0
      ? `<br><span class="g">and the </span><span class="w">wind chill</span><span class="g"> bites</span>${feelsPill(p)}`
      : `<br><span class="g">but feels </span><span class="w">colder</span><span class="g"> with wind chill</span>${feelsPill(p)}`;
  } else if (feels != null && !((p.ahead?.feelsMax?.value ?? -99) >= 32 || (p.ahead?.feelsMin?.value ?? 99) <= -5)) {
    // (a heat or cold note says this more usefully in the action line)
    html += `<br><span class="g">feels </span><span class="w">${bandForTemp(feels).adjective}</span><span class="g"> out.</span>`;
  }
  return html;
}

function neutralCard(p) {
  const feels = Number.isFinite(p.feels) ? p.feels : p.nowTemp;
  if (feels <= 0) return 'Hat and gloves weather.';
  if (feels <= 8) return 'Pack your jacket.';
  if (feels <= 15) return 'Bring a light jacket.';
  if (feels >= 22) return 'T-shirt weather.';
  return 'Nothing special needed.';
}

// Card for a temperature-led day: it repeats the headline's comparison when
// that is the news, and adds the most pressing heads-up if there is one.
function temperatureCard(p, notes) {
  const top = notes[0];
  // Same word as the headline: "colder" only where cold wording is accurate.
  const base = Math.abs(p.diff) >= 2 ? `${changeWord(p).replace(/^\w/, c => c.toUpperCase())} than yesterday` : null;
  if (base && top && top.prio >= 60) {
    const [head, tail] = top.card.split(' — ');
    return tail ? `${base}, ${head.toLowerCase()} — ${tail}` : `${base} — ${top.card.toLowerCase()}`;
  }
  // "Dress lighter" only when it is actually mild; a warmer but still cold
  // day keeps the clothing line it would get anyway.
  // The clothing half follows the actual feel: "layer up" only when it is
  // cool, "dress lighter" only when it is mild, otherwise the usual line.
  if (base) {
    const feel = p.feels ?? p.nowTemp;
    const tail = p.diff < 0 && feel < 15 ? 'layer up.' : p.diff > 0 && feel >= 18 ? 'dress lighter.' : neutralCard(p).replace(/^(?!T-shirt)\w/, c => c.toLowerCase());
    return `${base} — ${tail}`;
  }
  if (top) return top.card;
  return neutralCard(p);
}

// The one decision both screens use.
export function decideDay(p) {
  const unit = p.temperatureUnit;
  const alert = alertForConditions(p);
  const ev = findRainTiming(p);
  const used = new Set();
  const lines = [];
  let action = '', card = '', lead = 'temperature';

  if (alert) {
    lead = alert.kind;
    used.add(alert.kind === 'ice' || alert.kind === 'storm' ? 'precip' : alert.kind);
    if (alert.kind === 'freeze') used.add('cold');
    if (alert.kind === 'storm') used.add('storm');
    lines.push(`<span class="w">${alert.headline}</span>${pill({ kind: 'warn', icon: alert.icon, value: alert.value, key: `warn:${alert.kind}`, label: `${alert.headline}, details` })}`);
    action = alert.action;
    card = alert.card;
    if (alert.kind === 'ice' && ev) {
      const { noun, when } = precipHeadline(ev);
      lines.push(`<span class="g">${noun} </span><span class="w">${when}</span>${precipPill(ev)}`);
    }
    const against = (alert.kind === 'freeze' && p.diff > 0) || (alert.kind === 'heat' && p.diff < 0);
    if (Math.abs(p.diff) >= 3) lines.push(`<span class="g">${against ? 'but' : 'and'} </span><span class="w">${p.diff > 0 ? 'warmer' : coldWordingAccurate(p.tMax) ? 'colder' : 'cooler'}</span><span class="g"> than yesterday</span>${deltaPill(p.diff, unit)}`);
  } else if (ev) {
    lead = 'precip';
    used.add('precip');
    const { noun, when } = precipHeadline(ev);
    let l1 = `<span class="g">${noun} </span><span class="w">${when}</span>${precipPill(ev)}`;
    if (Math.abs(p.diff) >= 3) l1 += ` <span class="g">and ${p.diff > 0 ? 'warmer' : coldWordingAccurate(p.tMax) ? 'colder' : 'cooler'} than yesterday</span>${deltaPill(p.diff, unit)}`;
    lines.push(l1);
    action = precipAction(ev);
    card = precipCard(ev);
  } else if (!Array.isArray(p.rainSeries) && (p.maxRain ?? 0) > 40) {
    // No hourly series (old cache): state the chance without inventing an hour.
    lead = 'precip';
    used.add('precip');
    lines.push(`<span class="g">Rain </span><span class="w">${p.maxRain > 85 ? 'coming' : p.maxRain > 70 ? 'likely' : 'possible'}</span>${pill({ kind: 'std', icon: 'water_drop', value: `${Math.round(p.maxRain)}%` })}`);
    action = p.maxRain >= 60 ? 'Bring an umbrella.' : 'An umbrella might be worth it.';
    card = 'Keep an umbrella close.';
  } else {
    lines.push(temperatureLines(p, used));
  }

  const notes = headsUp(p, { covers: [...used], text: lines.join(' ').replace(/<[^>]+>/g, ' ') });
  // The action line holds at most two sentences: the lead's own action and
  // the most pressing note, or (temperature lead) the two most pressing
  // notes. Every other must-mention note still shows as a pill.
  const said = [], extra = [];
  const room = action ? 1 : 2;
  for (const n of notes) {
    if (said.length < room && (n.prio >= 50 || (!action && !said.length))) { said.push(n); continue; }
    if (n.prio >= 50) extra.push(n);
  }
  // The lead's action is the big line; any further sentence is set smaller.
  const texts = [action, ...said.map(n => n.text)].filter(Boolean);
  const actionHTML = texts[0] || '';
  const moreHTML = texts.slice(1).join(' ');
  if (!card) card = temperatureCard(p, notes);
  // A pill that would repeat one already in the headline (same icon and value) is dropped.
  const shown = new Set([...lines.join('').matchAll(/<span class="pi"[^>]*>([^<]*)<\/span><span class="pv">([^<]*)</g)].map(m => m[1] + m[2]));
  const pills = [...said, ...extra].map(n => n.pill).filter(Boolean).filter(h => {
    const m = /<span class="pi"[^>]*>([^<]*)<\/span><span class="pv">([^<]*)</.exec(h);
    return !m || !shown.has(m[1] + m[2]);
  }).join('');
  return { lead, lines, action: actionHTML, more: moreHTML, pills, card, notes };
}

export function buildProse(p) {
  const d = decideDay(p);
  const actionPart = d.action || d.pills
    ? `<br><span class="action">${d.action}</span>${d.more ? `<span class="action-more">${d.more}</span>` : ''}${d.pills ? `<span class="pill-row">${d.pills}</span>` : ''}`
    : '';
  return { html: d.lines.join('<br>') + actionPart, action: [d.action, d.more].filter(Boolean).join(' '), selected: null, card: d.card };
}

export const cardSentence = p => decideDay(p).card;

// ---- Pill detail cards (shown by index.html when an expandable pill opens) ----
// Each card answers one question the pill raises, without repeating the
// headline sentence: exact numbers, what the number means, one picture.
const row = (label, value) => `<div class="pd-row"><span>${label}</span><span>${value}</span></div>`;
// Two-point comparison: hollow dot = reference (yesterday / air temp), filled = now / feels.
const compareViz = (ref, cur, tone) => {
  const lo = Math.min(ref, cur), hi = Math.max(ref, cur);
  const pos = v => (hi === lo ? 50 : 8 + (84 * (v - lo)) / (hi - lo));
  return `<div class="pd-viz pd-${tone}" aria-hidden="true"><i class="pd-seg" style="left:${Math.min(pos(ref), pos(cur))}%;width:${Math.abs(pos(cur) - pos(ref))}%"></i><i class="pd-dot ref" style="left:${pos(ref)}%"></i><i class="pd-dot cur" style="left:${pos(cur)}%"></i></div>`;
};
// Low-to-high scale for numbers people can't read on their own (UV, air
// quality, pollen, wind, snow). Segments are equal width, one per band; the
// dot sits inside its band in proportion.
const scaleViz = (bands, value, name) => {
  const i = Math.max(0, bands.findIndex(b => value < b.to));
  const lo = i === 0 ? 0 : bands[i - 1].to;
  const hi = Number.isFinite(bands[i].to) ? bands[i].to : lo * 1.5 || lo + 1;
  const pos = ((i + Math.min(1, Math.max(0, (value - lo) / (hi - lo)))) / bands.length) * 100;
  const segs = bands.map((b, k) => `<i class="pd-scale-seg${k === i ? ' on' : ''}"></i>`).join('');
  return `<div class="pd-scale" role="img" aria-label="${name}: ${bands[i].label}, on a scale from ${bands[0].label} to ${bands.at(-1).label}"><div class="pd-scale-bar">${segs}<i class="pd-scale-dot" style="left:${pos.toFixed(1)}%"></i></div><div class="pd-scale-lbl"><span>${bands[0].label}</span><span>${bands.at(-1).label}</span></div></div>`;
};
// tone: 'up' (coral) | 'down' (blue) | 'flat' (text color). No sentences: title, numbers, picture.
const card = ({ title, rows, viz = '', why = '', tone = 'flat', warn = false }) =>
  `<p class="pd-title pd-t-${tone}${warn ? ' pd-title-warn' : ''}">${title}</p><div class="pd-rows${warn ? ' pd-rows-b' : ''}">${rows}</div>${viz}${why ? `<p class="pd-desc">${why}</p>` : ''}`;

const atHour = h => (h == null ? '—' : formatHourLabel(h));
const WARN_DETAIL = {
  heat: p => ({ title: 'Extreme heat · limit time outdoors', rows: row('Feels like, at its peak', formatTemperature(p.ahead?.feelsMax?.value ?? p.feels, p.temperatureUnit)) + row('Peak', atHour(p.ahead?.feelsMax?.hour)), why: 'Heat this strong strains the body, even when you are resting.' }),
  freeze: p => ({ title: 'Hard freeze · cover up', rows: row('Feels like, at its lowest', formatTemperature(p.ahead?.feelsMin?.value ?? p.feels, p.temperatureUnit)) + row('Air temperature now', formatTemperature(p.nowTemp ?? p.tMax, p.temperatureUnit)), why: 'Wind makes it feel much colder, and bare skin cools down fast.' }),
  wind: p => { const g = p.ahead?.gustMax?.value ?? (p.gust != null ? p.gust : p.wind); return { title: 'Strong wind · stay in if you can', rows: row('Gusts, at their strongest', `${Math.round(g)}km/h`) + row('Average wind now', `${Math.round(p.wind)}km/h`), viz: scaleViz(WIND_BANDS, g, 'Wind'), why: 'Wind this strong can bring down branches and make walking hard.' }; },
  ice: p => { const ev = findRainTiming(p); return { title: 'Ice · watch your step', rows: row('Air temperature, lowest', formatTemperature(p.ahead?.tLow ?? p.nowTemp, p.temperatureUnit)) + row('Precipitation', ev ? `${ev.type === 'freezing' ? 'Freezing rain' : ev.type === 'sleet' ? 'Sleet' : 'Rain'} · ${Math.round(ev.peak)}%` : 'Wet surfaces'), why: 'Wet roads and shaded spots can freeze, even a few degrees above 0°C.' }; },
  storm: p => ({ title: 'Thunderstorm · move indoors', rows: row('From', atHour(p.ahead?.thunder?.hour)) + (p.ahead?.thunder ? row('Rain chance', `${p.ahead.thunder.chance}%`) : ''), why: 'Lightning and sudden gusts can come with it.' }),
};

// Returns { html, warn } for a pill key, or null when there is nothing to show.
export function pillDetailHTML(key, p) {
  const unit = p.temperatureUnit;
  if (key.startsWith('warn:')) {
    const f = WARN_DETAIL[key.slice(5)];
    return f ? { html: card({ ...f(p), tone: 'up', warn: true }), warn: true } : null;
  }
  if (key === 'feels') {
    const air = p.nowTemp ?? p.tMax;
    const gap = p.feels - air;
    const word = gap >= 2 ? 'Feels warmer' : gap <= -2 ? 'Feels colder' : 'Feels about the same';
    const tone = gap >= 2 ? 'up' : gap <= -2 ? 'down' : 'flat';
    const rows = row('Air temperature', formatTemperature(air, unit)) + (Number.isFinite(p.wind) ? row('Wind', `${Math.round(p.wind)}km/h`) : '') + (Number.isFinite(p.humidity) ? row('Humidity', `${Math.round(p.humidity)}%`) : '');
    return { html: card({ title: `${formatTemperature(p.feels, unit)} · ${word}`, rows, viz: compareViz(air, p.feels, tone), tone }), warn: false };
  }
  if (key === 'feelsHigh' || key === 'feelsLow') {
    const hi = key === 'feelsHigh';
    const pt = hi ? p.ahead?.feelsMax : p.ahead?.feelsMin;
    if (!pt) return null;
    const at = seriesOf(p).find(x => x.hour === pt.hour);
    const air = at && Number.isFinite(at.t) ? Math.round(at.t) : null;
    const tone = hi ? 'up' : 'down';
    const rows = row(hi ? 'Hottest around' : 'Coldest around', atHour(pt.hour)) + (air != null ? row('Air temperature then', formatTemperature(air, unit)) : '');
    return { html: card({ title: `${formatTemperature(pt.value, unit)} · ${hi ? 'Feels hot' : 'Feels bitter'}`, rows, viz: air != null ? compareViz(air, pt.value, tone) : '', tone }), warn: false };
  }
  if (key === 'change') {
    const d = p.diff;
    const word = d > 0 ? 'warmer' : 'cooler';
    const tone = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    const hasY = Number.isFinite(p.yesterdayNowTemp);
    const rows = row('Now', formatTemperature(p.nowTemp, unit)) + (hasY ? row('Yesterday, same hour', formatTemperature(p.yesterdayNowTemp, unit)) : '');
    return { html: card({ title: d === 0 ? 'Same as yesterday' : `${formatDelta(Math.abs(d), unit)} ${word} than yesterday`, rows, viz: hasY ? compareViz(p.yesterdayNowTemp, p.nowTemp, tone) : '', tone }), warn: false };
  }
  if (key === 'uv') {
    const uv = p.ahead?.uvMax?.value ?? p.uvIndex;
    if (uv == null) return null;
    return { html: card({ title: `UV ${Math.round(uv)} · ${bandLabel(UV_BANDS, uv)}`, rows: row('Strongest around', atHour(p.ahead?.uvMax?.hour)) + row('Now', p.uvIndex != null ? String(Math.round(p.uvIndex)) : '—'), viz: scaleViz(UV_BANDS, uv, 'UV index') }), warn: false };
  }
  if (key === 'aqi') {
    const a = p.europeanAqi;
    if (a == null) return null;
    return { html: card({ title: `Air quality ${Math.round(a)} · ${bandLabel(AQI_BANDS, a)}`, rows: row('Index', 'European AQI'), viz: scaleViz(AQI_BANDS, a, 'Air quality') }), warn: false };
  }
  if (key === 'pollen') {
    const pol = pollenTop(p);
    if (!pol) return null;
    const bands = [{ to: POLLEN_SPECIES_BANDS[pol.species][0].min, label: 'Low' }, ...POLLEN_SPECIES_BANDS[pol.species].map(b => ({ to: b.max, label: b.tier === 'veryHigh' ? 'Very high' : b.tier[0].toUpperCase() + b.tier.slice(1) }))];
    return { html: card({ title: `${pollenLabel(pol.species)} pollen · ${bandLabel(bands, pol.value)}`, rows: row('Grains per m³', String(Math.round(pol.value))), viz: scaleViz(bands, pol.value, `${pollenLabel(pol.species)} pollen`) }), warn: false };
  }
  if (key === 'wind') {
    const g = p.ahead?.gustMax?.value ?? (p.gust != null ? Math.round(p.gust) : p.wind);
    return { html: card({ title: `Gusts ${g}km/h · ${bandLabel(WIND_BANDS, g)}`, rows: row('Strongest around', atHour(p.ahead?.gustMax?.hour)) + row('Average wind now', `${Math.round(p.wind)}km/h`), viz: scaleViz(WIND_BANDS, g, 'Wind') }), warn: false };
  }
  if (key === 'snow') {
    const ev = findRainTiming(p);
    if (!ev) return null;
    const cm = ev.snowCm;
    const span = ev.phase === 'starting' ? `From ${formatHourLabel(ev.startHour)}` : ev.phase === 'clearing' ? `Until ${formatHourLabel(ev.endHour)}` : 'For hours';
    return { html: card({ title: `${cm >= SNOW_SETTLES_CM ? `About ${Math.max(1, Math.round(cm))}cm` : 'Less than 1cm'} · ${bandLabel(SNOW_BANDS, cm)}`, rows: row('When', span) + row('Chance', `${Math.round(ev.peak)}%`), viz: scaleViz(SNOW_BANDS, cm, 'Snow') }), warn: false };
  }
  if (key === 'storm') return { html: card(WARN_DETAIL.storm(p)), warn: false };
  return null;
}

// The LOW model-consensus caption (rendered in index.html's #uaddon
// element) is a supplement to the action line above it, never a standalone
// message — it used to be written to its own DOM element independently of
// whether buildProse(p) actually produced an action sentence, so an hour
// where every score-pipeline candidate was legitimately disqualified (real
// London case: rain had already faded below findRainTiming's 40% cutoff
// with no future crossing left to name, and nothing else was salient that
// hour) left the caption floating with no body line above it. hasAction —
// whether the caller's buildProse(p) output actually included the action
// span — must be passed in explicitly, not re-derived here, so caption and
// action line can never drift out of sync again.
// RAIN_SPLIT used to get its own caption here too ("rain timing's
// uncertain. Bring it anyway.") but it fired on essentially every rainy
// day, so it read as boilerplate rather than real signal — dropped.
export function buildAddendum(p, hasAction) {
  if (!hasAction) return '';
  if (p.consensus === 'HIGH') return '';
  if (p.consensus === 'MEDIUM') return '';
  if (p.consensus === 'LOW') return `— forecasts disagree by about ${formatDelta(p.maxSpread, p.temperatureUnit)}. Keep a backup.`;
  return '';
}
