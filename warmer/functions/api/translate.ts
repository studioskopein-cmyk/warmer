// ── Inlined types (from src/types.ts) ────────────────────────────────────────

interface WeatherContext {
  temp: number;
  delta: number;
  tMax: number;
  tMin: number;
  yMax: number;
  yMin: number;
  tCode: number;
  wind: number;
  slots: Array<{ temp: number; code: number; rain: number }>;
  highU?: boolean;
  pivot?: string;
  feels?: number;
  windSpeed?: number;
  hourlySlots?: Array<{ temp: number; code: number; rain: number }>;
  volatility?: boolean;
  keyPoint?: string;
  feels_like?: number;
}

interface DataProof {
  delta?: { display: string };
  time_window?: { display: string };
  feels_like?: { differs_from_actual: boolean; display: string };
}

interface WarmTranslation {
  hero: string;
  context: string | null;
  action: string | null;
  proof: DataProof;
}

// ── Inlined prompt logic (from src/prompt.ts) ─────────────────────────────────

const WARMER_SYSTEM_PROMPT = `당신은 Warmer의 날씨 번역가입니다. 날씨 데이터를 간결하고 실용적인 안내로 변환합니다.

핵심 규칙:
1. 행동 가이던스가 먼저: 사용자가 무엇을 해야 하는지(예: 겉옷 챙기기, 우산 준비) 가장 먼저 제안하세요.
2. Delta 우선: 어제보다 3도 이상 차이 나면 반드시 언급하세요. "어제보다 훨씬 따뜻해요"보다는 "가벼운 겉옷이면 충분해요. 어제보다 5도나 높거든요"가 좋습니다.
3. 숫자는 괄호 안 근거로: "15도예요" 대신 "포근해요 (15°C)"와 같이 숫자는 보조 정보로만 사용하세요.
4. Hero 최대 12단어: 가장 중요한 요약(hero)은 12단어 이내로 간결하게 작성하세요.

금지 사항:
- "완벽한 날씨", "최고의 하루" 같은 과장된 표현
- AI임을 암시하는 표현
- "엄마 같은" 말투 (지나치게 다정한 말투보다는 담백하고 실용적인 전문 도우미 톤을 유지하세요)

Respond with ONLY valid JSON. Structure:
{
  "hero": "Short catchy summary (max 12 words)",
  "context": "Main briefing text focusing on guidance and delta",
  "action": "Emoji + Practical advice (e.g. '🧥 가벼운 자켓')",
  "proof": { "delta": { "display": "..." }, "absolute": { "display": "..." } }
}`;

function buildContextualHints(ctx: WeatherContext): string {
  return `
- Today: ${ctx.tMax}°C / ${ctx.tMin}°C
- Yesterday: ${ctx.yMax}°C / ${ctx.yMin}°C
- Diff: ${ctx.delta}°C
- Feels like: ${ctx.feels ?? ctx.feels_like ?? 'N/A'}°C
- Wind: ${ctx.wind ?? ctx.windSpeed ?? 'N/A'}m/s
- High Volatility: ${(ctx.highU ?? ctx.volatility) ? 'Yes' : 'No'}
- Key Point: ${ctx.pivot ?? ctx.keyPoint ?? 'None'}
`;
}

// ── Brand guardrails ───────────────────────────────────────────────────────────

class BrandViolationError extends Error {
  constructor(public violation: string, public text: string) {
    super(`Brand violation: ${violation} in "${text}"`);
    this.name = "BrandViolationError";
  }
}

function applyBrandGuardrails(output: WarmTranslation): WarmTranslation {
  const BANNED_WORDS = [
    "hyperlocal", "precipitation", "atmospheric", "optimize",
    "optimization", "severe conditions", "outfit", "ai-powered", "you've got this",
  ];

  const heroLower = output.hero.toLowerCase();
  for (const word of BANNED_WORDS) {
    if (heroLower.includes(word.toLowerCase())) {
      throw new BrandViolationError("banned_word", output.hero);
    }
  }

  if (output.hero.split(/\s+/).length > 12) {
    throw new BrandViolationError("hero_too_long", output.hero);
  }

  if (!output.proof || Object.keys(output.proof).length === 0) {
    throw new BrandViolationError("missing_proof", "No data proof provided");
  }

  return output;
}

// ── Gemini REST call ───────────────────────────────────────────────────────────

async function translateWeather(
  ctx: WeatherContext,
  apiKey: string,
  options: { maxRetries?: number } = {}
): Promise<WarmTranslation> {
  const maxRetries = options.maxRetries ?? 1;
  let lastError: Error | null = null;

  const contextualHints = buildContextualHints(ctx);
  const fullPrompt = `${WARMER_SYSTEM_PROMPT}${contextualHints}

Here is the weather data to translate:

${JSON.stringify(ctx, null, 2)}

Respond with ONLY valid JSON, no markdown fences, no explanation. Structure:
{
  "hero": "...",
  "context": "..." or null,
  "action": "..." or null,
  "proof": { "delta": { "display": "..." }, "absolute": { "display": "..." } }
}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 300 },
        }),
      });

      if (!res.ok) {
        throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
      }

      const data = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No valid JSON in response");

      const parsed = JSON.parse(jsonMatch[0]) as WarmTranslation;
      return applyBrandGuardrails(parsed);

    } catch (error) {
      lastError = error as Error;
      if (error instanceof BrandViolationError && attempt < maxRetries) {
        continue;
      }
      if (attempt === maxRetries) {
        throw new Error(
          `Translation failed after ${maxRetries + 1} attempts. Last error: ${lastError?.message}`
        );
      }
    }
  }

  throw lastError!;
}

// ── Pages Function handlers ────────────────────────────────────────────────────

interface Env {
  GEMINI_API_KEY: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  try {
    const body = await ctx.request.json() as { weatherContext?: WeatherContext };
    const weatherContext = body.weatherContext;

    if (!weatherContext || weatherContext.temp == null || weatherContext.delta == null) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid request",
          message: "weatherContext with temp and delta is required",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const translation = await translateWeather(weatherContext, ctx.env.GEMINI_API_KEY);
    return new Response(
      JSON.stringify({ success: true, translation, timestamp: new Date().toISOString() }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Translation error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Translation failed",
        message: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, { headers: corsHeaders });
};
