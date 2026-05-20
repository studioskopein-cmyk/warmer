interface Env {
  GEMINI_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { weatherContext, lang } = await context.request.json() as any;
    const API_KEY = context.env.GEMINI_API_KEY;

    if (!API_KEY) {
      return new Response(
        JSON.stringify({ success: false, message: "API Key missing" }), 
        { status: 500 }
      );
    }

    const delta = weatherContext.delta || 0;
    const absDelta = Math.abs(delta);
    const direction = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
    const directionWord = lang === 'ko' 
      ? (delta > 0 ? "따뜻" : delta < 0 ? "쌀쌀" : "비슷")
      : (delta > 0 ? "warmer" : delta < 0 ? "cooler" : "similar");

    const systemInstruction = lang === 'ko' 
      ? "당신은 Warmer의 날씨 번역가입니다. 날씨 데이터를 간결하고 실용적인 안내로 변환합니다.\n\n핵심 규칙:\n1. 행동 가이던스가 먼저\n2. Delta 우선 - 3도 이상 차이나면 반드시 언급\n3. 숫자는 괄호 안 근거로\n4. Hero 최대 12단어\n\n금지: 완벽한, 최고의, AI, 엄마 같은 말투"
      : "You are Warmer's weather translator. Convert raw weather data into brief, caring, practical guidance.\n\nCRITICAL RULES:\n1. GUIDANCE ALWAYS LEADS\n2. DELTA OVER ABSOLUTE\n3. NUMBERS AS PROOF\n4. Hero max 12 words\n\nBANNED: perfect, amazing, AI-powered, mom-like tone";

    const userPrompt = lang === 'ko'
      ? `날씨: 오늘 ${weatherContext.tMax}°C, 어제 대비 ${direction}${absDelta}°, 상태 ${weatherContext.tCode}. ${absDelta >= 3 ? `중요: ${absDelta}도 차이` : ''} JSON만 반환.`
      : `Weather: Today ${weatherContext.tMax}°C, vs yesterday ${direction}${absDelta}°, condition ${weatherContext.tCode}. ${absDelta >= 3 ? `CRITICAL: ${absDelta}° difference` : ''} Return JSON only.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: userPrompt }] }],
          system_instruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.5,
            maxOutputTokens: 300,
          }
        })
      }
    );

    const data = await response.json() as any;
    const aiResponse = JSON.parse(data.candidates[0].content.parts[0].text);

    return new Response(
      JSON.stringify({
        success: true,
        translation: {
          hero: aiResponse.hero,
          context: aiResponse.context,
          action: aiResponse.action,
          proof: aiResponse.proof || `${weatherContext.tMax}°C ${direction}${absDelta}°`
        }
      }),
      {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );

  } catch (error: any) {
    return new Response(
      JSON.stringify({ 
        success: false, 
        message: error.message 
      }), 
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};