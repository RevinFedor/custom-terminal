import { getGeminiApiKey } from './geminiApiKey.mjs';
import { getOpenAIApiKey } from './openaiApiKey.mjs';
import { resolveUtilityAIModel, openAIEffortForModel } from '../../shared/utility-ai-provider.mjs';
/**
 * Короткое название для свёрнутого блока AI Paste.
 *
 * Передаётся в <MarkdownEditor> как `onGenerateTitle`: редактор вставляет
 * `^^ ⏳`, вызывает эту функцию с текстом вставки и заменяет `⏳` результатом
 * (или `paste text [N]` при отказе).
 *
 * Провайдер — общий utility-выбор (`shared/utility-ai-provider.cjs`), тот же,
 * что у названий вкладок. Собственной сохранённой модели у этого вызова нет:
 * в Settings он не представлен, поэтому всегда берётся модель по умолчанию
 * текущего провайдера.
 *
 * Цепочки запасных моделей здесь больше нет. Она существовала ради бесплатных
 * квот Gemini: при 429 вызов перебирал `gemini-2.0-*` в поисках свободной
 * корзины. У платного ключа это лишние запросы — 429 означает реальный лимит
 * аккаунта, и следующая модель упрётся в него же. Остаётся один вызов и
 * локальный fallback.
 */
const SYSTEM_PROMPT = 'Дай короткое название (2-5 слов) для этой пасты. Только название, без точки, без кавычек, без префикса.';

async function callOpenAI(apiKey: string, model: string, text: string): Promise<string> {
  const body: any = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    max_completion_tokens: 2048,
  };
  const effort = openAIEffortForModel('NONE', model);
  if (effort) body.reasoning_effort = effort;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data?.error) throw new Error(data.error.message || 'OpenAI error');
  return String(data?.choices?.[0]?.message?.content || '').replace(/\n/g, ' ').trim();
}

async function callGemini(apiKey: string, model: string, text: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      }),
    }
  );
  const data = await res.json();
  if (data?.error) throw new Error(data.error.message || 'Gemini error');
  return String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '').replace(/\n/g, ' ').trim();
}

export async function generateAITitle(text: string): Promise<string> {
  const fallback = `paste text [${text.length}]`;
  const { provider, model } = resolveUtilityAIModel(undefined, 'NONE');
  const isOpenAI = provider === 'openai';
  const apiKey = isOpenAI ? await getOpenAIApiKey() : await getGeminiApiKey();
  if (!apiKey) {
    console.warn('[AITitle] ' + (isOpenAI ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY') + ' missing, returning fallback');
    return fallback;
  }
  try {
    const title = isOpenAI ? await callOpenAI(apiKey, model, text) : await callGemini(apiKey, model, text);
    if (!title) {
      console.warn('[AITitle] empty response from', provider, model);
      return fallback;
    }
    console.warn('[AITitle] success via', provider, model, '→', title);
    // Без суффикса `[N]`: счётчик символов остаётся у не-AI «+ paste».
    return title;
  } catch (err: any) {
    console.error('[AITitle] request failed on', provider, model, ':', err?.message || err);
    return fallback;
  }
}
