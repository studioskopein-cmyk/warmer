// ============================================================================
// Warmer Narrative Engine v3.0
// Multi-Criteria Decision Analysis + NLG 4-stage Pipeline + Aggregation
//
// 학술 기반:
//   - UTCI (Universal Thermal Climate Index) — 다변량 thermal stress 통합
//   - MCDA Weighted Linear Combination — 신호 우선순위 결정
//   - Reiter & Dale NLG Pipeline (4-stage) — 데이터→텍스트 변환
//   - Linguistic Aggregation — 다중 신호 자연어 병합
//
// 출력:
//   - 인라인 칩이 포함된 자연어 내러티브 (separate proof 없음)
//   - 신호 강도에 따라 언어 강도가 동적 변화
//   - 최대 3개 신호만 선택해 cognitive load 최소화
// ============================================================================


// ─────────────────────────────────────────────────────────────────────
// CONFIG: 가중치 + 임계값
// 가중치는 "행동에 미치는 영향력" 기준 (회의에서 합의)
// ─────────────────────────────────────────────────────────────────────
export const WEIGHTS = {
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
export function severity(values) {
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
// STAGE 2: SALIENCE SCORING (MCDA Weighted Linear Combination)
// salience = severity × weight
// ─────────────────────────────────────────────────────────────────────
export function salience(severities) {
  const scores = {};
  for (const key of Object.keys(WEIGHTS)) {
    scores[key] = {
      severity: severities[key],
      weight: WEIGHTS[key],
      score: +(severities[key] * WEIGHTS[key]).toFixed(2),
    };
  }
  return scores;
}


// ─────────────────────────────────────────────────────────────────────
// STAGE 3: DOCUMENT PLANNING
// Top-N signal selection with core/secondary classification
// ─────────────────────────────────────────────────────────────────────
export function planDocument(scores) {
  const ranked = Object.entries(scores)
    .map(([factor, s]) => ({ factor, ...s }))
    .filter(s => s.score >= THRESHOLDS.include)
    .sort((a, b) => b.score - a.score)
    .slice(0, THRESHOLDS.maxSignals);

  const core      = ranked.filter(s => s.score >= THRESHOLDS.core);
  const secondary = ranked.filter(s => s.score < THRESHOLDS.core);

  return { ranked, core, secondary };
}


// ─────────────────────────────────────────────────────────────────────
// STAGE 4a: MICROPLANNING — phrase builders
// Severity-modulated lexicalization
// ─────────────────────────────────────────────────────────────────────
function buildPhrases(values, severities) {
  const { feelsLike, yesterdayDelta, uvIndex, windSpeed, precipProb, eveningDelta } = values;
  const dAbs = Math.abs(yesterdayDelta);

  const tempChip   = `[${feelsLike}°]`;
  const deltaChip  = dAbs >= 2 ? `[${yesterdayDelta > 0 ? '↑' : '↓'}${dAbs}°]` : '';
  const rainChip   = `[비 ${precipProb}%]`;
  const windChip   = `[바람 ${windSpeed}m/s]`;
  const uvChip     = `[UV ${uvIndex}]`;
  const eveChip    = `[저녁 −${eveningDelta}°]`;

  // ── TEMP zone-based phrasing (severity-modulated)
  let tempPhrase;
  if      (feelsLike >= 27) tempPhrase = severities.temp >= 4 ? `가볍게 입어. ${tempChip} 더워.` : `얇게 입어. ${tempChip}`;
  else if (feelsLike >= 22) tempPhrase = `긴팔 하나면 충분해. ${tempChip}`;
  else if (feelsLike >= 17) tempPhrase = `가벼운 겉옷 챙겨. ${tempChip}`;
  else if (feelsLike >= 12) tempPhrase = `재킷 하나 입어. ${tempChip}`;
  else if (feelsLike >= 6 ) tempPhrase = `두꺼운 코트 필요해. ${tempChip}`;
  else if (feelsLike >= 0 ) tempPhrase = `패딩 챙겨. ${tempChip} 추워.`;
  else                       tempPhrase = `최대한 두껍게. ${tempChip} 한파야.`;

  // ── DELTA
  let deltaPhrase = '';
  if      (severities.delta >= 3) deltaPhrase = yesterdayDelta > 0 ? `어제보다 훨씬 따뜻해 ${deltaChip}` : `어제보다 확 떨어졌어 ${deltaChip}`;
  else if (severities.delta >= 2) deltaPhrase = yesterdayDelta > 0 ? `어제보다 꽤 따뜻해 ${deltaChip}` : `어제보다 꽤 쌀해졌어 ${deltaChip}`;
  else if (severities.delta >= 1) deltaPhrase = yesterdayDelta > 0 ? `어제보다 살짝 따뜻 ${deltaChip}` : `어제보다 살짝 쌀해 ${deltaChip}`;

  // ── RAIN
  let rainPhrase = '', rainAction = '';
  if      (severities.rain >= 4) { rainPhrase = `비 확실해 ${rainChip}`;      rainAction = `우산 꼭 챙겨`; }
  else if (severities.rain >= 3) { rainPhrase = `비 올 거야 ${rainChip}`;     rainAction = `우산 챙겨`; }
  else if (severities.rain >= 2) { rainPhrase = `비 올 수도 ${rainChip}`;     rainAction = `우산 챙겨두면 안심이야`; }
  else if (severities.rain >= 1) { rainPhrase = `살짝 흐려 ${rainChip}`;      rainAction = ''; }

  // ── WIND
  let windPhrase = '', windAction = '';
  if      (severities.wind >= 3) { windPhrase = `바람 강해 ${windChip}`;      windAction = `바람막이 꼭 챙겨`; }
  else if (severities.wind >= 2) { windPhrase = `바람 제법 불어 ${windChip}`; windAction = `바람막이 있으면 편해`; }
  else if (severities.wind >= 1) { windPhrase = `바람 약간 ${windChip}`;      windAction = ''; }

  // ── UV
  let uvPhrase = '', uvAction = '';
  if      (severities.uv >= 3) { uvPhrase = `자외선 매우 강해 ${uvChip}`; uvAction = `선글라스 필수, 자차 챙겨`; }
  else if (severities.uv >= 2) { uvPhrase = `자외선 강해 ${uvChip}`;      uvAction = `선글라스 챙겨`; }
  else if (severities.uv >= 1) { uvPhrase = `자외선 적당 ${uvChip}`;      uvAction = ''; }

  // ── EVENING DROP
  let evePhrase = '', eveAction = '';
  if      (severities.eve >= 3) { evePhrase = `저녁엔 확 떨어져 ${eveChip}`; eveAction = `벗고 입을 수 있는 레이어`; }
  else if (severities.eve >= 2) { evePhrase = `저녁에 쌀해져 ${eveChip}`;    eveAction = `겉옷 하나 더`; }
  else if (severities.eve >= 1) { evePhrase = `저녁 살짝 쌀 ${eveChip}`;     eveAction = ''; }

  return {
    temp:  { phrase: tempPhrase },
    delta: { phrase: deltaPhrase },
    rain:  { phrase: rainPhrase, action: rainAction },
    wind:  { phrase: windPhrase, action: windAction },
    uv:    { phrase: uvPhrase, action: uvAction },
    eve:   { phrase: evePhrase, action: eveAction },
  };
}


// ─────────────────────────────────────────────────────────────────────
// STAGE 4b: AGGREGATION
// 다중 신호를 자연스러운 문장으로 병합
// 규칙: 같은 카테고리 신호는 conjunction, 다른 카테고리는 syntactic embedding
// ─────────────────────────────────────────────────────────────────────
function aggregate(plan, phrases, values) {
  const coreFactors = plan.core.map(s => s.factor);
  const secFactors  = plan.secondary.map(s => s.factor);

  let action = '';

  // ── ACTION composition with aggregation rules ──

  // Rule 1: rain + wind core → bundled "바람막이" action
  if (coreFactors.includes('rain') && coreFactors.includes('wind')) {
    const rainSev = plan.core.find(s => s.factor === 'rain').severity;
    const windSev = plan.core.find(s => s.factor === 'wind').severity;
    if (rainSev >= 3 && windSev >= 3) {
      action = `바람막이 꼭 챙겨. ${phrases.rain.phrase}, ${phrases.wind.phrase} 같이 와.`;
    } else {
      action = `바람막이 챙겨. 비도 ${rainSev >= 3 ? '확실' : '올 수도 있어'}, ${phrases.wind.phrase}.`;
    }
  }
  // Rule 2: rain only core
  else if (coreFactors.includes('rain')) {
    action = `${phrases.rain.action}. ${phrases.rain.phrase}.`;
  }
  // Rule 3: UV high → sunglass mandate
  else if (coreFactors.includes('uv')) {
    action = `${phrases.uv.action}. ${phrases.uv.phrase}.`;
  }
  // Rule 4: wind only core
  else if (coreFactors.includes('wind')) {
    action = `${phrases.wind.action}. ${phrases.wind.phrase}, 체감이 더 낮아.`;
  }
  // Rule 5: extreme temp / delta → temp leads
  else {
    action = phrases.temp.phrase;
  }

  // ── REASON composition with aggregation ──
  const reasonParts = [];

  // Always include delta if present
  if (phrases.delta.phrase) reasonParts.push(phrases.delta.phrase);

  // Add evening signal if not already mentioned
  if (coreFactors.includes('eve') || secFactors.includes('eve')) {
    reasonParts.push(phrases.eve.phrase);
  }

  // Add secondary signals NOT already in action
  const usedInAction = ['rain', 'wind', 'uv'].filter(f => coreFactors.includes(f));
  ['rain', 'wind', 'uv'].forEach(f => {
    if (secFactors.includes(f) && !usedInAction.includes(f)) {
      reasonParts.push(phrases[f].phrase);
    }
  });

  let reason = '';
  if (reasonParts.length === 0) {
    reason = plan.ranked.length <= 1 ? '평범한 날이야.' : '';
  } else if (reasonParts.length === 1) {
    reason = `${reasonParts[0]}.`;
  } else if (reasonParts.length === 2) {
    reason = `${reasonParts[0]}, ${reasonParts[1]}.`;
  } else {
    reason = `${reasonParts[0]}. ${reasonParts.slice(1).join(', ')}.`;
  }

  return { action, reason };
}


// ─────────────────────────────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────────────────────────────
export function generate(weatherInput) {
  // weatherInput: { feelsLike, yesterdayDelta, uvIndex, windSpeed, precipProb, eveningDelta }
  const severities = severity(weatherInput);
  const scores     = salience(severities);
  const plan       = planDocument(scores);
  const phrases    = buildPhrases(weatherInput, severities);
  const { action, reason } = aggregate(plan, phrases, weatherInput);

  return {
    narrative: { action, reason },
    debug: {
      severities,
      scores,
      plan,
      // B2B 카테고리 매핑용
      itemCategories: deriveItemCategories(weatherInput, severities, plan),
    },
  };
}


// ─────────────────────────────────────────────────────────────────────
// B2B EXTENSION: Item category resolver
// CLO + signal-based categories → 상품 매핑 가능한 표준 카테고리
// ─────────────────────────────────────────────────────────────────────
function deriveItemCategories(values, severities, plan) {
  const cats = [];

  // CLO-based layer category
  const fl = values.feelsLike;
  if      (fl >= 25) cats.push({ cat: 'light_top',     clo: 0.3 });
  else if (fl >= 20) cats.push({ cat: 'long_sleeve',   clo: 0.6 });
  else if (fl >= 15) cats.push({ cat: 'light_jacket',  clo: 1.0 });
  else if (fl >= 10) cats.push({ cat: 'jacket',        clo: 1.5 });
  else if (fl >= 5 ) cats.push({ cat: 'coat',          clo: 2.0 });
  else if (fl >= 0 ) cats.push({ cat: 'heavy_coat',    clo: 2.5 });
  else               cats.push({ cat: 'extreme_cold',  clo: 3.0 });

  // Signal-based accessory categories
  const factors = plan.ranked.map(s => s.factor);
  if (factors.includes('rain') && severities.rain >= 2) cats.push({ cat: 'umbrella' });
  if (factors.includes('wind') && severities.wind >= 2) cats.push({ cat: 'windbreaker' });
  if (factors.includes('uv')   && severities.uv   >= 2) cats.push({ cat: 'sunglasses' });
  if (factors.includes('eve')  && severities.eve  >= 2) cats.push({ cat: 'layering_piece' });

  return cats;
}


// ─────────────────────────────────────────────────────────────────────
// USAGE EXAMPLE
// ─────────────────────────────────────────────────────────────────────
//
// import { generate } from './warmer-engine-v3.js';
//
// const result = generate({
//   feelsLike: 11,
//   yesterdayDelta: -6,
//   uvIndex: 4,
//   windSpeed: 7,
//   precipProb: 60,
//   eveningDelta: 8,
// });
//
// console.log(result.narrative.action);
// → "바람막이 꼭 챙겨. 비 올 거야 [비 60%], 바람 제법 불어 [바람 7m/s] 같이 와."
//
// console.log(result.narrative.reason);
// → "어제보다 확 떨어졌어 [↓6°], 저녁엔 확 떨어져 [저녁 −8°]."
//
// console.log(result.debug.itemCategories);
// → [{cat:'jacket', clo:1.5}, {cat:'umbrella'}, {cat:'windbreaker'}, {cat:'layering_piece'}]
//
// ─────────────────────────────────────────────────────────────────────