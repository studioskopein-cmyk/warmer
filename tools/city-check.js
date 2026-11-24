// Warmer — random-city judge. Grades one engine output against criteria C1–C7.
// It never trusts the engine's own reading of the data: every "truth" here is
// recomputed from the raw Open-Meteo response. Thresholds for what MUST be
// mentioned are deliberately a little stricter than the engine's own, so the
// judge only demands what is clearly there.
//
// Input:  raw = { d: forecast JSON, air: air-quality JSON|null, now: ms }
//         out = { html: prose HTML, card: card sentence, detail: key => html|null }
// Output: { fails: [{c, msg}], flags: [msg], truth }

const MODELS = ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless'];
const POLLEN_HIGH = { grass: 50, birch: 81, alder: 100, mugwort: 10, olive: 100, ragweed: 20 };

function localClock(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const at = t => parts.find(p => p.type === t).value;
  return { date: `${at('year')}-${at('month')}-${at('day')}`, hour: Number(at('hour')) };
}
const mean = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

export function truthOf(raw) {
  const { d, air, now } = raw;
  const tz = d.timezone || 'UTC';
  const times = d.hourly.time;
  const cur = times.findIndex(t => t * 1000 <= now && now < (t + 3600) * 1000);
  const nowLocal = localClock(now, tz);
  const band = nowLocal.hour < 5 ? 'NIGHT' : nowLocal.hour < 11 ? 'MORNING' : nowLocal.hour < 18 ? 'DAY' : 'EVENING';
  const dayOff = ms => Math.round((Date.parse(localClock(ms, tz).date) - Date.parse(nowLocal.date)) / 86400000);
  // Horizon: rest of today (MORNING/DAY), until noon (NIGHT: today, EVENING: tomorrow).
  // Same window the app uses (getBandWindow): hours up to 11:00, i.e. until noon.
  const inHorizon = (h, off) => band === 'EVENING' ? (off === 0 || (off === 1 && h < 12)) : band === 'NIGHT' ? (off === 0 && h < 12) : off === 0;
  const H = d.hourly;
  const get = (k, m, i) => { const v = H[`${k}_${m}`]?.[i]; return Number.isFinite(v) ? v : null; };
  const hours = [];
  for (let i = cur; i < Math.min(times.length - 1, cur + 30); i++) {
    const c = localClock(times[i] * 1000, tz), off = dayOff(times[i] * 1000);
    if (i > cur && !inHorizon(c.hour, off)) continue;
    const prob = mean(MODELS.map(m => get('precipitation_probability', m, i + 1)));
    const mm = mean(MODELS.map(m => get('precipitation', m, i + 1)));
    const cm = mean(MODELS.map(m => get('snowfall', m, i + 1)));
    const t = get('temperature_2m', 'ecmwf_ifs025', i) ?? mean(MODELS.map(m => get('temperature_2m', m, i)));
    const snowFrac = mm && mm > 0 && cm != null ? Math.min(1, (cm * 10 / 7) / mm) : 0;
    hours.push({
      i, hour: c.hour, off, prob, mm, cm, t,
      feels: get('apparent_temperature', 'ecmwf_ifs025', i),
      gust: get('wind_gusts_10m', 'ecmwf_ifs025', i) ?? get('wind_gusts_10m', 'icon_seamless', i),
      code: get('weathercode', 'ecmwf_ifs025', i) ?? get('weathercode', 'icon_seamless', i),
      snow: snowFrac >= 0.6,
      clear: prob != null && prob >= 50 && mm != null && mm >= 0.3,
      engineRainy: prob != null && prob >= 40 && mm != null && mm >= 0.1,
    });
  }
  const A = air?.hourly;
  const aIdx = A ? A.time.findIndex(t => t * 1000 <= now && now < (t + 3600) * 1000) : -1;
  const aqi = aIdx >= 0 ? A.european_aqi?.[aIdx] ?? null : null;
  let uvMax = null;
  if (A && A.uv_index) for (const h of hours) { const j = A.time.indexOf(times[h.i]); const v = A.uv_index[j]; if (Number.isFinite(v) && h.hour >= 9 && h.hour <= 16) uvMax = Math.max(uvMax ?? 0, v); }
  const pollenHigh = aIdx >= 0 ? Object.entries(POLLEN_HIGH).filter(([k, th]) => (A[`${k}_pollen`]?.[aIdx] ?? 0) >= th).map(([k]) => k) : [];
  const ts = hours.map(h => h.t).filter(Number.isFinite), fs = hours.map(h => h.feels).filter(Number.isFinite);
  const clearHours = hours.filter(h => h.clear);
  // Any rain/snow hour in the next 30 hours, for a card that names tomorrow.
  let precipNext30 = false;
  for (let i = cur; i < Math.min(times.length - 1, cur + 30); i++) {
    const pr = mean(MODELS.map(m => get('precipitation_probability', m, i + 1))), mm = mean(MODELS.map(m => get('precipitation', m, i + 1)));
    if (pr != null && pr >= 40 && mm != null && mm >= 0.1) precipNext30 = true;
  }
  return {
    band, nowHour: nowLocal.hour, hours, precipNext30,
    rain: clearHours.some(h => !h.snow),
    snow: clearHours.some(h => h.snow),
    onlySnow: clearHours.length > 0 && clearHours.every(h => h.snow),
    snowCm: +hours.reduce((a, h) => a + (h.cm || 0), 0).toFixed(1),
    thunder: hours.some(h => h.code >= 95 && (h.prob ?? 0) >= 40),
    freezingRain: hours.some(h => h.code === 66 || h.code === 67),
    gustMax: Math.max(0, ...hours.map(h => h.gust ?? 0)),
    feelsMax: fs.length ? Math.max(...fs) : null, feelsMin: fs.length ? Math.min(...fs) : null,
    swing: ts.length ? Math.max(...ts) - Math.min(...ts) : 0,
    tMin: ts.length ? Math.min(...ts) : null,
    aqi, uvMax, pollenHigh,
  };
}

// ---- parse engine HTML (regex: runs in node and browser alike) ----
const strip = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export function parseOutput(html) {
  const pills = [];
  const pre = /class="pill([^"]*)"([^>]*)>\s*<span class="pi"[^>]*>([^<]*)<\/span>\s*<span class="pv">([^<]*)<\/span>/g;
  let m;
  while ((m = pre.exec(html))) {
    const key = /data-pill="([^"]+)"/.exec(m[2])?.[1] || '';
    const label = /aria-label="([^"]+)"/.exec(m[2])?.[1] || '';
    pills.push({ exp: m[1].includes('pill-x'), warn: m[1].includes('pill-warn'), key, icon: m[3], value: m[4], label });
  }
  const noPills = html.replace(/<(button|span) [^>]*class="pill[^"]*"[\s\S]*?<span class="pv">[^<]*<\/span>[\s\S]*?<\/(button|span)>/g, ' ');
  const actionM = /<span class="action">([\s\S]*?)<\/span>(?![\s\S]*class="action")/.exec(noPills);
  const action = actionM ? strip(actionM[1]) : '';
  const headLines = noPills.split(/<br\s*\/?>/).filter(l => !l.includes('class="action"')).map(strip).filter(Boolean);
  return { pills, headLines, head: headLines.join(' / '), action, text: strip(noPills) };
}

const V = {
  rain: /\b(rain|drizzle|showers?|umbrella|wet|downpour)\b/,
  snow: /\bsnow/,
  accum: /settl|stick|pil(e|ing) up|accumulat|\d+\s?cm/,
  thunder: /thunder|storm|lightning/,
  ice: /\bice\b|\bicy\b|freezing rain/,
  wind: /\bwind|gust/,
  heat: /\bhot\b|\bheat|sweltering/,
  cold: /\bcold|freez|frost|bitter|bundle|warmest|\bcoat\b|frigid/,
  swing: /(drop|dip|cool|cold|chill|layer|jacket|sweater)[^.]*?(tonight|evening|overnight|morning|later|after dark)|(tonight|evening|overnight|morning|later|after dark)[^.]*?(drop|dip|cool|cold|chill|layer|jacket|sweater)/,
  air: /\bair\b/,
  uv: /\buv\b|sunscreen|\bspf\b/,
  pollen: /pollen/,
};
const TOPIC_ORDER = ['thunder', 'ice', 'snow', 'rain', 'wind', 'heat', 'cold', 'air', 'uv', 'pollen', 'swing'];
export const topicsOf = s => TOPIC_ORDER.filter(t => V[t].test(s.toLowerCase()));

export function judge(raw, out) {
  const T = truthOf(raw);
  const P = parseOutput(out.html);
  const fails = [], flags = [];
  const F = (c, msg) => fails.push({ c, msg });
  const all = (P.text + ' ' + P.pills.map(p => `${p.icon} ${p.value} ${p.label}`).join(' ')).toLowerCase();
  const head = P.head.toLowerCase(), act = P.action.toLowerCase();

  // C1 — snow is called snow; settling snow is announced.
  if (T.snow && !V.snow.test(all)) F('C1', 'snow in the forecast but never called snow');
  if (T.onlySnow && /\brain\b/.test(head) && !/snow/.test(head)) F('C1', 'snow-only precipitation headlined as rain');
  if (T.snowCm >= 1 && !V.accum.test(all + ' ' + P.pills.map(p => p.value).join(' '))) F('C1', `about ${T.snowCm}cm of snow but no word that it settles`);

  // C2 — intensity words describe the next 3 hours of the event, not later.
  const ev = T.hours.findIndex(h => h.engineRainy);
  if (/\bheavy\b/.test(head) && ev >= 0) {
    const near = T.hours.slice(ev, ev + 3).filter(h => h.engineRainy);
    const heavyNear = near.some(h => (h.snow ? (h.cm ?? 0) >= 2 : (h.mm ?? 0) >= 2.5));
    if (!heavyNear) F('C2', '"heavy" in the headline, but the first hours of the event are not heavy');
  }
  if (/\buntil\b/.test(head) && /rain|snow|drizzle|sleet/.test(head) && !T.hours[0]?.engineRainy) F('C2', '"until" but it is not falling now');
  if (/\bfrom \d/.test(head) && T.hours[0]?.engineRainy) F('C2', '"from <time>" but it is already falling now');

  // C3 — card says the same thing as the day screen, and is true.
  const dayTopics = topicsOf(P.head + ' ' + P.action + ' ' + P.pills.map(p => p.icon + ' ' + p.label).join(' '));
  const cardTopics = topicsOf(out.card || '');
  const lead = topicsOf(P.headLines[0] || '');
  const disruptive = ['thunder', 'ice', 'snow', 'rain', 'wind', 'heat', 'cold'];
  if (cardTopics.some(t => !dayTopics.includes(t))) F('C3', `card topic ${cardTopics.join('/')} not on the day screen (${dayTopics.join('/') || 'none'})`);
  const leadDisrupt = lead.find(t => disruptive.includes(t));
  if (leadDisrupt && !cardTopics.includes(leadDisrupt)) F('C3', `day leads with ${leadDisrupt}, card says "${out.card}"`);
  // A card that names when (tomorrow, or a clock time) may point past the window.
  const cardTomorrow = /tomorrow|midnight|\b\d{1,2}(am|pm)\b/i.test(out.card || '');
  if (cardTopics.includes('rain') && !(cardTomorrow ? T.precipNext30 : T.hours.some(h => h.engineRainy))) F('C3', 'card mentions rain/umbrella but no rain hours ahead');
  if (cardTopics.includes('snow') && !T.hours.some(h => h.engineRainy && h.snow)) F('C3', 'card mentions snow but no snow ahead');

  // C4 — numbers live in pills; claims that need a number have one; no empty pills.
  const loose = P.text.replace(/\b\d{1,2}(:\d\d)?\s?(am|pm)\b/gi, '').replace(/\b(SPF\s?\d+\+?)/gi, '');
  if (/\d/.test(loose)) F('C4', `number in the sentence instead of a pill: "${P.text}"`);
  const needs = { uv: p => p.key === 'uv', air: p => p.key === 'aqi', pollen: p => p.key === 'pollen', wind: p => p.key === 'wind' || p.key === 'warn:wind' || p.icon === 'air' };
  const claim = (P.head + ' ' + P.action).toLowerCase();
  for (const [t, has] of Object.entries(needs)) {
    const said = t === 'air' ? /air quality|\bair\b(?! temperature)/.test(claim) : V[t].test(claim);
    if (said && !(t === 'wind' && /wind chill/.test(claim)) && !P.pills.some(has)) F('C4', `${t} claim without a ${t} pill`);
  }
  for (const p of P.pills) if (/^[-+]?0(\.0)?(°[CF]|%|km\/h|cm)?$/.test(p.value.trim())) F('C4', `empty pill "${p.value}"`);

  // C5 — a warning pill's number proves the warning.
  for (const p of P.pills.filter(p => p.warn)) {
    const n = parseFloat(String(p.value).replace(/^[A-Za-z ]+/, ""));
    const kind = p.key.replace('warn:', '');
    const ok = kind === 'freeze' ? n <= -10 : kind === 'heat' ? n >= 36 : kind === 'wind' ? n >= 60
      : kind === 'ice' ? (n <= 3 && /°/.test(p.value)) : kind === 'storm' ? !/%$/.test(p.value) : true;
    if (!ok) F('C5', `warning ${kind} pill "${p.value}" does not prove it`);
    if (kind === 'ice') { const det = out.detail(p.key) || ''; if (!/precip|snow|rain|wet/i.test(det)) F('C5', 'ice warning detail has no precipitation proof'); }
  }

  // C6 — no repetition; hard numbers come with a scale; comparisons have a referent.
  const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'it', 'its', "it's", 'to', 'of', 'in', 'on', 'for', 'is', 'out', 'with', 'than', 'today', 'but', 'be', 'you', 'your', 'at', 'as', 'this', 'that', 'from', 'still']);
  const bigrams = s => { const w = s.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(x => x && !STOP.has(x)); const out = new Set(); for (let i = 0; i + 1 < w.length; i++) out.add(w[i] + ' ' + w[i + 1]); return out; };
  if (P.action) { const hb = bigrams(P.head); const dup = [...bigrams(P.action)].filter(b => hb.has(b)); if (dup.length) F('C6', `headline and action repeat "${dup[0]}"`); }
  for (const p of P.pills) {
    if (['uv', 'aqi', 'pollen', 'wind', 'dew'].includes(p.key.split(':')[0])) {
      const det = p.exp ? out.detail(p.key) : null;
      if (!det || !/pd-scale/.test(det)) F('C6', `${p.key} pill has no scale explaining the number`);
    }
  }
  if (/\b(far|much|a lot|even|way) (colder|warmer|cooler|hotter)\b(?! than)/.test(head + ' ' + act)) F('C6', 'comparison without a referent');

  // C7 — everything that will get in the way of the day is mentioned in advance.
  const need = [];
  if (T.rain) need.push(['rain', V.rain.test(all) || V.thunder.test(all) || V.ice.test(all)]);
  if (T.thunder) need.push(['thunderstorm', V.thunder.test(all)]);
  if (T.freezingRain) need.push(['freezing rain', V.ice.test(all)]);
  if (T.gustMax >= 50) need.push([`gusts ${Math.round(T.gustMax)}km/h`, V.wind.test(all)]);
  if (T.feelsMax != null && T.feelsMax >= 32) need.push([`heat (feels ${Math.round(T.feelsMax)}°)`, V.heat.test(all)]);
  if (T.feelsMin != null && T.feelsMin <= -5) need.push([`cold (feels ${Math.round(T.feelsMin)}°)`, V.cold.test(all) || /ac_unit|severe_cold/.test(all)]);
  // A day/night swing matters for clothing only when its cool end is cool.
  if (T.swing >= 10 && T.tMin < 17) need.push([`day/night swing ${Math.round(T.swing)}°`, V.swing.test(all) || /wb_twilight|bedtime|routine/.test(all)]);
  if (T.aqi != null && T.aqi >= 60) need.push([`air quality ${Math.round(T.aqi)}`, V.air.test(all)]);
  if (T.uvMax != null && T.uvMax >= 8) need.push([`UV ${T.uvMax.toFixed(1)}`, V.uv.test(all)]);
  if (T.pollenHigh.length) need.push([`pollen (${T.pollenHigh.join(',')})`, V.pollen.test(all)]);
  for (const [what, ok] of need) if (!ok) F('C7', `not mentioned: ${what}`);

  // Data sanity flags (not failures).
  if (T.hours.length < 3) flags.push('horizon shorter than 3 hours');
  return { fails, flags, truth: { ...T, hours: undefined }, parsed: P };
}
