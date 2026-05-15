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
export async function generateAITitle(text: string): Promise<string> {
  const apiKey = (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || '';
  if (!apiKey) {
    console.warn('[AITitle] GEMINI_API_KEY missing, returning fallback');
    return `paste text [${text.length}]`;
  }
  try {
    const body = {
      contents: [{ role: 'user', parts: [{ text }] }],
      systemInstruction: {
        parts: [{
          text: 'Дай короткое название (2-5 слов) для этого пасты. Только название, без точки, без кавычек, без префикса.'
        }],
      },
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await res.json();
    if (data?.error) throw new Error(data.error.message || 'Gemini error');
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const title = String(raw || '').replace(/\n/g, ' ').trim();
    if (!title) return `paste text [${text.length}]`;
    // Always suffix length so the user knows the body size at a glance.
    return `${title} [${text.length}]`;
  } catch (err: any) {
    console.error('[AITitle] failed:', err?.message || err);
    return `paste text [${text.length}]`;
  }
}
