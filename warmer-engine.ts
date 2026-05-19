// ============================================================================
// Warmer Translation Engine - Gemini Version (FREE)
// ============================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { 
  WeatherContext, 
  WarmTranslation, 
  LayeredTranslation,
  DataProof 
} from "./warmer-types";
import { 
  WARMER_SYSTEM_PROMPT, 
  buildContextualHints 
} from "./warmer-prompt";

// Gemini API 초기화
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash",  // 무료 모델
  generationConfig: {
    temperature: 0.7,
    maxOutputTokens: 500,
  }
});

class BrandViolationError extends Error {
  constructor(public violation: string, public text: string) {
    super(`Brand violation: ${violation} in "${text}"`);
    this.name = "BrandViolationError";
  }
}

export async function translateWeather(
  ctx: WeatherContext,
  options: { maxRetries?: number } = {}
): Promise<WarmTranslation> {
  const maxRetries = options.maxRetries ?? 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const contextualHints = buildContextualHints(ctx);
      const fullPrompt = WARMER_SYSTEM_PROMPT + contextualHints;

      // Gemini 프롬프트 구성
      const prompt = `${fullPrompt}

Here is the weather data to translate:

${JSON.stringify(ctx, null, 2)}

Respond with ONLY valid JSON, no markdown fences, no explanation. Follow this exact structure:
{
  "hero": "...",
  "context": "..." or null,
  "action": "..." or null,
  "proof": {
    "delta": { "temp": number, "direction": "↑|↓|→", "display": "..." },
    "absolute": { "value": number, "unit": "...", "display": "..." },
    ...
  }
}`;

      const result = await model.generateContent(prompt);
      const response = result.response;
      const rawText = response.text();

      // JSON 파싱 (마크다운 펜스 제거)
      const cleanText = rawText
        .replace(/```json\n?/g, "")
        .replace(/\n?```/g, "")
        .trim();
      
      const parsed = JSON.parse(cleanText) as WarmTranslation;

      // 브랜드 가드레일 적용
      const validated = applyBrandGuardrails(parsed);

      return validated;

    } catch (error) {
      lastError = error as Error;
      
      if (error instanceof BrandViolationError && attempt < maxRetries) {
        console.warn(`Attempt ${attempt + 1} failed: ${error.message}. Retrying...`);
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
    "hyperlocal",
    "precipitation",
    "atmospheric",
    "optimize",
    "optimization",
    "severe conditions",
    "outfit",
    "ai-powered",
    "you've got this",
  ];

  const BANNED_PATTERNS = [
    /\d+°[CF]\s+today/i,
    /temperature\s+is/i,
    /forecast\s+shows/i,
    /expect\s+\d+°/i,
  ];

  const heroLower = output.hero.toLowerCase();
  
  for (const word of BANNED_WORDS) {
    if (heroLower.includes(word.toLowerCase())) {
      throw new BrandViolationError("banned_word", output.hero);
    }
  }

  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(output.hero)) {
      throw new BrandViolationError("banned_pattern", output.hero);
    }
  }

  const heroWords = output.hero
cd ~/warmer-firebase/functions/src

cat > index.ts << 'EOF'
import * as functions from "firebase-functions";
import { translateWeather, translateLayered } from "./warmer-engine";
import type { WeatherContext } from "./warmer-types";

/**
 * HTTP Function: 날씨 번역 API (Gemini)
 */
export const translateWeatherAPI = functions
  .runWith({
    secrets: ["GEMINI_API_KEY"],
    timeoutSeconds: 60,
    memory: "512MB",
  })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const weatherContext = req.body.weatherContext as WeatherContext;

      if (!weatherContext || !weatherContext.temp || !weatherContext.delta) {
        res.status(400).json({
          error: "Invalid request",
          message: "weatherContext with temp and delta is required",
        });
        return;
      }

      const translation = await translateWeather(weatherContext);

      res.status(200).json({
        success: true,
        translation,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Translation error:", error);
      res.status(500).json({
        success: false,
        error: "Translation failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

/**
 * HTTP Function: 레이어드 번역 (사용자 타입별)
 */
export const translateWeatherLayered = functions
  .runWith({
    secrets: ["GEMINI_API_KEY"],
    timeoutSeconds: 60,
    memory: "512MB",
  })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const weatherContext = req.body.weatherContext as WeatherContext;

      if (!weatherContext || !weatherContext.temp || !weatherContext.delta) {
        res.status(400).json({
          error: "Invalid request",
          message: "weatherContext with temp and delta is required",
        });
        return;
      }

      const layered = await translateLayered(weatherContext);

      res.status(200).json({
        success: true,
        layered,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Layered translation error:", error);
      res.status(500).json({
        success: false,
        error: "Translation failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
