// Показатели шапки вкладки читаются ОДНИМ запросом, и одновременные вызовы
// об одной вкладке его разделяют.
//
// Шрам 02.11 (прод): первый скролл сразу после перехода на вкладку стоил до
// 345мс при максимальной синхронной блокировке главного потока 45мс в том же
// окне. Поток не считал — он разгребал очередь: до 189 операций на один
// переход, почти все мелкие запросы об одной и той же вкладке. Колесо вставало
// за ними.
//
// Два отдельных эффекта в шапке (`get-context-pct`, `get-cache-stats`) плюс
// `provider:get-status` объединены в `tab:get-header-signals`. Шапка при этом
// монтируется в нескольких местах сразу (центр, боковая панель, удерживаемые
// окна), поэтому без склейки выигрыш умножился бы на число панелей.
//
// Исполняется НАСТОЯЩИЙ модуль, скомпилированный из .ts.
//
// Run: node --test src/renderer/utils/tabHeaderSignals.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const require = createRequire(resolve(REPO, 'package.json'));
const { transformSync } = require('esbuild');

const SOURCE = readFileSync(resolve(HERE, 'tabHeaderSignals.ts'), 'utf8');
const CODE = transformSync(SOURCE, { loader: 'ts', format: 'cjs' }).code;

function build({ reply = () => ({ contextPct: { pct: 42 }, cacheStats: { ts: 7 }, provider: {} }),
  hasBridge = true } = {}) {
  const calls = [];
  const resolvers = [];
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload });
      const value = reply(payload, calls.length);
      if (value === 'defer') return new Promise(res => resolvers.push(res));
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value);
    },
  };
  const sandbox = {
    window: { require: name => hasBridge && name === 'electron' ? { ipcRenderer } : null },
    module: { exports: {} },
    Date, Promise, Map,
  };
  // `exports` должен быть ТЕМ ЖЕ объектом, что `module.exports`: esbuild в cjs
  // пишет в оба, и расхождение прячет часть экспорта.
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return { api: sandbox.module.exports, calls, resolvers };
}

test('один вызов — один запрос в один канал', async () => {
  const { api, calls } = build();
  const value = await api.headerSignals('tab-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'tab:get-header-signals', 'именно объединённый канал');
  assert.deepEqual({ ...calls[0].payload }, { tabId: 'tab-1' });
  assert.equal(value.contextPct.pct, 42);
  assert.equal(value.cacheStats.ts, 7);
});

test('одновременные вызовы об одной вкладке дают ОДИН запрос', async () => {
  // Прямая репродукция того, ради чего склейка: шапка монтируется в
  // нескольких панелях одновременно.
  const { api, calls } = build();
  const [a, b, c] = await Promise.all([
    api.headerSignals('tab-1'), api.headerSignals('tab-1'), api.headerSignals('tab-1'),
  ]);
  assert.equal(calls.length, 1, `${calls.length} запросов вместо одного`);
  assert.equal(a, b, 'все получают один и тот же ответ');
  assert.equal(b, c);
});

test('разные вкладки не склеиваются между собой', async () => {
  const { api, calls } = build();
  await Promise.all([api.headerSignals('tab-1'), api.headerSignals('tab-2')]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.payload.tabId).sort(), ['tab-1', 'tab-2']);
});

test('следующий переход на ту же вкладку получает СВЕЖИЕ значения', async () => {
  // Склейка не должна превращаться в кэш: процент контекста меняется каждый
  // ход, и показать прошлое значение хуже, чем не показать ничего.
  let n = 0;
  const { api, calls } = build({ reply: () => ({ contextPct: { pct: ++n * 10 }, cacheStats: null, provider: null }) });
  assert.equal((await api.headerSignals('tab-1')).contextPct.pct, 10);
  assert.equal((await api.headerSignals('tab-1')).contextPct.pct, 20, 'второй переход читает заново');
  assert.equal(calls.length, 2);
});

test('отказ не бросается и не застревает', async () => {
  // Шапка показывает значения по мере готовности; отсутствие засева не должно
  // ронять её монтирование. И застрявшая запись о запросе заблокировала бы
  // следующий переход.
  const { api, calls } = build({ reply: (_payload, index) => index === 1 ? new Error('нет связи') : ({ contextPct: { pct: 5 }, cacheStats: null, provider: null }) });
  assert.equal(await api.headerSignals('tab-1'), null, 'отказ отдаётся как null');
  assert.equal((await api.headerSignals('tab-1')).contextPct.pct, 5, 'следующий вызов проходит');
  assert.equal(calls.length, 2);
});

test('без моста к приложению вызов безопасен', async () => {
  const { api, calls } = build({ hasBridge: false });
  assert.equal(await api.headerSignals('tab-1'), null);
  assert.equal(calls.length, 0);
});

test('пустой идентификатор не создаёт запрос', async () => {
  const { api, calls } = build();
  assert.equal(await api.headerSignals(''), null);
  assert.equal(calls.length, 0);
});

test('нестандартный ответ не выдаётся за данные', async () => {
  for (const bad of ['строка', 42, [], null, undefined]) {
    const { api } = build({ reply: () => bad });
    const value = await api.headerSignals('tab-1');
    assert.ok(value === null || (typeof value === 'object' && value !== null),
      'ответ ' + JSON.stringify(bad) + ' должен стать null или объектом, получено ' + typeof value);
  }
});

test('запись о запросе снимается после ответа, а не висит', async () => {
  const { api } = build();
  await api.headerSignals('tab-1');
  assert.equal(api.tabHeaderSignalsInFlight(), 0, 'после ответа ничего не удерживается');
});

test('прежние каналы СОХРАНЕНЫ в главном процессе', () => {
  // Их зовут очередь промптов, Run After и мост приложения — у каждого свой
  // момент вызова и свои аргументы. Удалить их значило бы сломать эти пути
  // ради одного переключения вкладки.
  const main = readFileSync(resolve(REPO, 'src/main/main.js'), 'utf8');
  for (const channel of ['tab:get-context-pct', 'tab:get-cache-stats', 'provider:get-status']) {
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), 'канал удалён: ' + channel);
  }
  assert.ok(main.includes("ipcMain.handle('tab:get-header-signals'"), 'объединённый канал должен существовать');
});

test('объединённый обработчик зовёт ТУ ЖЕ логику процента, не копию', () => {
  // Две реализации процента контекста разошлись бы, и шапка показывала бы
  // одно число при монтировании и другое после первого события.
  const main = readFileSync(resolve(REPO, 'src/main/main.js'), 'utf8');
  assert.ok(main.includes('async function readTabContextPct('), 'логика вынесена в функцию');
  const handler = main.slice(main.indexOf("ipcMain.handle('tab:get-header-signals'"));
  assert.ok(handler.slice(0, 1800).includes('readTabContextPct('),
    'объединённый обработчик должен звать общую функцию');
  assert.ok(main.includes("ipcMain.handle('tab:get-context-pct', (_event, request = {}) => readTabContextPct(request))"),
    'и прежний канал — её же');
});
