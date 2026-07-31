// ============================================================================
// Warmer — headline copy rules for index.html's buildProse().
//
// Two independent layers, kept structurally separate so one can never leak
// into the other:
//   - trend sentence   ("It's much warmer than yesterday") — reads `diff`
//     (delta vs. yesterday) only. Lives inline in buildProse().
//   - advice sentence  (garment/action line) and the evening line — read
//     absolute temperature, uv index, and humidity only, via TEMP_BANDS and
//     the priority chain in adviceForTemp(). Neither has a code path that
//     reads `diff`.
// ============================================================================

// Hot-band heat guidance tiers, shared between TEMP_BANDS.heatAdvice (temp-only
// lookup) and sunAndHydrationAdvice() below (temp-or-UV lookup), so the wording
// only lives in one place.
const HEAT_LIGHT_TEXT = "It's warm enough to take it easy — pace yourself, nothing dramatic.";
const HEAT_MID_TEXT = 'Avoid direct sun around midday and into the afternoon, and keep drinking water.';
const HEAT_STRONG_TEXT = "It's serious heat — stay out of the sun through midday and afternoon, and drink water often.";

export const TEMP_BANDS = [
  {
    name: 'hot', min: 30,
    adjective: 'hot',
    eveningPhrase: 'still hot, just a touch easier',
    garment: null, // >=30°C: garment talk is self-evident — say nothing rather than "wear short sleeves"
    // Heat guidance instead of clothing. Tiers ordered highest min first.
    heatAdvice: [
      { min: 38, text: HEAT_STRONG_TEXT },
      { min: 34, text: HEAT_MID_TEXT },
      { min: 30, text: HEAT_LIGHT_TEXT },
    ],
    bannedWords: ['chilly', 'cold', 'coat', 'jacket', 'short sleeves'],
  },
  {
    name: 'warm', min: 25,
    adjective: 'warm',
    eveningPhrase: 'still warm as it eases off',
    garment: 'Keep it light and stay hydrated.',
    bannedWords: ['chilly', 'cold', 'coat'],
  },
  {
    name: 'mild', min: 20,
    adjective: 'mild',
    eveningPhrase: 'turning mild',
    garment: 'A long-sleeve or light knit should do it.',
    bannedWords: ['coat', 'freezing'],
  },
  {
    name: 'cool', min: 15,
    adjective: 'cool',
    eveningPhrase: 'turning cool',
    garment: 'A light jacket or mid-layer is about right.',
    bannedWords: ['freezing'],
  },
  {
    name: 'chilly', min: 10,
    adjective: 'chilly',
    eveningPhrase: 'turning chilly',
    garment: 'A jacket keeps this comfortable.',
    bannedWords: [],
  },
  {
    name: 'cold', min: 5,
    adjective: 'quite cold',
    eveningPhrase: 'turning cold',
    garment: 'Coat weather — bundle up.',
    bannedWords: [],
  },
  {
    name: 'freezing', min: -Infinity,
    adjective: 'freezing',
    eveningPhrase: 'dropping toward freezing',
    garment: 'Full coat and layers — no skimping.',
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

// Heat guidance for the hot band's tiers. Temperature-only, never clothing.
export function heatAdviceForTemp(temp) {
  const band = bandForTemp(temp);
  if (!band.heatAdvice) return '';
  const tier = band.heatAdvice.find(h => temp >= h.min);
  return tier ? tier.text : '';
}

// Humidity and moderate-UV guidance sit below heat but above plain garment advice —
// see the priority chain in adviceForTemp() below for where these fire.
const HUMIDITY_TEXT = "Humid enough to feel warmer than it reads — breathable fabric helps.";
const UV_MODERATE_TEXT = "UV's fairly strong out — a bit of shade or sunscreen wouldn't hurt.";

// Direct-sun + hydration guidance: fires on temp>=34 OR uv>=8. Heat and UV content
// overlap here on purpose — this returns ONE sentence, never a heat line plus a
// separate UV line, even when both conditions are true. uv may be null (no data);
// a null uv never triggers this on its own.
function sunAndHydrationAdvice(temp, uv) {
  if (temp >= 38) return HEAT_STRONG_TEXT;
  if (temp >= 34 || (uv != null && uv >= 8)) return HEAT_MID_TEXT;
  return '';
}

/**
 * Advice sentence: absolute temperature, uv, and humidity only. No `diff`/
 * `deltaYesterday` parameter exists. uv/humidity are real API readings or
 * null — never defaulted — so absent data simply skips that tier rather
 * than fabricating a claim.
 *
 * Priority (first match wins, one line only):
 *   1. rain
 *   2. temp>=34 or uv>=8      → sun + hydration (one sentence, see above)
 *   3. humidity>=70           → breathable fabric / feels-warmer note
 *   4. uv 6-7                 → shade/sunscreen
 *   5. fallback: band garment, or the hot band's own temp-tiered heatAdvice
 */
function adviceForTemp(temp, { maxRain = 0, wind = 0, tCode = 0, uv = null, humidity = null } = {}) {
  if (maxRain > 60) return 'Bring an umbrella.';
  if (maxRain > 30) return 'An umbrella might be worth it.';
  if (tCode >= 70) return 'Dress warm.';
  if (wind >= 25 && temp <= 14) return 'A windproof layer makes a real difference.';

  const sunAdvice = sunAndHydrationAdvice(temp, uv);
  if (sunAdvice) return sunAdvice;
  if (humidity != null && humidity >= 70) return HUMIDITY_TEXT;
  if (uv != null && uv >= 6 && uv <= 7) return UV_MODERATE_TEXT;

  return bandForTemp(temp).garment || heatAdviceForTemp(temp) || '';
}

/**
 * p: { diff, tCode, feels, slots, tMax, maxRain, wind, uvIndex, humidity }
 * uvIndex/humidity are real readings or null (never a default) — see adviceForTemp().
 * Returns the headline HTML. Trend line is delta-based; evening line and
 * advice/action line are absolute-temperature/uv/humidity-based only.
 */
export function buildProse(p) {
  const { diff, tCode, feels, slots, tMax, maxRain, wind, uvIndex = null, humidity = null } = p;
  const eTemp = slots[2]?.temp;
  const eDrop = eTemp != null ? tMax - eTemp : 0;
  const abs = Math.abs(diff);
  const dChip = ic(tMax, diff);
  const eChip = eDrop >= 5 && eTemp != null ? iconChip('nights_stay', `${eTemp}°C`) : '';

  const action = adviceForTemp(feels, { maxRain, wind, tCode, uv: uvIndex, humidity });

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
