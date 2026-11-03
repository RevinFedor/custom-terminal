import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Статистика Settings → AI показывает in / out / think / Σ. Колонки должны
// сходиться с Σ у обоих провайдеров, иначе одна и та же таблица складывает
// разные величины: у Gemini `candidatesTokenCount` НЕ включает размышление,
// у OpenAI `completion_tokens` включает. Этот тест берёт реальные функции из
// generateTabTitle.ts, а не их копию.
const source = fs.readFileSync(new URL('./generateTabTitle.ts', import.meta.url), 'utf8');

function extract(name) {
  const ast = ts.createSourceFile('f.ts', source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(fn, name + ' not found');
  return ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const ctx = vm.createContext({});
vm.runInContext(extract('geminiUsage') + '\n' + extract('openAIUsage'), ctx);
const geminiUsage = vm.runInContext('geminiUsage', ctx);
const openAIUsage = vm.runInContext('openAIUsage', ctx);

test('у OpenAI видимый ответ исключает рассуждение, иначе оно считается дважды', () => {
  const usage = openAIUsage({
    prompt_tokens: 100,
    completion_tokens: 60,
    total_tokens: 160,
    completion_tokens_details: { reasoning_tokens: 45 },
  });
  assert.equal(usage.promptTokens, 100);
  assert.equal(usage.candidateTokens, 15); // 60 − 45, а не 60
  assert.equal(usage.thoughtTokens, 45);
  assert.equal(usage.totalTokens, 160);
  // Колонки сходятся с Σ — именно это видит пользователь в таблице.
  assert.equal(usage.promptTokens + usage.candidateTokens + usage.thoughtTokens, usage.totalTokens);
});

test('ответ без рассуждения не теряет выходные токены', () => {
  const usage = openAIUsage({ prompt_tokens: 80, completion_tokens: 9, total_tokens: 89 });
  assert.equal(usage.candidateTokens, 9);
  assert.equal(usage.thoughtTokens, 0);
  assert.equal(usage.totalTokens, 89);
});

test('отсутствующий total считается, а не обнуляется', () => {
  const usage = openAIUsage({ prompt_tokens: 40, completion_tokens: 12 });
  assert.equal(usage.totalTokens, 52);
});

test('рассуждение больше completion не даёт отрицательный ответ', () => {
  // Защита от несогласованного ответа провайдера: таблица не должна
  // показывать отрицательное out.
  const usage = openAIUsage({ prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 9 } });
  assert.equal(usage.candidateTokens, 0);
});

test('Gemini: candidates уже без размышления, пересчёт не нужен', () => {
  const usage = geminiUsage({
    promptTokenCount: 200, candidatesTokenCount: 30, thoughtsTokenCount: 50, totalTokenCount: 280,
  });
  // Объект приходит из vm-песочницы с чужим прототипом, поэтому сравниваются
  // поля, а не ссылка на объект целиком.
  assert.equal(usage.promptTokens, 200);
  assert.equal(usage.candidateTokens, 30);
  assert.equal(usage.thoughtTokens, 50);
  assert.equal(usage.totalTokens, 280);
});

test('пустой usage обоих провайдеров даёт нули, а не NaN', () => {
  for (const usage of [openAIUsage(undefined), openAIUsage({}), geminiUsage(undefined), geminiUsage({})]) {
    for (const value of Object.values(usage)) assert.equal(value, 0);
  }
});
