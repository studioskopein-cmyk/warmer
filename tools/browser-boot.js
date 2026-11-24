// Browser-side harness for the random-city test (runs on the Warmer origin).
// Module sources live in localStorage ("wt_src_<file>"), so the engine under
// test can differ from what is deployed; fixtures live in "wt_r<round>".
// WT.cleanup() removes every "wt_" key.
window.WT = {
  ls: localStorage,
  save: (k, v) => localStorage.setItem('wt_' + k, typeof v === 'string' ? v : JSON.stringify(v)),
  load: k => { const v = localStorage.getItem('wt_' + k); try { return JSON.parse(v); } catch { return v; } },
  cleanup: () => Object.keys(localStorage).filter(k => k.startsWith('wt_')).forEach(k => localStorage.removeItem(k)),
  async sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 12); },
  async shas() { const o = {}; for (const f of [...WT.load('order'), 'city-check.js']) o[f] = await WT.sha(localStorage.getItem('wt_src_' + f) || ''); return o; },
  async initFromLive() {
    const order = ['weather-display.js', 'rain-events.js', 'weather-data.js', 'advice-rules.js', 'card-action.js'];
    for (const f of order) localStorage.setItem('wt_src_' + f, await fetch('/' + f, { cache: 'no-store' }).then(r => r.text()));
    WT.save('order', order);
    return WT.shas();
  },
  put(f, src) { localStorage.setItem('wt_src_' + f, src); },
  patch(f, ops) {
    let s = localStorage.getItem('wt_src_' + f);
    for (const [a, b] of ops) { const i = s.indexOf(a); if (i < 0 || s.indexOf(a, i + 1) >= 0) throw new Error(`${f}: patch target ${i < 0 ? 'missing' : 'not unique'}: ${a.slice(0, 60)}`); s = s.slice(0, i) + b + s.slice(i + a.length); }
    localStorage.setItem('wt_src_' + f, s);
  },
  M: ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless'],
  async fetchCity([name, lat, lon]) {
    const hv = 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,snowfall,weathercode,windspeed_10m,uv_index,relative_humidity_2m,dew_point_2m,wind_gusts_10m';
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${hv}&daily=weathercode,temperature_2m_max,temperature_2m_min&models=${WT.M.join(',')}&past_days=1&forecast_days=3&timezone=auto&timeformat=unixtime&temperature_unit=celsius&precipitation_unit=mm&wind_speed_unit=kmh`;
    const au = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=uv_index,european_aqi,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen&timezone=auto&timeformat=unixtime&past_days=1&forecast_days=3`;
    const now = Date.now();
    const [d, air] = await Promise.all([fetch(u).then(r => r.json()), fetch(au).then(r => r.ok ? r.json() : null).catch(() => null)]);
    const trim = (h, from, to) => { const o = {}; for (const k in h) o[k] = h[k].slice(from, to).map(v => typeof v === 'number' && k !== 'time' ? Math.round(v * 10) / 10 : v); return o; };
    const at = t => t * 1000 <= now && now < (t + 3600) * 1000;
    const cur = d.hourly.time.findIndex(at);
    d.hourly = trim(d.hourly, Math.max(0, cur - 26), cur + 30);
    if (air && air.hourly) { const ai = air.hourly.time.findIndex(at); air.hourly = trim(air.hourly, Math.max(0, ai - 2), ai + 30); }
    return { name, lat, lon, now, d, air };
  },
  async collect(round, cities) {
    const raws = await Promise.all(cities.map(c => WT.fetchCity(c).catch(e => ({ name: c[0], error: String(e) }))));
    WT.save('r' + round, raws);
    return raws.map(r => r.name + (r.error ? ' ERR' : '')).join(', ');
  },
  async mods() {
    const urls = {}, out = {};
    for (const f of [...WT.load('order'), 'city-check.js']) {
      const src = localStorage.getItem('wt_src_' + f).replace(/from\s*["']\.\/([\w-]+\.js)["']/g, (m, n) => `from "${urls[n]}"`);
      urls[f] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      out[f] = await import(urls[f]);
    }
    return out;
  },
  async run(rounds, only) {
    const m = await WT.mods();
    const W = m['weather-data.js'], A = m['advice-rules.js'], C = m['card-action.js'], K = m['city-check.js'];
    const res = [];
    for (const round of [].concat(rounds)) for (const raw of WT.load('r' + round).filter(r => !r.error && (!only || only.includes(r.name)))) {
      try {
        const p = W.parse(raw.d, raw.air, new Date(raw.now)); p.temperatureUnit = 'C';
        const html = A.buildProse(p).html;
        const card = C.cardAction(p);
        const j = K.judge(raw, { html, card, detail: k => A.pillDetailHTML(k, p)?.html ?? null });
        const pp = j.parsed, T = j.truth;
        res.push({ r: round, city: raw.name, h: T.nowHour, ok: !j.fails.length, fails: j.fails.map(f => f.c + ' ' + f.msg),
          head: pp.head, act: pp.action, pills: pp.pills.map(x => (x.warn ? '!' : x.exp ? '>' : '') + x.icon + ':' + x.value).join(' '), card,
          t: `now ${p.nowTemp} y ${p.yesterdayNowTemp} feels ${p.feels} fmin ${T.feelsMin} fmax ${T.feelsMax} swing ${Math.round(T.swing)} gust ${Math.round(T.gustMax)} uv ${T.uvMax} aqi ${T.aqi} rain ${T.rain} snow ${T.snow}/${T.snowCm}cm thunder ${T.thunder}` });
      } catch (e) { res.push({ r: round, city: raw.name, ok: false, fails: ['ERROR ' + e.message] }); }
    }
    return { pass: `${res.filter(r => r.ok).length}/${res.length}`, res };
  },
};
'boot ok';
