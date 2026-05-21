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

    // 1. Prepare input for Warmer Engine V3
    const feelsLike = p.feels_like ?? p.feels ?? p.tMax ?? p.temp;
    const yesterdayDelta = p.delta;
    const windSpeed = p.windSpeed ?? p.wind ?? 0;
    const uvIndex = p.uvIndex ?? (p.highU ? 6 : 1);
    const precipProb = p.precipProb ?? (p.slots?.length ? Math.max(...p.slots.map((s: any) => s.rain ?? 0)) : 0);
    
    let eveningDelta = p.eveningDelta ?? 0;
    if (!p.eveningDelta && p.slots?.length) {
        // Assume slots are hourly, index 15 is around evening (e.g. 6-9 PM)
        const eveningSlot = p.slots[Math.min(p.slots.length - 1, 15)];
        if (eveningSlot) {
            eveningDelta = Math.max(0, (p.tMax ?? p.temp) - eveningSlot.temp);
        }
    }

    // 2. Run Engine V3
    const engineResult = await generate({
        feelsLike,
        yesterdayDelta,
        windSpeed,
        uvIndex,
        precipProb,
        eveningDelta
    }, API_KEY, lang);

    const { action, reason } = engineResult.narrative;
    const categories = engineResult.debug.itemCategories;
    
    // Pick emoji based on engine's derived categories
    let emoji = '🧥';
    if (categories.some((c: any) => c.cat === 'umbrella')) emoji = '☔';
    else if (categories.some((c: any) => c.cat === 'sunglasses')) emoji = '🕶️';
    else if (categories.some((c: any) => c.cat === 'windbreaker')) emoji = '🌬️';
    else if (categories.some((c: any) => c.cat === 'extreme_cold')) emoji = '🧤';
    else if (categories.some((c: any) => c.cat === 'light_top')) emoji = '👕';

    // 3. Handle Language & Final Response
    // For Korean and English, we can use the engine directly (high performance, no cost)
    if (lang === 'ko' || lang === 'en') {
      const translation = {
        hero: action.split('.')[0].trim().slice(0, 50),
        context: reason,
        action: `${emoji} ${action}`,
        proof: `${p.tMax ?? p.temp}°C ${direction}${absDelta}°`
      };

      return new Response(
        JSON.stringify({ success: true, translation, timestamp: new Date().toISOString() }),
        { headers: corsHeaders }
      );
    }

    // For other languages, use Gemini to translate the engine's high-quality rule-based output
    const prompt = `[Persona & Identity (Archetype)]
- You are translating weather guidance for 'Warmer'. The tone must be Caring, Calm, Practical, and Observant.
- **ABSOLUTELY PROHIBITED:** Avoid overly emotional, childish, or forced cute expressions.
- Keep the tone "Warm, never cheesy; Smart, never clinical".

[Narrative Rules]
1. Lead with the action or takeaway. Say the useful thing first.
2. Translate into ${lang}. Follow the same principles of clarity and care.

Input Guidance:
Action: ${action}
Reason: ${reason}

Return ONLY JSON:
{
  "hero": "Short catchy summary (max 12 words)",
  "context": "Main briefing text (the 'reason' from input, translated with care)",
  "action": "${emoji} Translated practical advice",
  "proof": "${p.tMax ?? p.temp}°C ${direction}${absDelta}°"
}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 500 }
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
      throw new Error(`No JSON found in translation. Raw: ${rawText.slice(0, 200)}`);
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
