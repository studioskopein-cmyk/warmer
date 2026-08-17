// ============================================================================
// Warmer Narrative Engine v4.0 — Dominant-First Single-Sentence
//
// 핵심 원칙:
//   1. MCDA가 dominant signal을 결정 (deterministic)
//   2. 엔진이 dominant 기반 영문 seed sentence 생성 (deterministic)
//   3. Gemini는 polish만 담당 (probabilistic, narrow scope)
//   4. 출력은 단일 string — UI title/subtitle 분리 없음
//   5. 영문이 native, 한국어/기타는 polish 단계에서 번역
//
// 아키텍처:
//   Stage 1-3: 신호 정량화 + 우선순위 (변경 없음)
//   Stage 4:   Seed 구성 (NEW - 결정론적 라이브러리)
//   Stage 5:   LLM polish (NEW - 좁은 역할)
// ============================================================================

// ─────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────
export interface WeatherInput {
  feelsLike: number;
  yesterdayDelta: number;
  uvIndex: number | null;
  windSpeed: number;
  precipProb: number;
  eveningDelta: number;
}

export interface Severities {
  temp: number; delta: number; uv: number;
  wind: number; rain: number; eve: number;
}

export interface SalienceScore {
  severity: number; weight: number; score: number;
}

export type SalienceScores = Record<keyof Severities, SalienceScore>;

export interface RankedSignal extends SalienceScore {
  factor: keyof Severities;
}

export interface DocumentPlan {
  ranked: RankedSignal[];
  core: RankedSignal[];
  secondary: RankedSignal[];
}

// Dominant signal — 출력의 첫 부분을 결정하는 단일 신호
export type DominantFactor =
  | 'rain' | 'wind' | 'cold_delta' | 'warm_delta'
  | 'hot' | 'cold' | 'uv' | 'eve' | 'mild';

export interface Dominant {
  factor: DominantFactor;
  severity: number;
  direction: 'up' | 'down' | 'neutral';
  // true only when selectDominant() bumped temp ahead of a higher-ranked delta
  // signal (extreme feelsLike + temp severity>=3). Lets buildSeed() know the
  // resulting hot/cold factor is standing in for what would otherwise have
  // been a warm_delta/cold_delta seed, so it can pick delta-flavored wording.
  overriddenFromDelta?: boolean;
}

export interface NarrativeV4 {
  text: string;             // 단일 출력 — UI에 그대로 표시
  dominantFactor: string;   // 디버그/분석용
  chip?: string;            // 시각적 칩 (선택)
}

// ─────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────
export const WEIGHTS: Record<keyof Severities, number> = {
  temp: 1.0, delta: 0.9, rain: 1.0,
  wind: 0.7, uv: 0.6, eve: 0.6,
};

export const THRESHOLDS = {
  include: 1.5,
  core: 2.5,
  maxSignals: 3,
};

// ─────────────────────────────────────────────────────────────────────
// STAGE 1: SEVERITY
// ─────────────────────────────────────────────────────────────────────
export function severity(v: WeatherInput): Severities {
  const { feelsLike: fl, yesterdayDelta: dv, uvIndex: uv,
          windSpeed: ws, precipProb: pp, eveningDelta: ev } = v;

  const sevTemp = (() => {
    if (fl >= 17 && fl <= 24) return 1;
    if ((fl >= 12 && fl < 17) || (fl > 24 && fl <= 27)) return 2;
    if ((fl >= 6 && fl < 12) || (fl > 27 && fl <= 32)) return 3;
    return 4;
  })();

  const sevDelta = (() => {
    const a = Math.abs(dv);
    if (a < 2) return 0; if (a < 5) return 1;
    if (a < 8) return 2; if (a < 11) return 3;
    return 4;
  })();

  const sevUV = (() => {
    // No fallback: a missing reading scores 0, which THRESHOLDS.include
    // (below) already filters out of ranked signals — so "no data" is
    // excluded rather than silently treated as "definitely low UV".
    if (uv == null) return 0;
    if (uv < 3) return 0; if (uv < 6) return 1;
    if (uv < 8) return 2; if (uv < 11) return 3;
    return 4;
  })();

  const sevWind = (() => {
    if (ws < 3) return 0; if (ws < 5) return 1;
    if (ws < 8) return 2; if (ws < 11) return 3;
    return 4;
  })();

  const sevRain = (() => {
    if (pp < 30) return 0; if (pp < 50) return 1;
    if (pp < 70) return 2; if (pp < 85) return 3;
    return 4;
  })();

  const sevEve = (() => {
    if (ev < 4) return 0; if (ev < 6) return 1;
    if (ev < 8) return 2; if (ev < 10) return 3;
    return 4;
  })();

  return { temp: sevTemp, delta: sevDelta, uv: sevUV,
           wind: sevWind, rain: sevRain, eve: sevEve };
}

// ─────────────────────────────────────────────────────────────────────
// STAGE 2: SALIENCE
// ─────────────────────────────────────────────────────────────────────
export function salience(s: Severities): SalienceScores {
  const out = {} as SalienceScores;
  (Object.keys(WEIGHTS) as Array<keyof Severities>).forEach(k => {
    out[k] = { severity: s[k], weight: WEIGHTS[k],
               score: +(s[k] * WEIGHTS[k]).toFixed(2) };
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// STAGE 3: DOCUMENT PLAN
// ─────────────────────────────────────────────────────────────────────
export function planDocument(scores: SalienceScores): DocumentPlan {
  const ranked = (Object.entries(scores) as Array<[keyof Severities, SalienceScore]>)
    .map(([factor, s]) => ({ factor, ...s }))
    .filter(s => s.score >= THRESHOLDS.include)
    .sort((a, b) => b.score - a.score)
    .slice(0, THRESHOLDS.maxSignals);

  return {
    ranked,
    core: ranked.filter(s => s.score >= THRESHOLDS.core),
    secondary: ranked.filter(s => s.score < THRESHOLDS.core),
  };
}

// ─────────────────────────────────────────────────────────────────────
// STAGE 4a: DOMINANT SELECTION
// Plan의 top-ranked signal을 dominant로 매핑.
// temp + delta 조합 시: delta가 우선 (어제 대비가 더 인지적으로 중요)
// ─────────────────────────────────────────────────────────────────────
export function selectDominant(plan: DocumentPlan, input: WeatherInput): Dominant {
  if (plan.ranked.length === 0) {
    return { factor: 'mild', severity: 0, direction: 'neutral' };
  }

  const dv = input.yesterdayDelta;
  const fl = input.feelsLike;

  // 1. 우선순위 조정: 매우 덥거나 추울 때는 delta보다 temp 자체를 우선시함 (행동 지침 중심)
  const tempSignal = plan.ranked.find(s => s.factor === 'temp');
  const deltaSignal = plan.ranked.find(s => s.factor === 'delta');
  
  let top = plan.ranked[0];
  let overriddenFromDelta = false;

  if (tempSignal && deltaSignal && top.factor === 'delta') {
    // 27도 이상이거나 6도 미만인 경우, delta보다 temp를 우선 순위로 올림
    if ((fl >= 27 || fl < 6) && tempSignal.severity >= 3) {
      top = tempSignal;
      overriddenFromDelta = true;
    }
  }

  switch (top.factor) {
    case 'rain':
      return { factor: 'rain', severity: top.severity, direction: 'neutral' };
    case 'wind':
      return { factor: 'wind', severity: top.severity, direction: 'neutral' };
    case 'uv':
      return { factor: 'uv', severity: top.severity, direction: 'neutral' };
    case 'eve':
      return { factor: 'eve', severity: top.severity, direction: 'down' };
    case 'delta':
      return {
        factor: dv > 0 ? 'warm_delta' : 'cold_delta',
        severity: top.severity,
        direction: dv > 0 ? 'up' : 'down',
      };
    case 'temp':
      return {
        factor: fl >= 27 ? 'hot' : fl < 6 ? 'cold' : 'mild',
        severity: top.severity,
        direction: 'neutral',
        overriddenFromDelta,
      };
    default:
      return { factor: 'mild', severity: 0, direction: 'neutral' };
  }
}

// ─────────────────────────────────────────────────────────────────────
// STAGE 4b: SEED SENTENCE LIBRARY (English-first)
// Soo의 영문 라이브러리. Severity × factor → seed sentence.
// ─────────────────────────────────────────────────────────────────────
const SEEDS: Record<DominantFactor, Record<number, string>> = {
  rain: {
    4: "Heavy rain today — umbrella is non-negotiable.",
    3: "Rain rolling in — bring an umbrella.",
    2: "Showers possible — umbrella's worth tossing in your bag.",
    1: "A little drizzle possible — you'll probably be fine without an umbrella.",
    0: "",
  },
  wind: {
    4: "Powerful wind today — a windproof shell makes a real difference.",
    3: "Wind's strong — a shell or windbreaker helps.",
    2: "Breezy out — something to block the wind helps.",
    1: "Light breeze, nothing serious.",
    0: "",
  },
  cold_delta: {
    4: "Massive drop from yesterday — coat weather, full stop.",
    3: "Sharply colder than yesterday — proper coat today.",
    2: "Noticeably cooler than yesterday — add a layer.",
    1: "A touch cooler than yesterday — fine with what you wore.",
    0: "",
  },
  warm_delta: {
    4: "Much warmer than yesterday — leave the coat at home.",
    3: "Warmer than yesterday — lighter layer works.",
    2: "A touch warmer than yesterday — you can lighten up.",
    1: "Slightly warmer than yesterday — dress similarly.",
    0: "",
  },
  hot: {
    4: "Hot one — light fabric, shade, water.",
    3: "Hot day — keep it light and stay hydrated.",
    2: "Warm out — light clothing recommended.",
    1: "Pleasantly warm.",
    0: "",
  },
  cold: {
    4: "Serious cold today — bundle properly.",
    3: "Cold day — heavy coat, no skimping.",
    2: "Chilly out — proper jacket weather.",
    1: "Cool out — a layer's enough.",
    0: "",
  },
  uv: {
    4: "Extreme UV — sunglasses, SPF, shade when you can.",
    3: "Strong sun — sunglasses and SPF today.",
    2: "Sun's notable — sunglasses recommended.",
    1: "Mild sun, nothing to plan around.",
    0: "",
  },
  eve: {
    4: "Mild now, sharp drop by evening — bring something for later.",
    3: "Mild now, sharp drop by evening — bring something for later.",
    2: "Cools off in the evening — a light layer for later helps.",
    1: "Slight cool-down in the evening.",
    0: "",
  },
  mild: {
    0: "Easy one out there, dress how you did yesterday.",
  },
};

export function buildSeed(dominant: Dominant, input: WeatherInput): string {
  const sevMap = SEEDS[dominant.factor];
  if (!sevMap) return SEEDS.mild[0];
  // mild는 severity 0만 있음
  if (dominant.factor === 'mild') return sevMap[0];
  // 다른 factor는 1-4
  const sev = Math.max(1, Math.min(4, dominant.severity));
  let seed = sevMap[sev] || sevMap[2] || SEEDS.mild[0];

  // Refinement: selectDominant() bumped temp ahead of a higher-ranked delta
  // signal (see overriddenFromDelta) — the resulting hot/cold seed should
  // still read as a day-over-day change, not a generic hot/cold line.
  // No cold-side text exists yet (SEEDS.cold_delta's "coat" wording already
  // reads naturally at low feelsLike, so there's no awkward-mention problem
  // to fix there) — only the hot case is handled for now.
  if (dominant.factor === 'hot' && dominant.overriddenFromDelta && sev >= 3) {
    seed = "Much warmer than yesterday — keep it light and stay cool.";
  }

  return seed;
}

// ─────────────────────────────────────────────────────────────────────
// STAGE 4c: SECONDARY OVERLAY (선택적 보조절)
// dominant 외 secondary 신호가 있을 때, 자연스러운 conjunctive clause.
// ─────────────────────────────────────────────────────────────────────
const OVERLAYS: Record<string, string> = {
  'cold_delta+wind': 'the wind makes it feel sharper',
  'cold+wind': 'the wind makes it feel sharper',
  'cold_delta+eve': 'it gets colder after dark',
  'cold+eve': 'it gets colder after dark',
  'rain+wind': 'the wind is blowing it sideways',
  'hot+uv': 'the sun is intense',
  'hot+delta': 'it\'s much warmer than yesterday',
  'warm_delta+uv': 'the sun is strong out',
  'mild+eve': "you'll want a layer for tonight",
  'mild+uv': 'just watch the sun',
};

export function buildOverlay(dominant: Dominant, plan: DocumentPlan): string {
  const dominantFactors: DominantFactor[] = ['rain', 'wind', 'cold_delta', 'warm_delta',
                                              'hot', 'cold', 'uv', 'eve', 'mild'];
  if (!dominantFactors.includes(dominant.factor)) return '';

  // dominant이 이미 점유한 raw factor를 secondary에서 제외
  const dominantRawFactor =
    dominant.factor === 'cold_delta' || dominant.factor === 'warm_delta' ? 'delta' :
    dominant.factor === 'hot' || dominant.factor === 'cold' ? 'temp' :
    dominant.factor === 'mild' ? null :
    dominant.factor as keyof Severities;

  const secondaries = plan.ranked
    .filter(s => s.factor !== dominantRawFactor)
    // delta is already voiced in the seed itself when overriddenFromDelta —
    // an overlay repeating "than yesterday" would duplicate it.
    .filter(s => !(dominant.overriddenFromDelta && s.factor === 'delta'))
    .map(s => s.factor);

  for (const sec of secondaries) {
    const key = `${dominant.factor}+${sec}`;
    if (OVERLAYS[key]) return OVERLAYS[key];
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────
// STAGE 5: COMPOSE — seed + overlay → final English text
// ─────────────────────────────────────────────────────────────────────
export function composeEnglish(seed: string, overlay: string): string {
  if (!overlay) return seed;
  // seed 끝의 마침표를 없애고 overlay를 자연스럽게 붙임
  const seedTrimmed = seed.replace(/\.\s*$/, '');
  return `${seedTrimmed} — ${overlay}.`;
}

// ─────────────────────────────────────────────────────────────────────
// STAGE 6: LLM POLISH (좁은 역할 — 다른 언어로 번역 + 자연스러움 보정)
// ─────────────────────────────────────────────────────────────────────
async function llmPolish(
  englishText: string,
  apiKey: string,
  lang: string,
  dominant: Dominant
): Promise<string> {
  // 영어면 그대로 반환 (polish 불필요)
  if (lang === 'en') return englishText;

  const langName = lang === 'ko' ? 'Korean (존댓말)' : lang;

  const prompt = `You are translating a weather narrative for the brand "Warmer".
Voice: caring, calm, practical, observant. "Warm, never cheesy. Smart, never clinical."

CRITICAL RULES:
1. Translate to ${langName}.
2. Keep ONE sentence. Max ~30 characters in Korean / ~14 words in English.
3. The DOMINANT EVENT must lead the sentence: ${dominant.factor} (severity ${dominant.severity}/4).
4. Do NOT add numbers, percentages, or units. Pure prose.
5. Do NOT add disclaimers like "(uncertain)" or "(maybe)".
6. Return ONLY the translated sentence, no JSON, no quotes.

English source: "${englishText}"

Translated sentence:`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 200 },
      }),
    });

    if (!r.ok) throw new Error(`Gemini ${r.status}`);
    const data: any = await r.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    // 따옴표, JSON 잔재 제거
    text = text.trim().replace(/^["'`]|["'`]$/g, '').replace(/^\{.*?:\s*"?|"?\s*\}$/g, '');
    return text || englishText;
  } catch (e) {
    console.error('LLM polish failed, returning English:', e);
    return englishText; // graceful degradation
  }
}

// ─────────────────────────────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────────────────────────────
export async function generate(
  input: WeatherInput,
  apiKey: string,
  lang: string = 'en'
): Promise<{ narrative: NarrativeV4; debug: any }> {
  const severities = severity(input);
  const scores = salience(severities);
  const plan = planDocument(scores);
  const dominant = selectDominant(plan, input);
  const seed = buildSeed(dominant, input);
  const overlay = buildOverlay(dominant, plan);
  const englishText = composeEnglish(seed, overlay);
  const finalText = await llmPolish(englishText, apiKey, lang, dominant);

  return {
    narrative: {
      text: finalText,
      dominantFactor: dominant.factor,
      chip: chipForDominant(dominant),
    },
    debug: {
      severities, scores, plan, dominant,
      seed, overlay, englishText,
      itemCategories: deriveItemCategories(input, severities, plan),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// CHIP — dominant 기반 시각적 태그
// ─────────────────────────────────────────────────────────────────────
function chipForDominant(d: Dominant): string {
  const chips: Record<DominantFactor, string> = {
    rain: '🌂 Rain',
    wind: '💨 Windy',
    cold_delta: '🥶 Colder',
    warm_delta: '🌤 Warmer',
    hot: '🥵 Hot',
    cold: '🧥 Cold',
    uv: '🕶 UV',
    eve: '🌙 Evening drop',
    mild: '✨ Easy',
  };
  return chips[d.factor];
}

// ─────────────────────────────────────────────────────────────────────
// B2B EXTENSION (변경 없음)
// ─────────────────────────────────────────────────────────────────────
function deriveItemCategories(
  values: WeatherInput,
  severities: Severities,
  plan: DocumentPlan
) {
  const cats: Array<{ cat: string; clo?: number }> = [];
  const fl = values.feelsLike;
  if      (fl >= 25) cats.push({ cat: 'light_top',     clo: 0.3 });
  else if (fl >= 20) cats.push({ cat: 'long_sleeve',   clo: 0.6 });
  else if (fl >= 15) cats.push({ cat: 'light_jacket',  clo: 1.0 });
  else if (fl >= 10) cats.push({ cat: 'jacket',        clo: 1.5 });
  else if (fl >= 5 ) cats.push({ cat: 'coat',          clo: 2.0 });
  else if (fl >= 0 ) cats.push({ cat: 'heavy_coat',    clo: 2.5 });
  else               cats.push({ cat: 'extreme_cold',  clo: 3.0 });

  const factors = plan.ranked.map(s => s.factor);
  if (factors.includes('rain') && severities.rain >= 2) cats.push({ cat: 'umbrella' });
  if (factors.includes('wind') && severities.wind >= 2) cats.push({ cat: 'windbreaker' });
  if (factors.includes('uv')   && severities.uv   >= 2) cats.push({ cat: 'sunglasses' });
  if (factors.includes('eve')  && severities.eve  >= 2) cats.push({ cat: 'layering_piece' });
  return cats;
}