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

      // JSON 파싱 (마크다운 펜스 및 주변 텍스트 제거를 위해 중괄호 추출)
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("응답에서 유효한 JSON을 찾을 수 없습니다.");
      const cleanText = jsonMatch[0];
      
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

  const wordCount = output.hero.split(/\s+/).length;
  if (wordCount > 12) {
    throw new BrandViolationError("too_long", output.hero);
  }

  return output;
}

/**
 * 레이어드 번역 구현
 * index.ts에서 호출하고 있으므로 반드시 export 되어야 합니다.
 */
export async function translateLayered(
  ctx: WeatherContext
): Promise<LayeredTranslation> {
  // 기본 번역을 수행한 뒤 각 레이어에 맞는 응답을 생성합니다.
  const base = await translateWeather(ctx);
  
  return {
    standard: base,
    minimalist: {
      ...base,
      hero: base.hero.split('.')[0] + '.', // 간결한 버전
    },
    enthusiast: {
      ...base,
      hero: `Hey! ${base.hero} Let's get moving!`, // 열정적인 버전
    }
  };
}
