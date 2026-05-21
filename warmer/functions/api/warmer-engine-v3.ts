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
  action_guidance: string;
  context_clause: string;
  data_proof: string;
  summary_tag: string;
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
const SIGNAL_LABELS: Record<string, string> = {
  temp:  '체감온도 → 옷차림 결정',
  delta: '어제 대비 변화 → 체감 차이 강조',
  rain:  '강수 확률 → 우산 필요성',
  wind:  '풍속 → 체감온도 보정',
  uv:    'UV 지수 → 선글라스/자외선 차단',
  eve:   '저녁 기온 하강 → 레이어 필요',
};

async function generateNarrative(
  apiKey: string,
  weatherInput: WeatherInput,
  plan: DocumentPlan,
  lang: string = 'ko'
): Promise<NarrativeOutput> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const prompt = `[페르소나 및 정체성 (Archetype)]
- 당신은 날씨 앱 'Warmer'의 AI 캐스터입니다. 당신의 어조는 Caring(다정한), Calm(차분한), Practical(실용적인), Observant(관찰력 있는) 상태를 유지해야 합니다.

[Warmer 메시지 공식 v3]
출력은 반드시 다음 구조와 규칙을 엄격히 준수해야 합니다:
1. 구조: [Action guidance] — [context clause]. ([data proof])
2. 숫자 원칙: 절대값 단독 표기보다 Delta 값(↓4°, ↑3°)과 체감 온도(feels 14°C)를 최우선으로 결론 뒤 괄호 안에 병치할 것.
3. 강수 표현: 강수 확률 퍼센트(45%)보다 구체적인 시간 창(rain 2–5pm)을 우선하여 괄호 안에 넣을 것.
4. 불확실성 표현 4단계 규칙:
   - 확신 높음: "Rain this afternoon." (오후에 비가 와요.)
   - 중간: "Rain likely from 2pm." (2시부터 비가 올 것 같아요.)
   - 낮음: "Showers possible, mainly after 4." (4시 이후에 소나기 가능성이 있어요.)
   - 불확실: "Timing uncertain — an umbrella is a safe bet." (시간대는 불확실하지만 우산을 챙기는 게 안전해요.)

[서사 작성 규칙]
1. 상단 대형 문구(action_guidance)에는 유저가 3초 만에 확인해야 할 결론 문장 하나만 작성하십시오.
2. 하단 설명 문구(context_clause)에는 결론을 뒷받침하는 맥락 설명을 작성하십시오.
3. 근거(data_proof)에는 괄호 안에 들어갈 숫자 근거(Delta, 체감온도, 강수시간 등)를 작성하십시오.
4. 요약 태그(summary_tag)에는 오늘 날씨의 성격을 보여주는 짧은 핵심 키워드(이모지 포함, 예: 🧥 레이어드)를 작성하십시오.
5. Target Language: ${lang === 'en' ? 'English' : 'Korean'}

[입력 데이터]
Weather Data:
- Feels Like: ${weatherInput.feelsLike}°C
- Yesterday Change: ${weatherInput.yesterdayDelta}°C
- UV Index: ${weatherInput.uvIndex}
- Wind Speed: ${weatherInput.windSpeed}m/s
- Precipitation Probability: ${weatherInput.precipProb}%
- Evening Temperature Drop: ${weatherInput.eveningDelta}°C

Prioritized Signals (MCDA — 행동 우선순위 결정):
${plan.ranked.map(s => 
  `- [${s.factor}] ${SIGNAL_LABELS[s.factor]}: 강도 ${s.severity}/4, 가중치 ${s.score} → ${
    s.score >= 2.5 ? '핵심 action에 반드시 반영' : '보조 context에 포함'
  }`
).join('\n')}
${plan.ranked.length === 0 ? '- 오늘은 특이 신호 없음. 평범한 날씨.' : ''}

[JSON 출력 형식]
{
  "action_guidance": "Large action sentence",
  "context_clause": "Context explanation",
  "data_proof": "Delta/Feels/Time window values",
  "summary_tag": "🧥 Short Keyword"
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
        action_guidance: "Please carry a light outer layer.",
        context_clause: "Preparing for any situation is the safest way.",
        data_proof: "uncertain",
        summary_tag: "🧥 Layered"
      };
    }
    return {
      action_guidance: "입고 벗기 편한 가벼운 외투를 챙기세요.",
      context_clause: "어떤 상황에도 대비할 수 있게 준비하는 게 안전해요.",
      data_proof: "불확실",
      summary_tag: "🧥 레이어드"
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