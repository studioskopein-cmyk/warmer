/// <reference types="@cloudflare/workers-types" />

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
    const lang = body.lang || 'ko';
    const API_KEY = context.env.GEMINI_API_KEY;

    if (!API_KEY) {
      return new Response(JSON.stringify({ success: false, message: 'API Key missing' }), { status: 500, headers: corsHeaders });
    }

    if (!p || p.temp == null || p.delta == null) {
      return new Response(JSON.stringify({ success: false, message: 'weatherContext with temp and delta is required' }), { status: 400, headers: corsHeaders });
    }

    const absDelta = Math.abs(p.delta || 0);
    const direction = p.delta > 0 ? '↑' : p.delta < 0 ? '↓' : '→';

    const prompt = lang === 'ko'
      ? `날씨 데이터를 실용적인 안내로 변환해줘. 반드시 JSON만 반환해.

데이터:
- 오늘 최고기온: ${p.tMax}°C, 최저: ${p.tMin}°C
- 어제 최고기온: ${p.yMax}°C, 최저: ${p.yMin}°C
- 어제 대비 변화: ${direction}${absDelta}°C
- 체감온도: ${p.feels_like || p.feels || p.tMax}°C
- 풍속: ${p.windSpeed || p.wind || 0}m/s
- 날씨코드: ${p.tCode}
${absDelta >= 3 ? `- 중요: ${absDelta}도 이상 차이남` : ''}

규칙:
1. hero는 최대 12단어, 행동 가이던스 우선
2. delta 3도 이상이면 반드시 언급
3. 금지어: 완벽한, AI, 엄마같은 말투

JSON 형식:
{"hero":"...","context":"...","action":"🧥 ...","proof":"${p.tMax}°C ${direction}${absDelta}°"}`
      : `Convert weather data to practical guidance. Return JSON only.

Data:
- Today high: ${p.tMax}°C, low: ${p.tMin}°C
- Yesterday high: ${p.yMax}°C, low: ${p.yMin}°C
- Change: ${direction}${absDelta}°C
- Feels like: ${p.feels_like || p.feels || p.tMax}°C
- Wind: ${p.windSpeed || p.wind || 0}m/s
${absDelta >= 3 ? `- IMPORTANT: ${absDelta}° difference` : ''}

Rules: hero max 12 words, guidance first, mention delta if 3°+

JSON format:
{"hero":"...","context":"...","action":"🧥 ...","proof":"${p.tMax}°C ${direction}${absDelta}°"}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 300 }
        })
      }
    );

    const data = await response.json() as any;

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${JSON.stringify(data?.error)}`);
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`No JSON found. Raw: ${rawText.slice(0, 200)}`);
    }

    const translation = JSON.parse(jsonMatch[0]);

    return new Response(
      JSON.stringify({ success: true, translation, timestamp: new Date().toISOString() }),
      { headers: corsHeaders }
    );

  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, error: 'Translation failed', message: error.message }),
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
