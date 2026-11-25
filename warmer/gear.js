// What to wear or carry, chosen by code from a closed list.
//
// The model never invents gear. It receives this ranked list inside the
// facts and picks from it, so every item is something we decided fits the
// weather. Temperature bands match TEMP_BANDS in advice-rules.js:
//   hot >=30, warm 25, mild 20, cool 15, chilly 10, cold 5, nearFreezing 0, freezing <0
//
// Order of the result: outer layer -> weather combination -> second layer
// -> accessories. At most MAX_GEAR items; the rest stay out.
// Pure function, no DOM. Imported by advice-rules.js and advice-ai.js.

export const MAX_GEAR = 6;

// [main outer/top, second piece]
const BASE = {
  hot: ['linen shirt', 'shorts'],
  warm: ['t-shirt', 'light trousers'],
  mild: ['long-sleeve shirt', 'light cardigan'],
  cool: ['light jacket', 'sweater'],
  chilly: ['coat', 'knit sweater'],
  cold: ['wool coat', 'thick sweater'],
  nearFreezing: ['padded jacket', 'thermal layer'],
  freezing: ['heavy puffer coat', 'thermal layer'],
};
const BANDS = Object.keys(BASE);
const idx = b => BANDS.indexOf(b);
const atLeast = (band, floor) => idx(band) >= idx(floor); // colder than or equal

// Outer layer used instead of BASE[0] when it is raining.
const RAIN_OUTER = {
  hot: 'light rain jacket', warm: 'light rain jacket',
  mild: 'waterproof jacket', cool: 'waterproof jacket',
  chilly: 'waterproof coat', cold: 'waterproof coat', nearFreezing: 'waterproof coat', freezing: 'waterproof coat',
};

// Everything the model may be handed. sanitizeFacts() checks against this.
export const GEAR_ITEMS = new Set([
  ...Object.values(BASE).flat(), ...Object.values(RAIN_OUTER),
  'quick-dry clothes', 'breathable clothes', 'hooded jacket', 'umbrella', 'waterproof shoes', 'spare socks',
  'waterproof boots with grip', 'waterproof boots', 'shoes with grip', 'windproof layer', 'neck gaiter',
  'scarf', 'hat', 'gloves', 'thick gloves', 'waterproof gloves', 'wool socks', 'ear warmers',
  'sunscreen', 'sunglasses', 'hat with brim', 'cap', 'water bottle', 'mask', 'extra layer',
]);

// i: { band, precip: {kind, level}|null, strongWind, uv, aqi, pollen, humidity, tempDrop, settles }
export function gearFor(i) {
  const band = BASE[i.band] ? i.band : 'mild';
  const [main, second] = BASE[band];
  const out = [];
  const add = (...items) => { for (const x of items) if (x && !out.includes(x)) out.push(x); };
  const wet = i.precip && ['rain', 'sleet', 'thunder'].includes(i.precip.kind);
  const drizzle = i.precip?.kind === 'rain' && i.precip.level === 'drizzle';
  const snow = i.precip?.kind === 'snow';
  const coldish = atLeast(band, 'chilly');

  // 1. outer layer
  add(wet && !drizzle ? RAIN_OUTER[band] : main);

  // 2. weather combination
  if (drizzle) add('hooded jacket');
  else if (i.precip?.kind === 'rain' || i.precip?.kind === 'thunder') {
    if (!i.strongWind) add('umbrella');
    if (coldish) add('waterproof boots'); else add('waterproof shoes');
  } else if (i.precip?.kind === 'sleet') add('waterproof boots');
  else if (snow) add(i.settles ? 'waterproof boots with grip' : 'shoes with grip');
  else if (i.precip?.kind === 'freezing_rain') add('shoes with grip');
  if (i.strongWind) add('windproof layer');
  if (i.strongWind && atLeast(band, 'cold')) add('neck gaiter');
  if (wet && !coldish) add('quick-dry clothes');
  if (!wet && i.humidity >= 70 && idx(band) <= idx('warm')) add('breathable clothes');

  // Health items go right after the weather combination so the cap never drops them.
  if (i.aqi >= 60) add('mask');

  // 3. second layer
  add(second);

  // 4. accessories
  if (atLeast(band, 'chilly')) add('scarf');
  if (atLeast(band, 'cold')) add('hat', band === 'freezing' ? 'thick gloves' : 'gloves');
  if (band === 'freezing' || (snow && i.settles)) add('wool socks');
  if (snow && i.settles && band !== 'freezing') add('waterproof gloves');
  if (i.uv >= 8) add('hat with brim', 'sunscreen', 'sunglasses');
  else if (i.uv >= 6) add('sunscreen', 'sunglasses');
  if (band === 'hot' || (band === 'warm' && i.humidity >= 70)) add('water bottle');
  if (band === 'hot' && !(i.uv >= 8)) add('cap');
  if (i.pollen) add('sunglasses', 'mask');
  if (i.tempDrop) add('extra layer');

  return out.filter(x => GEAR_ITEMS.has(x)).slice(0, MAX_GEAR);
}
