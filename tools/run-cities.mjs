// Random-city test runner. Grades the engine in <engineDir> against the
// saved Open-Meteo responses in tools/fixtures (r0 = first 5 cities,
// r1..r10 = ten rounds of ten) using city-check.js (criteria C1–C7).
// Usage: node tools/run-cities.mjs warmer 0,1,2,3,4,5,6,7,8,9,10 [--full] [--only=City,City]
// New fixtures come from tools/browser-boot.js (WT.fetchCity) in a browser,
// since Open-Meteo is fetched client-side.
import fs from 'node:fs';
import path from 'node:path';
const [, , dir, rounds, ...flags] = process.argv;
const full = flags.includes('--full');
const only = flags.find(f => f.startsWith('--only='))?.slice(7).split(',');
const fixtures = process.env.FIXTURES || new URL('./fixtures', import.meta.url).pathname;
const W = await import(path.resolve(dir, 'weather-data.js'));
const A = await import(path.resolve(dir, 'advice-rules.js'));
const C = await import(path.resolve(dir, 'card-action.js'));
const K = await import(new URL('./city-check.js', import.meta.url));
console.debug = () => {};
let pass = 0, total = 0; const byC = {};
for (const r of rounds.split(',')) {
  for (const raw of JSON.parse(fs.readFileSync(`${fixtures}/r${r}.json`, 'utf8'))) {
    if (raw.error || (only && !only.includes(raw.name))) continue;
    total++;
    let line;
    try {
      const p = W.parse(raw.d, raw.air, new Date(raw.now)); p.temperatureUnit = 'C';
      const html = A.buildProse(p).html, card = C.cardAction(p);
      const j = K.judge(raw, { html, card, detail: k => A.pillDetailHTML(k, p)?.html ?? null });
      if (!j.fails.length) pass++;
      j.fails.forEach(f => (byC[f.c] = (byC[f.c] || 0) + 1));
      const P = j.parsed, T = j.truth;
      const pills = P.pills.map(x => (x.warn ? '!' : x.exp ? '>' : '') + x.icon + ':' + x.value).join(' ');
      const more = (/<span class="action-more">([\s\S]*?)<\/span>/.exec(html)?.[1] || '').replace(/<[^>]+>/g, '');
      line = `${j.fails.length ? 'FAIL' : 'ok  '} r${r} ${raw.name} ${T.nowHour}h | ${P.head} | ${P.action}${more ? ' // ' + more : ''} | [${pills}] | card: ${card}` +
        (j.fails.length ? `\n      ${j.fails.map(f => f.c + ' ' + f.msg).join('\n      ')}` : '') +
        (full ? `\n      truth: now ${p.nowTemp} y ${p.yesterdayNowTemp} feels ${p.feels} fmin ${T.feelsMin} fmax ${T.feelsMax} swing ${Math.round(T.swing)} gust ${Math.round(T.gustMax)} uv ${T.uvMax} aqi ${T.aqi} rain ${T.rain} snow ${T.snow}/${T.snowCm}cm thunder ${T.thunder} pollen ${T.pollenHigh}` : '');
    } catch (e) { line = `ERR  r${r} ${raw.name} ${e.stack.split('\n').slice(0, 3).join(' ')}`; }
    console.log(line);
  }
}
console.log(`PASS ${pass}/${total}`, JSON.stringify(byC));
