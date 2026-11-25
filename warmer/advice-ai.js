// AI-written action line (the serif paragraph) and city-card line.
//
// Split of work:
//   code decides WHAT to say  -> adviceFacts() in advice-rules.js
//   the model decides HOW     -> buildAdvicePrompt() below, run server-side
//   code checks the result    -> validateAdvice() below, run on server and client
// If the model's answer fails any check, the app keeps the rule-based line.
//
// Used by functions/api/translate.ts (server) and index.html (client).
// Pure functions only: no DOM, no fetch.

import { GEAR_ITEMS, MAX_GEAR } from './gear.js';

export const ADVICE_KINDS = [
  'rain', 'snow', 'sleet', 'freezing_rain', 'thunder',
  'wind', 'strong_wind', 'cold', 'hard_freeze', 'heat', 'extreme_heat', 'ice',
  'temp_drop', 'temp_rise', 'air_quality', 'uv', 'pollen',
  'feels_colder', 'feels_warmer', 'temperature',
];
const FACT_FIELDS = ['when', 'level', 'chance', 'change', 'feel', 'species'];
const BANDS = ['MORNING', 'DAY', 'EVENING', 'NIGHT'];
const WORDS = /^[a-z][a-z ]{0,23}$/;
const HEADLINE = /^[A-Za-z0-9 ,:;'’.\-–—°%]{1,140}$/;

// The client sends facts; the server only ever puts these cleaned values into
// the prompt. Every value is a short lowercase word from a closed shape, so
// the endpoint cannot be used to send our API key an arbitrary prompt.
export function sanitizeFacts(f) {
  if (!f || typeof f !== 'object') return null;
  const headline = typeof f.headline === 'string' ? f.headline.replace(/\s+/g, ' ').trim() : '';
  if (!HEADLINE.test(headline)) return null;
  const time_of_day = BANDS.includes(f.time_of_day) ? f.time_of_day : 'DAY';
  if (!Array.isArray(f.must_mention) || f.must_mention.length < 1 || f.must_mention.length > 5) return null;
  // gear is optional and may only contain items from the closed list in gear.js.
  let gear = [];
  if (f.gear != null) {
    if (!Array.isArray(f.gear) || f.gear.length > MAX_GEAR || !f.gear.every(g => typeof g === 'string' && GEAR_ITEMS.has(g))) return null;
    gear = [...new Set(f.gear)];
  }
  const must_mention = [];
  for (const m of f.must_mention) {
    if (!m || !ADVICE_KINDS.includes(m.kind)) return null;
    const clean = { kind: m.kind };
    for (const k of FACT_FIELDS) {
      if (m[k] == null) continue;
      if (typeof m[k] !== 'string' || !WORDS.test(m[k])) return null;
      clean[k] = m[k];
    }
    must_mention.push(clean);
  }
  return { headline, time_of_day, must_mention, gear };
}

const EXAMPLES = [
  {
    in: { headline: 'Snow until tomorrow 6pm', time_of_day: 'EVENING', must_mention: [
      { kind: 'snow', when: 'later', level: 'settles', chance: 'high' },
      { kind: 'cold', when: 'tonight', level: 'bitter' }],
      gear: ['waterproof boots with grip', 'windproof layer', 'heavy puffer coat', 'hat', 'thick gloves'] },
    out: { action: 'Puffer coat and waterproof boots with grip tonight — add hat and gloves, since it will be bitter.', card: 'Puffer coat, boots with grip.' },
  },
  {
    in: { headline: 'Rain from 3pm', time_of_day: 'MORNING', must_mention: [
      { kind: 'rain', when: 'later', level: 'rain', chance: 'high' }],
      gear: ['waterproof jacket', 'umbrella', 'waterproof shoes', 'light cardigan'] },
    out: { action: "Waterproof jacket and an umbrella if you're out this afternoon.", card: 'Waterproof jacket, umbrella.' },
  },
  {
    in: { headline: "It's warmer than yesterday", time_of_day: 'MORNING', must_mention: [
      { kind: 'temperature', feel: 'warm', change: 'warmer' },
      { kind: 'uv', when: 'today', level: 'very high' }],
      gear: ['linen shirt', 'shorts', 'hat with brim', 'sunscreen', 'sunglasses', 'water bottle'] },
    out: { action: 'Linen shirt, hat with brim and sunscreen before you head out — the midday sun is strong.', card: 'Light shirt, hat, sunscreen.' },
  },
];

export function buildAdvicePrompt(facts) {
  const ex = EXAMPLES.map(e => `Input: ${JSON.stringify(e.in)}\nOutput: ${JSON.stringify(e.out)}`).join('\n\n');
  return `You write the advice line for Warmer, a weather app people check before leaving home.
You get the day's headline and a list of facts. Say what to do about them.

Rules
1. Talk about at most two topics, the ones in must_mention, in that order. One sentence per topic.
2. Lead with what to wear or carry. Choose from "gear", which is already ranked and fits today's weather.
   Pick the outer layer first, then up to three more items. Never name clothing that is not in gear.
3. A reason may follow after an em dash, in a few words.
4. No numbers, temperatures, amounts or clock times. The headline and pills carry them.
   Relative words are fine: "tonight", "this afternoon", "tomorrow morning".
5. Do not restate the headline or say how it feels ("it feels freezing"). Say what to do about it.
6. Never suggest an umbrella for snow or strong wind.
7. Match certainty: "likely" or "just in case" when chance is medium, a plain instruction when high.
8. Everyday words. No weather terms (precipitation, accumulation, wind chill). No exclamation marks or emoji.
   No filler such as "be aware", "consider", "keep in mind", "make sure to".
9. Warm, never cheesy: no "stay safe", "stay cozy", pet names, or talk about feelings.
10. Air quality becomes an action:
    poor: mask if you'll be outside a while or exercising; do hard exercise indoors.
    very poor: mask when you go out; exercise indoors.
    extremely poor: stay in if you can; mask if you go out.
11. Also write a card line: at most 6 words, the same advice in the same order.

Return JSON only: {"action": "...", "card": "..."}

${ex}

Input: ${JSON.stringify(facts)}
Output:`;
}

// Words that show a fact was covered. Generous on purpose: this checks that
// nothing was dropped, not how it was said.
const COVERS = {
  rain: /umbrella|hood|rain ?coat|raincoat|waterproof|rain jacket|shell/,
  snow: /boot|grip|shoe|snow|footing|slip/,
  sleet: /waterproof|umbrella|boot|shoe|grip|hood/,
  freezing_rain: /grip|slow|footing|careful|ic[ey]|slip/,
  ice: /grip|slow|footing|careful|ic[ey]|slip/,
  thunder: /indoors|inside|shelter|thunder|storm|rumble/,
  wind: /wind|gust|hood|hat|hold/,
  strong_wind: /wind|gust|indoors|inside|stay in/,
  cold: /hat|glove|scarf|warm|coat|layer|bundle|mitten/,
  hard_freeze: /hat|glove|scarf|warm|coat|layer|bundle|cover|mitten/,
  heat: /shade|water|cool|light|indoors|heat|hot|sun/,
  extreme_heat: /shade|water|cool|indoors|heat|hot|limit|short/,
  temp_drop: /layer|jacket|sweater|jumper|later|evening|tonight|coat/,
  temp_rise: /layer|light|later|peel|off/,
  air_quality: /workout|exercise|run|outdoors|outside|indoors|air|mask|easy/,
  uv: /sunscreen|shade|hat|sunglasses|sun/,
  pollen: /antihistamine|allerg|pollen|window|tissue/,
  feels_colder: /warm|layer|coat|jacket|sweater|jumper|dress|chill|cold/,
  feels_warmer: /light|layer|dress|t-shirt|tee|shirt|warm/,
  temperature: /coat|jacket|layer|sweater|jumper|t-shirt|tee|shirt|dress|light|warm|scarf|glove|short|top|hat|sleeve/,
};
const JARGON = /precipitation|accumulat|wind chill|apparent temperature|meteorolog|dew point|humidity index/i;
const CHEESY = /stay safe|stay cozy|cosy|cozy|buddy|friend|enjoy|lovely|darling|sweetie|you've got this/i;
const HEDGE = /be aware|consider |keep in mind|make sure|bear in mind|note that/i;
const GEAR_SKIP = new Set(['with', 'layer', 'light', 'clothes', 'extra', 'quick', 'dry']);
const gearWords = gear => [...new Set((gear || []).flatMap(g => g.toLowerCase().split(/[\s-]+/)).filter(w => w.length >= 3 && !GEAR_SKIP.has(w)))];
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'until', 'today', 'tonight', 'than', 'your', 'you', 'this', 'that', 'will', 'into', 'out', 'later']);
const contentWords = t => (t.toLowerCase().match(/[a-z]+/g) || []).filter(w => w.length >= 4 && !STOP.has(w));

export function validateAdvice(out, facts) {
  const reasons = [];
  const action = typeof out?.action === 'string' ? out.action.trim() : '';
  const card = typeof out?.card === 'string' ? out.card.trim() : '';
  if (action.length < 8) reasons.push('action missing');
  if (card.split(/\s+/).filter(w => /[A-Za-z]/.test(w)).length > 6 || card.length < 4) reasons.push('card not 1-6 words');
  for (const [name, t] of [['action', action], ['card', card]]) {
    if (/\d/.test(t)) reasons.push(`${name} has a number`);
    if (/!/.test(t)) reasons.push(`${name} has !`);
    if (/\p{Extended_Pictographic}/u.test(t)) reasons.push(`${name} has emoji`);
    if (JARGON.test(t)) reasons.push(`${name} uses a weather term`);
    if (CHEESY.test(t)) reasons.push(`${name} is cheesy`);
    if (HEDGE.test(t)) reasons.push(`${name} uses filler`);
  }
  const kinds = new Set((facts?.must_mention || []).map(m => m.kind));
  const wet = kinds.has('rain') || kinds.has('sleet');
  if (/umbrella/i.test(action + ' ' + card) && ((kinds.has('snow') && !wet) || kinds.has('strong_wind'))) reasons.push('umbrella for snow or strong wind');
  const a = action.toLowerCase();
  for (const k of kinds) if (COVERS[k] && !COVERS[k].test(a)) reasons.push(`missing ${k}`);
  // When we supplied gear, at least one item must show up in the sentence.
  const gw = gearWords(facts?.gear);
  const onlyAir = kinds.size > 0 && [...kinds].every(k => k === 'air_quality');
  if (gw.length && !onlyAir && !gw.some(w => new RegExp(`\\b${w}`).test(a))) reasons.push('no gear named');
  const head = new Set(contentWords(facts?.headline || ''));
  const words = contentWords(action);
  if (words.length && words.filter(w => head.has(w)).length / words.length > 0.5) reasons.push('repeats the headline');
  return { ok: reasons.length === 0, reasons, action, card };
}
