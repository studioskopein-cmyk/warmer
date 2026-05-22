/// <reference types="@cloudflare/workers-types" />
import { generate } from './warmer-engine-v3';

interface Env {
  GEMINI_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const body = await context.request.json() as any;
    const p = body.weatherContext;
    const lang = body.lang || 'en';   // ★ 기본을 'en'으로 변경
    const API_KEY = context.env.GEMINI_API_KEY;

    if (!API_KEY) {
      return new Response(
        JSON.stringify({ success: false, message: 'API Key missing' }),
        { status: 500, headers: corsHeaders }
      );
    }
    if (!p || p.temp == null || p.delta == null) {
      return new Response(
        JSON.stringify({ success: false, message: 'weatherContext with temp and delta is required' }),
        { status: 400, headers: corsHeaders }
      );
    }

    // 1) 입력 정규화 (기존 그대로)
    const feelsLike      = p.feels_like ?? p.feels ?? p.tMax ?? p.temp;
    const yesterdayDelta = p.delta;
    const windSpeed      = p.windSpeed ?? p.wind ?? 0;
    const uvIndex        = p.uvIndex ?? (p.highU ? 6 : 1);
    const precipProb     = p.precipProb ?? (p.slots?.length
                              ? Math.max(...p.slots.map((s: any) => s.rain ?? 0))
                              : 0);

    let eveningDelta = p.eveningDelta ?? 0;
    if (!p.eveningDelta && p.slots?.length) {
      const eveningSlot = p.slots[Math.min(p.slots.length - 1, 15)];
      if (eveningSlot) {
        eveningDelta = Math.max(0, (p.tMax ?? p.temp) - eveningSlot.temp);
      }
    }

    // 2) 엔진 호출 (v4 architecture)
    const engineResult = await generate(
      { feelsLike, yesterdayDelta, windSpeed, uvIndex, precipProb, eveningDelta },
      API_KEY,
      lang
    );

    // 3) 단일 출력 반환
    //    구버전 호환을 위해 translation 객체 안에 같은 키 이름으로 넣어두되,
    //    layer1만 사용하고 layer2/layer3는 비움. UI에서 layer1만 읽도록 수정 권장.
    const translation = {
      text: engineResult.narrative.text,            // ★ 새 단일 필드
      chip: engineResult.narrative.chip,            // 시각 칩
      dominantFactor: engineResult.narrative.dominantFactor,

      // 호환성 (UI 점진적 마이그레이션용)
      layer1: engineResult.narrative.text,
      layer2: '',
      layer3: engineResult.narrative.chip,
    };

    return new Response(
      JSON.stringify({
        success: true,
        translation,
        debug: engineResult.debug,                  // ★ 디버그용 (배포 후 제거 가능)
        timestamp: new Date().toISOString(),
      }),
      { headers: corsHeaders }
    );

  } catch (error: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Translation failed',
        message: error.message
      }),
      { status: 500, headers: corsHeaders }
    );
  }
};

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
};