interface Env {
  GEMINI_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { weatherContext, lang } = await context.request.json() as any;
    const API_KEY = context.env.GEMINI_API_KEY;

    if (!API_KEY) {
      return new Response(JSON.stringify({ success: false, message: "API Key missing" }), { status: 500 });
    }

    const systemInstruction = lang === 'ko' 
      ? "너는 날씨를 엄마처럼 챙겨주는 도우미야. 날씨 상황에 맞춰 다정하게 말해줘. 2~3문장으로 짧게 답해. 온도는 숫자로 말하지 말고 체감 언어로만 말해."
      : "You are a weather assistant who cares for the user like a mother. Speak kindly according to the weather. Keep it short (2-3 sentences). Don't use temperature numbers, use descriptive feeling words instead.";

    const userPrompt = `
    Weather Data:
    - Today's High: ${weatherContext.tMax}°, Low: ${weatherContext.tMin}°
    - Yesterday's High: ${weatherContext.yMax}°
    - Difference: ${weatherContext.delta > 0 ? '+' : ''}${weatherContext.delta}°
    - Current Condition: ${weatherContext.tCode}
    - Points: ${weatherContext.pivot}
    
    Please return a JSON object with the following structure:
    {
      "hero": "Main summary (e.g., 'It's much warmer than yesterday!')",
      "context": "Additional advice based on 'Points' (e.g., 'It will get chilly in the evening, so be careful.')",
      "action": "A single emoji and item name (e.g., '🧥 Jacket' or '☂️ Umbrella') or null"
    }
    Language: ${lang === 'ko' ? 'Korean' : 'English'}
    `;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userPrompt }] }],
        system_instruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          response_mime_type: "application/json",
          temperature: 0.7,
        }
      })
    });

    const data = await response.json() as any;
    const aiResponse = JSON.parse(data.candidates[0].content.parts[0].text);

    return new Response(JSON.stringify({
      success: true,
      translation: {
        hero: aiResponse.hero,
        context: aiResponse.context,
        action: aiResponse.action
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false, 
      message: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};