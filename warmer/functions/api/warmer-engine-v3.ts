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
  plan: DocumentPlan,
  lang: string = 'ko'
): Promise<NarrativeOutput> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const prompt = `[페르소나 및 정체성 (Archetype)]
- 당신은 날씨 앱 'Warmer'의 AI 캐스터입니다. 당신의 어조는 Caring(다정한), Calm(차분한), Practical(실용적인), Observant(관찰력 있는) 상태를 유지해야 합니다.
- **절대 금지:** 과하게 감정적이거나 유치한 표현, 억지로 귀여운 척하는 문체(예: "~형들", "날씨 밀당" 등)는 "Warm, never cheesy" 원칙에 위배되므로 절대로 사용하지 마십시오.

[불확실성 제어 지침 (Honesty over certainty theater)]
- 데이터 수집 과정에서 오류가 있거나, 여러 날씨 예측 모델 간의 격차가 커서 불확실성이 높을 때, 시스템의 기술적 에러를 사용자에게 핑계 대며 노출하지 마십시오.
- 날씨가 불확실할수록 유저에게 변동성을 솔직하게 안내하되, 유저가 손해 보지 않을 '가장 안전하고 실용적인 대안 행동'을 먼저 제안하십시오 (Say the useful thing first).

[서사 작성 규칙]
1. "날씨에 맞춰 편한 옷차림을 준비하세요", "외출 시 날씨를 확인하세요"와 같은 무의미하고 당연한 문장은 절대로 작성하지 마십시오.
2. 한국어 버전은 나를 과보호하듯 세심하게 챙겨주는 차분한 반말/존댓말 혼용 어투를 쓰고, 영어 버전은 불필요한 미사여구 없이 간결하고 유용한 문장으로 작성하십시오.
3. 상단 대형 문구(action)와 하단 설명 문구(reason)는 완벽하게 하나의 일관된 맥락으로 이어져야 합니다.
4. Target Language: ${lang === 'en' ? 'English' : 'Korean'}

[입력 데이터]
Weather Data:
- Feels Like: ${weatherInput.feelsLike}°C
- Yesterday Change: ${weatherInput.yesterdayDelta}°C
- UV Index: ${weatherInput.uvIndex}
- Wind Speed: ${weatherInput.windSpeed}m/s
- Precipitation Probability: ${weatherInput.precipProb}%
- Evening Temperature Drop: ${weatherInput.eveningDelta}°C

Prioritized Signals (MCDA Result):
${plan.ranked.map(s => `- ${s.factor}: severity ${s.severity}/4 (Salience Score: ${s.score})`).join('\n')}

[JSON 출력 형식 예시]
{
  "action": "유저가 당장 취해야 할 가장 안전한 행동 제안",
  "reason": "왜 그 행동을 제안하는지 날씨의 유동성을 다정하게 설명"
}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { 
          responseMimeType: "application/json",
          temperature: 0.7 
        }
      })
    });

    if (!response.ok) throw new Error(`Gemini API Error: ${response.statusText}`);
    const data: any = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    
    // 마크다운 펜스 제거 후 파싱
    const cleanedText = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleanedText);
  } catch (error) {
    console.error("Gemini Narrative Error:", error);
    if (lang === 'en') {
      return {
        action: "Please carry a light outer layer that's easy to put on and take off.",
        reason: "There is some uncertainty in the weather data. Preparing for any situation is the safest way to start your day."
      };
    }
    return {
      action: "오늘은 입고 벗기 편한 가벼운 외투를 꼭 챙겨주세요.",
      reason: "날씨 정보를 읽어오는 중에 약간의 변동이 확인되었어요. 어떤 상황에도 대비할 수 있게 준비하는 게 가장 안전할 것 같아요."
    };
  }
}


// ─────────────────────────────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────────────────────────────
export async function generate(weatherInput: WeatherInput, apiKey: string, lang: string = 'ko') {
  const severities = severity(weatherInput);
  const scores     = salience(severities);
  const plan       = planDocument(scores);
  
  // LLM Narrative Generation
  const narrative = await generateNarrative(apiKey, weatherInput, plan, lang);

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