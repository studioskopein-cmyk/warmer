/// <reference types="@cloudflare/workers-types" />
import { generate } from './warmer-engine-v3';
import { GEMINI_PILOT_SCOPE, GEMINI_PILOT_RELEVANT_FIELD } from '../../advice-rules.js';
import { sanitizeFacts, buildAdvicePrompt, validateAdvice } from '../../advice-ai.js';

interface Env {
  GEMINI_API_KEY: string;
}

// Fact template per pilot key — mirrors GEMINI_PILOT_RELEVANT_FIELD's choice
// of which meta number each sentence states (diurnalRange always states the
// overnight low, never the drop size — see advice-rules.js's comment on
// GEMINI_PILOT_RELEVANT_FIELD for why). Lives here, not client-side: the
// server must never forward a client-supplied prompt string verbatim to
// Gemini (that would make this endpoint an open relay against our own API
// key), so it builds the prompt itself from a validated key + number only.
const GEMINI_PILOT_FACT: Record<string, (meta: any) => string> = {
  apparentTempGap: meta => `Feels-like temperature is ${Math.round(meta.feelsLike)}°C, noticeably different from the actual reading.`,
  diurnalRange: meta => `Overnight low will be about ${Math.round(meta.eveningTemp)}°C, well below today's daytime high.`,
};

function buildGeminiPilotPrompt(key: string, meta: any): string {
  const fact = GEMINI_PILOT_FACT[key](meta);
  return `You reword ONE sentence for a weather app called Warmer. You are not
choosing what to talk about — that's already decided. You are only wording
the fact given to you.

Fact to convey: ${fact}

Rules:
1. State this exact fact. Do not add, drop, or round the number differently
   than given.
2. Do not mention any other reading — no rain, no wind, no UV, no actual
   daytime temperature. Only the fact above.
3. Put the key fact — the number or the recommended action — somewhere in
   the first half of the sentence. Don't save it all for the very end. It's
   fine to start with the number if that's the clearest way to say it.
4. Warm, plain, spoken language. Warm, never cheesy. Smart, never clinical.
5. One sentence. No emoji, no greeting, no sign-off, no quotation marks.

Reply with the sentence only.`;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const body = await context.request.json() as any;

    // Gemini phrasing pilot (see advice-rules.js's GEMINI_PILOT_SCOPE): a
    // narrow, separate mode that rewords ONE already-selected, already-
    // templated sentence. Deliberately bypasses generate()/warmer-engine-v3
    // entirely — that pipeline picks its own dominant signal and (via
    // llmPolish) only calls Gemini for lang!=='en', so it can't stand in for
    // "phrase this exact fact" on an English-only pilot. Same model/endpoint
    // as llmPolish below, just a different prompt and a real call every time.
    //
    // The client sends only {key, tier, meta} — never a rendered prompt.
    // (key, tier) is checked against GEMINI_PILOT_SCOPE here, server-side,
    // and the actual Gemini prompt is built from a fixed template + the one
    // validated number GEMINI_PILOT_RELEVANT_FIELD names for that key. A
    // client-side scope check alone (index.html's isInGeminiPilotScope) is
    // not real enforcement — anyone can POST to this endpoint directly — so
    // trusting a client-supplied free-text prompt here would make this an
    // open relay against our own metered GEMINI_API_KEY.
    // AI action line (advice-ai.js). The client sends facts the rule engine
    // chose; sanitizeFacts() lets through only enum kinds and short lowercase
    // words, and the prompt is built here. The answer is checked with
    // validateAdvice(); one retry, then the client keeps its rule-based line.
    if (body.mode === 'advice') {
      const API_KEY = context.env.GEMINI_API_KEY;
      if (!API_KEY) {
        return new Response(JSON.stringify({ success: false, message: 'API Key missing' }), { status: 500, headers: corsHeaders });
      }
      const facts = sanitizeFacts(body.facts);
      if (!facts) {
        return new Response(JSON.stringify({ success: false, message: 'facts rejected' }), { status: 400, headers: corsHeaders });
      }
      const prompt = buildAdvicePrompt(facts);
      // Same facts -> same answer for everyone. Cache API is best-effort: it can
      // be unavailable (e.g. some hostnames), in which case we just call Gemini.
      const sha = async (t: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
      let cache: any = null, cacheKey: Request | null = null;
      try {
        cache = (globalThis as any).caches?.default || null;
        // Hash the prompt, not just the facts: editing the rules invalidates old answers.
        cacheKey = new Request(`https://advice.cache.warmer/${await sha(prompt)}`);
        const hit = cache ? await cache.match(cacheKey) : null;
        if (hit) return new Response(await hit.text(), { headers: { ...corsHeaders, 'X-Advice-Cache': 'hit' } });
      } catch { cache = null; }
      // Each model has its own quota. If the main one is out (429), the lighter
      // one answers instead of the user losing the AI line.
      const MODELS = ['gemini-3.1-flash-lite', 'gemini-2.5-flash'];
      let modelUsed = MODELS[0];
      const ask = async () => {
        const call = async (model: string) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.6, maxOutputTokens: 300, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
          }),
        });
        if (!r.ok) { const err: any = new Error(`Gemini ${r.status}`); err.status = r.status; throw err; }
        const data: any = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        let o: any = {};
        try { o = JSON.parse(text); } catch { o = {}; }
        return validateAdvice(o, facts);
        };
        // Try each model in order. Out of quota (429) or busy (5xx) moves on to the next;
        // anything else (bad request, 404) stops. If all fail, report the first error
        // so the client sees a 429 as a 429 and backs off.
        let first: any = null;
        for (let i = 0; i < MODELS.length; i++) {
          try { modelUsed = MODELS[i]; return await call(MODELS[i]); }
          catch (e: any) {
            first = first || e;
            // 503 means busy, not out of quota: retry the main model a couple of times first.
            for (let n = 0; e?.status === 503 && i === 0 && n < 2; n++) {
              await new Promise(r => setTimeout(r, 700 * (n + 1)));
              try { return await call(MODELS[0]); } catch (e2: any) { e = e2; }
            }
            if (e?.status !== 429 && !(e?.status >= 500) && e?.status !== 404) throw e;
          }
        }
        throw first;
      };
      try {
        let v = await ask();
        if (!v.ok) v = await ask();
        if (!v.ok) {
          return new Response(JSON.stringify({ success: false, message: 'rejected', reasons: v.reasons, draft: { action: v.action, card: v.card } }), { status: 422, headers: corsHeaders });
        }
        const body = JSON.stringify({ success: true, action: v.action, card: v.card });
        try { if (cache && cacheKey) await cache.put(cacheKey, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10800' } })); } catch { /* best-effort */ }
        return new Response(body, { headers: { ...corsHeaders, 'X-Advice-Model': modelUsed } });
      } catch (e: any) {
        // 429 is passed through so the client can back off instead of retrying at once.
        return new Response(JSON.stringify({ success: false, message: e?.message || 'advice failed' }), { status: e?.status === 429 ? 429 : 502, headers: corsHeaders });
      }
    }

    if (body.mode === 'pilot-reword') {
      const API_KEY = context.env.GEMINI_API_KEY;
      const { key, tier, meta } = body;
      if (!API_KEY) {
        return new Response(
          JSON.stringify({ success: false, message: 'API Key missing' }),
          { status: 500, headers: corsHeaders }
        );
      }
      const inScope = GEMINI_PILOT_SCOPE.some((s: any) => s.key === key && s.tier === tier);
      if (!inScope) {
        return new Response(
          JSON.stringify({ success: false, message: 'key/tier not in Gemini pilot scope' }),
          { status: 403, headers: corsHeaders }
        );
      }
      const field = (GEMINI_PILOT_RELEVANT_FIELD as Record<string, string>)[key];
      const value = field != null ? meta?.[field] : null;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return new Response(
          JSON.stringify({ success: false, message: `meta.${field} must be a finite number` }),
          { status: 400, headers: corsHeaders }
        );
      }
      const prompt = buildGeminiPilotPrompt(key, meta);
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            // thinkingBudget:0 disables gemini-2.5-flash's default reasoning
            // pass — verified live that without this, thoughtsTokenCount ate
            // ~189 of a 200 maxOutputTokens budget, truncating the actual
            // one-sentence answer to a few words (finishReason:MAX_TOKENS)
            // every time. A single reworded sentence needs no reasoning.
            generationConfig: { temperature: 0.7, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
          }),
        });
        if (!r.ok) throw new Error(`Gemini ${r.status}`);
        const data: any = await r.json();
        let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        text = text.trim().replace(/^["'`]|["'`]$/g, '');
        if (!text) throw new Error('empty completion');
        return new Response(
          JSON.stringify({ success: true, text }),
          { headers: corsHeaders }
        );
      } catch (e: any) {
        return new Response(
          JSON.stringify({ success: false, message: e?.message || 'pilot-reword failed' }),
          { status: 502, headers: corsHeaders }
        );
      }
    }

    const p = body.weatherContext;
    const lang = body.lang || 'en';   // ★ 기본을 'en'으로 변경
    const API_KEY = context.env.GEMINI_API_KEY;

    if (!API_KEY && lang !== 'en') {
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
    // No fallback: a missing UV reading stays null and is excluded from
    // scoring in severity() below, rather than being silently treated as
    // UV=1 (the old p.highU ? 6 : 1 fallback — highU is never set in the
    // live index.html data flow, so that ternary's `6` branch was dead code
    // and the `?? 1` half was masking "no data" as "definitely low UV",
    // which suppressed the UV chip whenever the reading was actually missing).
    const uvIndex        = p.uvIndex ?? null;
    const precipProb     = p.precipProb ?? (p.slots?.length
                              ? Math.max(...p.slots.map((s: any) => s.rain ?? 0))
                              : 0);
    // index.html's parse() computes this once per fetch (getTimeBand) and
    // spreads it straight into weatherContext — just forwarded here, not
    // re-derived, so the client's clock stays the single source of truth.
    const band            = p.band ?? null;

    let eveningDelta = p.eveningDelta ?? 0;
    if (!p.eveningDelta && p.slots?.length) {
      const eveningSlot = p.slots[Math.min(p.slots.length - 1, 15)];
      if (eveningSlot) {
        eveningDelta = Math.max(0, (p.tMax ?? p.temp) - eveningSlot.temp);
      }
    }

    // 2) 엔진 호출 (v4 architecture)
    const engineResult = await generate(
      { feelsLike, yesterdayDelta, windSpeed, uvIndex, precipProb, eveningDelta, band },
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