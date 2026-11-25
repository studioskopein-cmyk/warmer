// Builds the AI advice facts for every saved city (tools/fixtures) and checks
// each one passes sanitizeFacts. Output: tools/out/advice-facts.json, which
// tools/advice-run.js posts to /api/translate from a browser.
// Usage: node tools/advice-facts.mjs warmer 0,1,...,10
import fs from 'node:fs';
import path from 'node:path';
const [, , dir, rounds] = process.argv;
const fixtures = new URL('./fixtures', import.meta.url).pathname;
const W = await import(path.resolve(dir, 'weather-data.js'));
const A = await import(path.resolve(dir, 'advice-rules.js'));
const AI = await import(path.resolve(dir, 'advice-ai.js'));
console.debug = () => {};
const out = []; let bad = 0;
for (const r of rounds.split(',')) for (const raw of JSON.parse(fs.readFileSync(`${fixtures}/r${r}.json`, 'utf8'))) {
  if (raw.error) continue;
  const p = W.parse(raw.d, raw.air, new Date(raw.now)); p.temperatureUnit = 'C';
  const facts = A.adviceFacts(p);
  const clean = AI.sanitizeFacts(facts);
  if (!clean) { bad++; console.log('REJECTED', raw.name, JSON.stringify(facts)); continue; }
  const d = A.decideDay(p);
  out.push({ city: raw.name, facts: clean, rule: { action: [d.action, d.more].filter(Boolean).join(' '), card: d.card } });
}
fs.mkdirSync(new URL('./out', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./out/advice-facts.json', import.meta.url), JSON.stringify(out));
const kinds = {}; out.forEach(o => o.facts.must_mention.forEach(m => (kinds[m.kind] = (kinds[m.kind] || 0) + 1)));
console.log(`${out.length} cities, ${bad} rejected by sanitizeFacts`, JSON.stringify(kinds));
