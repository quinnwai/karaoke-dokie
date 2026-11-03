// Calls the Gemini API's generateContent with plain fetch (no SDK, so no new dependency). Used
// offline by the mood labeller; nothing calls the model at request time. Retries are
// fetchWithRetries' (ask.ts). The key goes in a header, never in the URL, so it stays out of
// logs. No sampling settings are sent; thinking stays at the model's default.

import { fetchWithRetries, type Ask, type AskResult, type HttpDeps } from './ask';

export const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';

export const generateUrl = (model: string) => `${GEMINI_API}/${encodeURIComponent(model)}:generateContent`;

export function createGemini({ apiKey, ...deps }: { apiKey: string } & HttpDeps): Ask {
  return async (req) => {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        // Thinking counts against this budget too.
        maxOutputTokens: req.maxTokens,
        ...(req.schema ? { responseMimeType: 'application/json', responseJsonSchema: req.schema } : {}),
      },
    });
    const res = await fetchWithRetries(
      'Gemini',
      generateUrl(req.model),
      { method: 'POST', headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, body },
      deps,
    );
    return toResult(await res.json());
  };
}

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** Gemini's finish reasons in the labeller's terms (see AskResult.stopReason); blocks and filters count as refusals. */
const STOP: Record<string, string> = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  BLOCKLIST: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  SPII: 'refusal',
};

function toResult(json: GenerateResponse): AskResult {
  const candidate = json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const reason = candidate?.finishReason ?? (json.promptFeedback?.blockReason ? 'SAFETY' : null);
  const usage = json.usageMetadata;
  return {
    text: parts
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join(''),
    inputTokens: usage?.promptTokenCount ?? 0,
    // Thinking is billed as output.
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    stopReason: reason === null ? null : (STOP[reason] ?? reason),
  };
}
