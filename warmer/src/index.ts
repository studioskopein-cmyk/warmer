import { GoogleGenerativeAI } from "@google/generative-ai";
import type { WeatherContext, WarmTranslation, LayeredTranslation, DataProof } from "./types";
import { WARMER_SYSTEM_PROMPT, buildContextualHints } from "./prompt";

interface Env {
  GEMINI_API_KEY: string;
  ASSETS: { fetch: typeof fetch };
}

class BrandViolationError extends Error {
  constructor(public violation: string, public text: string) {
    super(`Brand violation: ${violation} in "${text}"`);
    this.name = "BrandViolationError";
  }
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
      temperature: 0.5,  // 0.7에서 0.5로 낮춤 (더 빠름)
      maxOutputTokens: 300,  // 500에서 300으로 줄임 (더 빠름)
    }
  });

  const maxRetries = options.maxRetries ?? 1;  // 2에서 1로 줄임 (더 빠름)
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
  "proof": { "delta": {...}, "absolute": {...} }
}`;

      const result = await model.generateContent(prompt);
      const response = result.response;
      const rawText = response.text();

      const cleanText = rawText
        .replace(/```json\n?/g, "")
        .replace(/\n?```/g, "")
        .trim();
      
      const parsed = JSON.parse(cleanText) as WarmTranslation;
      const validated = applyBrandGuardrails(parsed);

      return validated;

    } catch (error) {
      lastError = error as Error;
      
      if (error instanceof BrandViolationError && attempt < maxRetries) {
        console.warn(`Attempt ${attempt + 1} failed. Retrying...`);
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

function formatKeyNumbers(proof: DataProof): string {
  const parts: string[] = [];

  if (proof.delta) parts.push(proof.delta.display);
  if (proof.time_window) parts.push(proof.time_window.display);
  if (proof.feels_like?.differs_from_actual) parts.push(proof.feels_like.display);

  return parts.slice(0, 2).join(", ");
}

async function translateLayered(ctx: WeatherContext, apiKey: string): Promise<LayeredTranslation> {
  const full = await translateWeather(ctx, apiKey);

  return {
    quick: full.hero,
    outfit: {
      message: [full.hero, full.context].filter(Boolean).join(" "),
      key_numbers: formatKeyNumbers(full.proof),
    },
    detailed: full,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    
    // API Routes
    if (url.pathname === "/api/layered" || url.pathname === "/api/translate") {
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({ error: "Method not allowed" }),
          { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      try {
        const body = await request.json() as any;
        const weatherContext = body.weatherContext as WeatherContext;

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

        if (url.pathname === "/api/layered") {
          const layered = await translateLayered(weatherContext, env.GEMINI_API_KEY);
          return new Response(
            JSON.stringify({
              success: true,
              layered,
              timestamp: new Date().toISOString(),
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        } else {
          const translation = await translateWeather(weatherContext, env.GEMINI_API_KEY);
          return new Response(
            JSON.stringify({
              success: true,
              translation,
              timestamp: new Date().toISOString(),
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
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
    }

    // Fallback for non-API routes (serve assets)
    return env.ASSETS.fetch(request);
  },
};
