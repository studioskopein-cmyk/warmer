// ============================================================================
// Warmer — headline copy rules for index.html's buildProse().
//
// Two independent layers, kept structurally separate so one can never leak
// into the other:
//   - trend sentence   ("It's much warmer than yesterday") — reads `diff`
//     (delta vs. yesterday) only. Lives inline in buildProse().
//   - advice sentence  (garment/action line) and the evening line — read
//     absolute temperature only, via TEMP_BANDS below. Neither has a code
//     path that reads `diff`.
// ============================================================================

export const TEMP_BANDS = [
  {
    name: 'hot', min: 30,
    adjective: 'hot',
    eveningPhrase: 'still hot, just a touch easier',
    garment: null, // >=30°C: self-evident, say nothing rather than "wear short sleeves"
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

// Advice sentence: absolute temperature only. No `diff`/`deltaYesterday` parameter exists.
function adviceForTemp(temp, { maxRain = 0, wind = 0, tCode = 0 } = {}) {
  if (maxRain > 60) return 'Bring an umbrella.';
  if (maxRain > 30) return 'An umbrella might be worth it.';
  if (tCode >= 70) return 'Dress warm.';
  if (wind >= 25 && temp <= 14) return 'A windproof layer makes a real difference.';
  return bandForTemp(temp).garment || '';
}

/**
 * p: { diff, tCode, feels, slots, tMax, maxRain, wind }
 * Returns the headline HTML. Trend line is delta-based; evening line and
 * advice/action line are absolute-temperature-based only.
 */
export function buildProse(p) {
  const { diff, tCode, feels, slots, tMax, maxRain, wind } = p;
  const eTemp = slots[2]?.temp;
  const eDrop = eTemp != null ? tMax - eTemp : 0;
  const abs = Math.abs(diff);
  const dChip = ic(tMax, diff);
  const eChip = eDrop >= 5 && eTemp != null ? iconChip('nights_stay', `${eTemp}°C`) : '';

  const action = adviceForTemp(feels, { maxRain, wind, tCode });

  let prose = '';
  if (maxRain > 40) {
    prose = `<span class="g">Rain </span><span class="w">${maxRain > 85 ? 'coming' : maxRain > 70 ? 'likely' : 'possible'}</span>`;
    const rainHour = slots.find(s => s.rain > 40);
    const rainWindow = rainHour ? proof('water_drop', `${rainHour.label} · ${Math.round(maxRain)}%`) : '';
    if (rainWindow) prose += rainWindow;
    if (abs >= 3) prose += `<br><span class="g">and ${diff > 0 ? 'warmer' : 'cooler'} than yesterday</span>${dChip}`;
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
