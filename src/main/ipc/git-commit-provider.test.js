'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGitCommitModel, GIT_COMMIT_PROVIDER } = require('./git-commit-provider');
const { resolveUtilityAIModel, openAIEffortForModel, UTILITY_AI_PROVIDER } = require('../../shared/utility-ai-provider.cjs');
const { callOpenAIApi } = require('./openai-api');

test('utility-вызовы и сообщение коммита используют один выбор провайдера', () => {
  assert.equal(UTILITY_AI_PROVIDER, 'openai');
  // Git не держит собственную константу: расхождение дало бы разный провайдер
  // у соседних строк одной таблицы статистики.
  assert.equal(GIT_COMMIT_PROVIDER, UTILITY_AI_PROVIDER);
});

// Главный шрам этой правки: в Settings у всех utility-записей уже сохранены
// модели Gemini. Они старше любого дефолта в коде и без замены уехали бы в
// OpenAI как имя модели.
test('сохранённая модель чужого провайдера заменяется, а не отправляется', () => {
  for (const resolved of [
    resolveUtilityAIModel('gemini-3.1-flash-lite', 'NONE', 'openai'),
    resolveGitCommitModel('gemini-3.1-flash-lite', 'NONE', 'openai'),
  ]) {
    assert.equal(resolved.model, 'gpt-5-nano');
    assert.equal(resolved.replacedModel, 'gemini-3.1-flash-lite');
    assert.equal(resolved.provider, 'openai');
  }
});

test('дефолт дешевле прежнего Gemini, а не дороже', () => {
  // gpt-5-nano $0.05/$0.40 против gemini-3.1-flash-lite $0.25/$1.50.
  // gpt-5.4-mini ($0.75/$4.50) дороже прежнего и не годится в умолчания.
  assert.equal(resolveUtilityAIModel('', '', 'openai').model, 'gpt-5-nano');
});

test('сохранённая модель своего провайдера остаётся пользовательской', () => {
  const resolved = resolveUtilityAIModel('gpt-6-luna', 'LOW', 'openai');
  assert.equal(resolved.model, 'gpt-6-luna');
  assert.equal(resolved.replacedModel, null);
  assert.equal(resolved.thinking, 'LOW');
});

test('незаданная модель даёт дефолт провайдера без отметки о замене', () => {
  for (const empty of ['', null, undefined, '   ']) {
    const resolved = resolveUtilityAIModel(empty, '', 'openai');
    assert.equal(resolved.model, 'gpt-5-nano');
    assert.equal(resolved.thinking, 'NONE');
    assert.equal(resolved.replacedModel, null);
  }
});

test('переключение на Gemini возвращает прежнюю пару в обе стороны', () => {
  const resolved = resolveUtilityAIModel('gemini-3.1-flash-lite', 'NONE', 'gemini');
  assert.equal(resolved.provider, 'gemini');
  assert.equal(resolved.model, 'gemini-3.1-flash-lite');
  assert.equal(resolved.replacedModel, null);
  assert.equal(resolveUtilityAIModel('gpt-5-nano', 'NONE', 'gemini').model, 'gemini-3.1-flash-lite');
});

test('неизвестный провайдер не падает и не выдумывает модель', () => {
  const resolved = resolveUtilityAIModel('gpt-5-nano', 'NONE', 'perplexity');
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.model, 'gpt-5-nano');
});

// API отвергает `none` для gpt-5-nano и `minimal` для gpt-5.4-mini: одинаковая
// для всех таблица уровней ломала бы один из вызовов.
test('минимальный уровень размышления зависит от модели, а не только от провайдера', () => {
  assert.equal(openAIEffortForModel('NONE', 'gpt-5-nano'), 'minimal');
  assert.equal(openAIEffortForModel('NONE', 'gpt-5-mini'), 'minimal');
  assert.equal(openAIEffortForModel('NONE', 'gpt-5.4-mini'), 'none');
  assert.equal(openAIEffortForModel('NONE', 'gpt-6-luna'), 'none');
  // Неизвестная модель получает более широко поддержанный `minimal`.
  assert.equal(openAIEffortForModel('NONE', 'gpt-future-x'), 'minimal');
});

test('остальные уровни переносятся как есть, неизвестный не выдумывается', () => {
  assert.equal(openAIEffortForModel('LOW', 'gpt-5-nano'), 'low');
  assert.equal(openAIEffortForModel('high', 'gpt-5-nano'), 'high');
  assert.equal(openAIEffortForModel('XHIGH', 'gpt-6-luna'), 'xhigh');
  assert.equal(openAIEffortForModel('MINIMAL', 'gpt-5-nano'), null);
  assert.equal(openAIEffortForModel('', 'gpt-5-nano'), null);
  assert.equal(openAIEffortForModel(undefined, 'gpt-5-nano'), null);
});

function fakeFetch(payload, capture) {
  return async (url, init) => {
    if (capture) { capture.body = JSON.parse(init.body); capture.headers = init.headers; }
    return { json: async () => payload };
  };
}

test('ответ OpenAI приводится к общему контракту Gemini', async () => {
  const capture = {};
  const result = await callOpenAIApi('sys', 'user text', 'gpt-5-nano', 'NONE', {
    apiKey: 'test-not-a-key',
    fetchImpl: fakeFetch({
      choices: [{ message: { content: '{"summary":"Fix thing"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }, capture),
  });
  assert.equal(result.success, true);
  assert.equal(result.text, '{"summary":"Fix thing"}');
  assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 7 });
  assert.equal(capture.body.reasoning_effort, 'minimal');
  assert.deepEqual(capture.body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user text' },
  ]);
});

test('пустая системная инструкция не создаёт пустое system-сообщение', async () => {
  const capture = {};
  await callOpenAIApi('   ', 'only user', 'gpt-5-nano', 'NONE', {
    apiKey: 'test-not-a-key',
    fetchImpl: fakeFetch({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }, capture),
  });
  assert.deepEqual(capture.body.messages, [{ role: 'user', content: 'only user' }]);
});

// Шрам пересказов через API: пустой текст при `finish_reason: length` означает,
// что бюджет ушёл в рассуждение. Считать это успешным пустым ответом нельзя —
// вызывающий тогда запишет пустое сообщение коммита как результат.
test('израсходованный на рассуждение бюджет — ошибка, а не пустой успех', async () => {
  const result = await callOpenAIApi('sys', 'p', 'gpt-5-nano', 'HIGH', {
    apiKey: 'test-not-a-key',
    fetchImpl: fakeFetch({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 20, completion_tokens: 2048, completion_tokens_details: { reasoning_tokens: 2048 } },
    }),
  });
  assert.equal(result.success, false);
  assert.match(result.error, /budget spent before any text/);
  assert.match(result.error, /2048/);
  assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 2048 });
});

test('ошибка провайдера и отсутствие ключа возвращают success:false без исключения', async () => {
  const apiError = await callOpenAIApi('s', 'p', 'gpt-5-nano', 'NONE', {
    apiKey: 'test-not-a-key',
    fetchImpl: fakeFetch({ error: { message: 'model not found' } }),
  });
  assert.equal(apiError.success, false);
  assert.equal(apiError.error, 'model not found');

  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const noKey = await callOpenAIApi('s', 'p');
    assert.equal(noKey.success, false);
    assert.match(noKey.error, /OPENAI_API_KEY is not configured/);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
  }
});

test('сетевой сбой не роняет main-процесс', async () => {
  const result = await callOpenAIApi('s', 'p', 'gpt-5-nano', 'NONE', {
    apiKey: 'test-not-a-key',
    fetchImpl: async () => { throw new Error('fetch failed'); },
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'fetch failed');
});

test('ключ уходит в заголовок Authorization, а не в URL', async () => {
  const capture = {};
  await callOpenAIApi('s', 'p', 'gpt-5-nano', 'NONE', {
    apiKey: 'test-not-a-key',
    fetchImpl: fakeFetch({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }, capture),
  });
  assert.equal(capture.headers.Authorization, 'Bearer test-not-a-key');
});
