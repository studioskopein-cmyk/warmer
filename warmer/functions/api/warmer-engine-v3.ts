// ============================================================================
// Warmer Narrative Engine v3.0 (Hybrid AI Refactored)
// Multi-Criteria Decision Analysis + LLM Narrative Generation
//
// 학술 기반:
//   - UTCI (Universal Thermal Climate Index) — 다변량 thermal stress 통합
//   - MCDA Weighted Linear Combination — 신호 우선순위 결정
//
// 구조:
//   1. Data Analysis (Deterministic): severity, salience, planDocument
//   2. Narrative Generation (Probabilistic): Gemini 1.5 Flash
// ============================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";

export interface WeatherInput {
  feelsLike: number;
  yesterdayDelta: number;
  uvIndex: number;
  windSpeed: number;
  precipProb: number;
  eveningDelta: number;
}

export interface Severities {
  temp: number;
  delta: number;
  uv: number;
  wind: number;
  rain: number;
  eve: number;
}

export interface SalienceScore {
  severity: number;
  weight: number;
  score: number;
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

export interface NarrativeOutput {
  action: string;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────
// CONFIG: 가중치 + 임계값
// ─────────────────────────────────────────────────────────────────────
export const WEIGHTS: Record<keyof Severities, number> = {
  temp:  1.0,  // 옷차림 기본 결정
  delta: 0.9,  // 어제 대비 체감 변화 (사용자 가장 민감)
  rain:  1.0,  // 행동 직결 (우산 필수)
  wind:  0.7,  // 체감 보정
  uv:    0.6,  // 선글라스/자차
  eve:   0.6,  // 저녁 옷 추가
};

export const THRESHOLDS = {
  include: 1.5,  // 내러티브 포함 기준
  core:    2.5,  // 핵심 위치(action) 배치 기준
  maxSignals: 3, // cognitive load 제한
};


// ─────────────────────────────────────────────────────────────────────
// STAGE 1: SIGNAL ANALYSIS
// 각 팩터를 5단계 강도(0-4)로 정량화
// ─────────────────────────────────────────────────────────────────────
export function severity(values: WeatherInput): Severities {
  const { feelsLike, yesterdayDelta, uvIndex, windSpeed, precipProb, eveningDelta } = values;

  const sevTemp = (() => {
    if (feelsLike >= 17 && feelsLike <= 24) return 1;
    if ((feelsLike >= 12 && feelsLike < 17) || (feelsLike > 24 && feelsLike <= 27)) return 2;
    if ((feelsLike >= 6  && feelsLike < 12) || (feelsLike > 27 && feelsLike <= 32)) return 3;
    return 4;
  })();

  const sevDelta = (() => {
    const a = Math.abs(yesterdayDelta);
    if (a < 2)  return 0;
    if (a < 5)  return 1;
    if (a < 8)  return 2;
    if (a < 11) return 3;
    return 4;
  })();

  const sevUV = (() => {
    if (uvIndex < 3) return 0;
    if (uvIndex < 6) return 1;
    if (uvIndex < 8) return 2;
    if (uvIndex < 11) return 3;
    return 4;
  })();

  const sevWind = (() => {
    if (windSpeed < 3) return 0;
    if (windSpeed < 5) return 1;
    if (windSpeed < 8) return 2;
    if (windSpeed < 11) return 3;
    return 4;
  })();

  const sevRain = (() => {
    if (precipProb < 30) return 0;
    if (precipProb < 50) return 1;
    if (precipProb < 70) return 2;
    if (precipProb < 85) return 3;
    return 4;
  })();

  const sevEve = (() => {
    if (eveningDelta < 4) return 0;
    if (eveningDelta < 6) return 1;
    if (eveningDelta < 8) return 2;
    if (eveningDelta < 10) return 3;
    return 4;
  })();

  return { temp: sevTemp, delta: sevDelta, uv: sevUV, wind: sevWind, rain: sevRain, eve: sevEve };
}


// ─────────────────────────────────────────────────────────────────────
// STAGE 2: SALIENCE SCORING
// ─────────────────────────────────────────────────────────────────────
export function salience(severities: Severities): SalienceScores {
  const scores = {} as SalienceScores;
  (Object.keys(WEIGHTS) as Array<keyof Severities>).forEach(key => {
    scores[key] = {
      severity: severities[key],
      weight: WEIGHTS[key],
      score: +(severities[key] * WEIGHTS[key]).toFixed(2),
    };
  });
  return scores;
}


// ─────────────────────────────────────────────────────────────────────
// STAGE 3: DOCUMENT PLANNING
// ─────────────────────────────────────────────────────────────────────
export function planDocument(scores: SalienceScores): DocumentPlan {
  const ranked = (Object.entries(scores) as Array<[keyof Severities, SalienceScore]>)
    .map(([factor, s]) => ({ factor, ...s }))
    .filter(s => s.score >= THRESHOLDS.include)
    .sort((a, b) => b.score - a.score)
    .slice(0, THRESHOLDS.maxSignals);

  const core      = ranked.filter(s => s.score >= THRESHOLDS.core);
  const secondary = ranked.filter(s => s.score < THRESHOLDS.core);

  return { ranked, core, secondary };
}


// ─────────────────────────────────────────────────────────────────────
// STAGE 4: LLM NARRATIVE GENERATION (Gemini)
// ─────────────────────────────────────────────────────────────────────
async function generateNarrative(
  apiKey: string,
  weatherInput: WeatherInput,
  plan: DocumentPlan
): Promise<NarrativeOutput> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7,
    },
  });

  const prompt = `You are a professional weather caster. 
Based on the provided weather data and prioritized signals, generate a warm and natural weather narrative in Korean.

Weather Data:
- Feels Like: ${weatherInput.feelsLike}°C
- Yesterday Change: ${weatherInput.yesterdayDelta}°C
- UV Index: ${weatherInput.uvIndex}
- Wind Speed: ${weatherInput.windSpeed}m/s
- Precipitation Probability: ${weatherInput.precipProb}%
- Evening Temperature Drop: ${weatherInput.eveningDelta}°C

Prioritized Signals (MCDA Result):
${plan.ranked.map(s => `- ${s.factor}: severity ${s.severity}/4 (Salience Score: ${s.score})`).join('\n')}

Rules:
1. Return ONLY JSON with fields "action" (practical advice) and "reason" (weather background).
2. The "action" should focus on what the user should do (e.g., clothes, umbrella).
3. The "reason" should provide the context based on the signals, especially the prioritized ones.
4. Tone: Friendly, natural, and helpful (not rigid or robotic).

Example Output:
{
  "action": "얇은 셔츠 위에 가벼운 가디건 하나 챙기세요.",
  "reason": "오후엔 따뜻하지만 해가 지면 기온이 확 떨어지거든요."
}`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return JSON.parse(response.text()) as NarrativeOutput;
  } catch (error) {
    console.error("Gemini Narrative Error:", error);
    return {
      action: "날씨에 맞춰 편한 옷차림을 준비하세요.",
      reason: "데이터 분석 중 약간의 오류가 발생했지만, 전반적으로 평온한 날씨입니다."
    };
  }
}


// ─────────────────────────────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────────────────────────────
export async function generate(weatherInput: WeatherInput, apiKey: string) {
  const severities = severity(weatherInput);
  const scores     = salience(severities);
  const plan       = planDocument(scores);
  
  // LLM Narrative Generation
  const narrative = await generateNarrative(apiKey, weatherInput, plan);

  return {
    narrative,
    debug: {
      severities,
      scores,
      plan,
      itemCategories: deriveItemCategories(weatherInput, severities, plan),
    },
  };
}


// ─────────────────────────────────────────────────────────────────────
// B2B EXTENSION: Item category resolver
// ─────────────────────────────────────────────────────────────────────
function deriveItemCategories(values: WeatherInput, severities: Severities, plan: DocumentPlan) {
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