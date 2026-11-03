'use strict';

// Вызов OpenAI Chat Completions из main-процесса — парный модуль к `gemini-api.js`.
//
// Контракт ответа совпадает с `callGeminiApi`: вызывающий получает
// `{ success, text, usage: { input_tokens, output_tokens } }` и не знает, какой
// провайдер отвечал. Поэтому утилитарный пайплайн (сообщение коммита в
// `ipc/git.js`) переключается между провайдерами одной константой, без правок
// самого пайплайна и без ветвлений по провайдеру в его коде.
//
// Ключ берётся из окружения (`OPENAI_API_KEY`): dev — `.env` проекта,
// packaged — `~/.noted-terminal/.env`. Порядок загрузки — `main.js::loadEnvFile`,
// перечень ключей — `docs/setup/keys.md`.

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// Reasoning-семейство OpenAI считает рассуждение частью `completion_tokens`,
// а не отдельным бюджетом. Поэтому пустой текст при `finish_reason: 'length'`
// означает, что весь бюджет ушёл в рассуждение и до ответа дело не дошло: это
// ошибка, а не успешный пустой ответ. Утилитарным вызовам этого лимита хватает
// с большим запасом (сообщение коммита — сотни токенов).
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

// Уровень размышления хранится в Settings → AI в терминах Gemini
// (NONE/LOW/MEDIUM/HIGH), общий для всех utility-промптов. Перевод в
// `reasoning_effort` зависит от модели (часть моделей принимает `none`, часть
// только `minimal`) и живёт в общем с renderer каталоге, чтобы main и renderer
// не разъехались. Неизвестный уровень не выдумывается: параметр не отправляется.
const { openAIEffortForModel } = require('../../shared/utility-ai-provider.cjs');

/**
 * @param {string} system   Системная инструкция (может быть пустой строкой).
 * @param {string} prompt   Пользовательский текст запроса.
 * @param {string} model    Идентификатор модели OpenAI.
 * @param {string} thinking Уровень размышления: NONE | LOW | MEDIUM | HIGH | XHIGH.
 */
async function callOpenAIApi(system, prompt, model = 'gpt-5-nano', thinking = 'NONE', options = {}) {
  try {
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) return { success: false, error: 'OPENAI_API_KEY is not configured' };

    const systemText = String(system || '').trim();
    const messages = options.messages || [
      ...(systemText ? [{ role: 'system', content: systemText }] : []),
      { role: 'user', content: String(prompt || '') },
    ];

    const requestBody = {
      model,
      messages,
      max_completion_tokens: Number(options.maxOutputTokens) || DEFAULT_MAX_OUTPUT_TOKENS,
    };
    const effort = openAIEffortForModel(thinking, model);
    if (effort) requestBody.reasoning_effort = effort;

    const encoded = JSON.stringify(requestBody);
    console.log('[openai-api] Sending ' + Math.round(Buffer.byteLength(encoded) / 1024)
      + 'KB, model=' + model + ' effort=' + (effort || 'provider-default'));

    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: encoded,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const data = await response.json();
    if (data.error) {
      return { success: false, error: data.error.message || 'OpenAI API Error' };
    }

    const choice = (data.choices || [])[0];
    const text = String(choice?.message?.content || '');
    const rawUsage = data.usage || {};
    const usage = {
      input_tokens: rawUsage.prompt_tokens,
      output_tokens: rawUsage.completion_tokens,
    };

    if (!text.trim()) {
      const finish = choice?.finish_reason;
      const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens;
      return {
        success: false,
        error: finish === 'length'
          ? 'Output budget spent before any text (reasoning tokens: '
            + (reasoningTokens === undefined ? 'unknown' : reasoningTokens) + ')'
          : 'Empty or blocked response' + (finish ? ' (finish_reason: ' + finish + ')' : ''),
        usage,
      };
    }

    console.log('[openai-api] Response: ' + Math.round(text.length / 1024) + 'KB, input: '
      + usage.input_tokens + ' output: ' + usage.output_tokens);
    return { success: true, text, usage };
  } catch (error) {
    console.error('[openai-api] Error:', error);
    return { success: false, error: error.message };
  }
}

module.exports = { callOpenAIApi, DEFAULT_MAX_OUTPUT_TOKENS };
