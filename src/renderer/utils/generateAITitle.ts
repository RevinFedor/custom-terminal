/**
 * Generates a short title for an AI Paste collapsed block via Gemini Flash.
 *
 * Used as the `onGenerateTitle` callback passed to <MarkdownEditor> — the editor
 * inserts `^^ ⏳` placeholder, calls this function with the pasted text, then
 * replaces `⏳` with the returned title (or 'paste text' fallback on failure).
 *
 * Mirrors the same API pattern already used by InfoPanel.handleGenerateDescription —
 * GEMINI_API_KEY from the renderer's process.env (set during electron-vite bootstrap),
 * gemini-2.0-flash model with a system prompt asking for a 2-5 word title.
 */
// Tried models in order — fall back to next when previous returns 429.
// flash-lite has the most generous free-tier quota; flash-exp lacks RPM cap.
// Keep flash-2.0 last so the heavier model isn't tried first.
const MODEL_FALLBACK_CHAIN = [
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-exp',
  'gemini-1.5-flash-latest',
  'gemini-2.0-flash',
];

async function callGemini(apiKey: string, model: string, text: string): Promise<{ ok: true; title: string } | { ok: false; quota: boolean; msg: string }> {
  const body = {
    contents: [{ role: 'user', parts: [{ text }] }],
    systemInstruction: {
      parts: [{
        text: 'Дай короткое название (2-5 слов) для этой пасты. Только название, без точки, без кавычек, без префикса.'
      }],
    },
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const data = await res.json();
  if (data?.error) {
    const msg = data.error.message || 'Gemini error';
    const quota = /exhausted|quota|429|rate/i.test(msg) || data.error.code === 429;
    return { ok: false, quota, msg };
  }
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const title = String(raw || '').replace(/\n/g, ' ').trim();
  if (!title) return { ok: false, quota: false, msg: 'empty response' };
  return { ok: true, title };
}

export async function generateAITitle(text: string): Promise<string> {
  const apiKey = (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || '';
  if (!apiKey) {
    console.warn('[AITitle] GEMINI_API_KEY missing, returning fallback');
    return `paste text [${text.length}]`;
  }
  // Try each model in the fallback chain. Stop on success or on a non-quota error
  // (no point retrying a 400 etc.); quota → try the next bucket.
  for (const model of MODEL_FALLBACK_CHAIN) {
    try {
      const r = await callGemini(apiKey, model, text);
      if (r.ok) {
        console.warn('[AITitle] success via', model, '→', r.title);
        // No `[N]` suffix on AI titles — the title itself conveys meaning, the
        // char-count chip is reserved for the non-AI "+ paste" pill (fallback).
        return r.title;
      }
      console.warn('[AITitle] model', model, 'failed:', r.msg, r.quota ? '(quota — trying next)' : '(stopping chain)');
      if (!r.quota) break; // non-quota error: stop, don't waste calls
    } catch (err: any) {
      console.error('[AITitle] network error on', model, ':', err?.message || err);
      break;
    }
  }
  return `paste text [${text.length}]`;
}
