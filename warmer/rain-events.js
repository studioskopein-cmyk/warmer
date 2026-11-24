// What counts as "rain you need to dress for", in one place so the numbers
// are easy to retune. All values are STARTING ESTIMATES (not validated): the
// aim is "stand outside ~10 min and your clothes get damp".
//   - PROB_MIN: chance (%) at which an hour counts as a rain hour at all.
//   - DRIZZLE_MM / RAIN_MM / HEAVY_MM: hourly amount (mm) boundaries for
//     "a few drops" / "rain" / "heavy rain".
// An hour with no amount reading (mm null) is treated as plain rain rather
// than silently dry, so a missing field never hides a forecast.
export const RAIN_RULES = { PROB_MIN: 40, DRIZZLE_MM: 0.1, RAIN_MM: 0.5, HEAVY_MM: 2.5 };

const RANK = { dry: 0, drizzle: 1, rain: 2, heavy: 3 };

export function rainLevel(mm) {
  if (!Number.isFinite(mm)) return 'rain';
  if (mm < RAIN_RULES.DRIZZLE_MM) return 'dry';
  if (mm < RAIN_RULES.RAIN_MM) return 'drizzle';
  if (mm < RAIN_RULES.HEAVY_MM) return 'rain';
  return 'heavy';
}

export function isRainyHour(pt) {
  return Number.isFinite(pt?.rain) && pt.rain >= RAIN_RULES.PROB_MIN && rainLevel(pt.mm) !== 'dry';
}

// What is falling in an hour. Open-Meteo gives snowfall in cm alongside the
// total precipitation in mm (water); 7 cm of snow is about 10 mm of water.
// Freezing rain comes only from the weather code (66/67).
export function precipType(pt) {
  if (pt?.code === 66 || pt?.code === 67) return 'freezing';
  const mm = pt?.mm, cm = pt?.cm;
  if (Number.isFinite(mm) && mm > 0 && Number.isFinite(cm)) {
    const frac = Math.min(1, (cm * 10 / 7) / mm);
    if (frac >= 0.6) return 'snow';
    if (frac >= 0.25) return 'sleet';
  }
  if (Number.isFinite(pt?.code) && ((pt.code >= 71 && pt.code <= 77) || pt.code === 85 || pt.code === 86) && !(pt.t > 2)) return 'snow';
  return 'rain';
}

// Snow strength from cm per hour: under 0.5 a light fall, 2 or more heavy.
export function snowLevel(cm) {
  if (!Number.isFinite(cm) || cm < 0.5) return 'drizzle';
  return cm < 2 ? 'rain' : 'heavy';
}
const hourLevel = pt => (precipType(pt) === 'snow' ? snowLevel(pt.cm) : rainLevel(pt.mm));

export const hasRainyHour = series => Array.isArray(series) && series.some(isRainyHour);

/**
 * First rain event from `nowHour` on: a run of consecutive rainy hours.
 * phase 'starting'  -> not raining now; begins at startHour
 *       'clearing'  -> raining now; first dry hour is endHour
 *       'ongoing'   -> raining now and still rainy at the end of the series
 * level = strongest hour in the run; peak = highest chance in the run;
 * startProb = chance at the first rainy hour. Returns null when there is none.
 */
export function findRainEvent(series, nowHour) {
  if (!Array.isArray(series) || nowHour == null) return null;
  const upcoming = series.filter(pt => pt.hour >= nowHour);
  if (upcoming.length === 0 || !Number.isFinite(upcoming[0].rain)) return null;
  const first = upcoming.findIndex(isRainyHour);
  if (first < 0) return null;
  let last = first;
  while (last + 1 < upcoming.length && isRainyHour(upcoming[last + 1])) last++;
  const run = upcoming.slice(first, last + 1);
  const level = run.reduce((best, pt) => (RANK[rainLevel(pt.mm)] > RANK[best] ? rainLevel(pt.mm) : best), 'drizzle');
  const clears = last + 1 < upcoming.length;
  // Wording describes the first three hours of the event; a heavier spell
  // later is reported separately with its own time (heavyLater).
  const strongest = pts => pts.reduce((best, pt) => (RANK[hourLevel(pt)] > RANK[best] ? hourLevel(pt) : best), 'drizzle');
  const nearLevel = strongest(run.slice(0, 3));
  const laterHeavy = nearLevel !== 'heavy' ? run.slice(3).find(pt => hourLevel(pt) === 'heavy') : null;
  const types = run.map(precipType);
  const count = t => types.filter(x => x === t).length;
  const type = count('freezing') ? 'freezing' : count('snow') * 2 >= run.length ? 'snow' : (count('snow') + count('sleet')) * 2 >= run.length ? 'sleet' : 'rain';
  const snowCm = Math.round(run.reduce((sum, pt) => sum + (Number.isFinite(pt.cm) ? pt.cm : 0), 0) * 10) / 10;
  return {
    type, nearLevel, heavyLaterHour: laterHeavy ? laterHeavy.hour : null, snowCm,
    snowHours: count('snow'),
    hours: run.length,
    phase: first > 0 ? 'starting' : clears ? 'clearing' : 'ongoing',
    startHour: upcoming[first].hour,
    endHour: clears ? upcoming[last + 1].hour : null,
    level,
    peak: Math.max(...run.map(pt => pt.rain)),
    startProb: upcoming[first].rain,
  };
}
