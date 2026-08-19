// Глобальный вызов Gemini API из main-процесса.
//
// Раньше эта функция лежала в `ipc/docs.js` вместе с пайплайном кнопки Docs
// (Update Docs / Update API → Haiku). Кнопку и весь её пайплайн удалили, а
// вызов Gemini к документации никогда отношения не имел: модель и уровень
// размышления приходят аргументами от вызывающего, настроек документации
// функция не читает. Это тот же общий Gemini, которым живут названия вкладок,
// пересказы Timeline, группировка и сжатие при Rewind — просто единственный
// его вызов со стороны main-процесса (сообщение коммита в `ipc/git.js`).
//
// Ключ берётся из окружения (`GEMINI_API_KEY`), как и во всех остальных местах.

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

/**
 * @param {string} system   Системная инструкция (может быть пустой строкой).
 * @param {string} prompt   Пользовательский текст запроса.
 * @param {string} model    Идентификатор модели Gemini.
 * @param {string} thinking Уровень размышления: NONE | LOW | MEDIUM | HIGH.
 */
async function callGeminiApi(system, prompt, model = 'gemini-3-flash-preview', thinking = 'HIGH') {
  try {
    console.log('[gemini-api] Sending ' + Math.round(prompt.length / 1024) + 'KB, model=' + model + ' thinking=' + thinking);

    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: system }] },
    };

    if (model.includes('gemini-3') && thinking !== 'NONE') {
      requestBody.generationConfig = {
        thinkingConfig: { thinkingLevel: thinking }
      };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const response = await fetch(
      GEMINI_ENDPOINT + model + ':generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }
    );

    const data = await response.json();

    if (data.error) {
      return { success: false, error: data.error.message || 'Gemini API Error' };
    }

    if (!data.candidates?.[0]?.content?.parts) {
      return { success: false, error: 'Empty or blocked response' };
    }

    const textParts = data.candidates[0].content.parts.filter(p => !p.thought);
    const responseText = textParts.map(p => p.text).join('');

    const usage = data.usageMetadata || {};
    console.log('[gemini-api] Response: ' + Math.round(responseText.length / 1024) + 'KB, input: ' + usage.promptTokenCount + ' output: ' + usage.candidatesTokenCount);
    return {
      success: true,
      text: responseText,
      usage: { input_tokens: usage.promptTokenCount, output_tokens: usage.candidatesTokenCount }
    };
  } catch (error) {
    console.error('[gemini-api] Error:', error);
    return { success: false, error: error.message };
  }
}

module.exports = { callGeminiApi };
