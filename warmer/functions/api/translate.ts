import { GoogleGenerativeAI } from "@google/generative-ai";
import type { WeatherContext, WarmTranslation } from "../../src/types";
import { WARMER_SYSTEM_PROMPT, buildContextualHints } from "../../src/prompt";

interface Env {
  GEMINI_API_KEY: string;
}

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

  const heroWords = output.hero.split(/\s+/).length;
  if (heroWords > 12) {
    throw new BrandViolationError("hero_too_long", output.hero);
  }

  if (!output.proof || Object.keys(output.proof).length === 0) {
    throw new BrandViolationError("missing_proof", "No data proof provided");
  }

  return output;
}

async function translateWeather(
  ctx: WeatherContext,
  apiKey: string,
  options: { maxRetries?: number } = {}
): Promise<WarmTranslation> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 300,
    },
  });

  const maxRetries = options.maxRetries ?? 1;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const contextualHints = buildContextualHints(ctx);
      const fullPrompt = WARMER_SYSTEM_PROMPT + contextualHints;

      const prompt = `${fullPrompt}

Here is the weather data to translate:

${JSON.stringify(ctx, null, 2)}

Respond with ONLY valid JSON, no markdown fences, no explanation. Structure:
{
  "hero": "...",
  "context": "..." or null,
  "action": "..." or null,
  "proof": { "delta": { "display": "..." }, "absolute": { "display": "..." } }
}`;

      const result = await model.generateContent(prompt);
      const rawText = result.response.text();

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
