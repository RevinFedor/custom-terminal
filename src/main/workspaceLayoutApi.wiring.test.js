// Раскладка рабочей области как API — то, что чистая модель проверить не может.
//
// Правила самой раскладки живут в splitPanesModel.mjs (arrangePanes) и покрыты
// там. Здесь закреплён путь: MCP → HTTP → мост → стор, и границы, на которых он
// уже мог бы сломаться молча.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const mcp = fs.readFileSync(path.join(root, 'mcp', 'terminal-server.mjs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src', 'main', 'web-server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'App.tsx'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src', 'renderer', 'store', 'useWorkspaceStore.ts'), 'utf8');

test('у рабочей области появился путь наружу: инструмент → эндпоинт → мост → стор', () => {
  // До этого рабочей области не было в API вообще: вкладку создать могли, а
  // сказать, ГДЕ она должна появиться, — нет.
  for (const tool of ['list_windows', 'arrange_windows', 'fork_tab']) {
    assert.match(mcp, new RegExp("name: '" + tool + "'"), tool + ' объявлен');
    assert.match(mcp, new RegExp("case '" + tool + "':"), tool + ' обработан');
  }
  assert.match(server, /parsed\.pathname === '\/api\/workspace' && req\.method === 'GET'/);
  assert.match(server, /parsed\.pathname === '\/api\/workspace\/arrange' && req\.method === 'POST'/);
  assert.match(server, /\\\/api\\\/terminal-tabs\\\/\(\[\^\/\]\+\)\\\/fork/);
  assert.match(app, /action === 'describeWorkspaceLayout'/);
  assert.match(app, /action === 'arrangeWorkspaceLayout'/);
  assert.match(app, /action === 'forkAgentTab'/);
  assert.match(store, /arrangeSplitPanes: \(spec\) => \{/);
});

test('раскладка применяется целиком или никак', () => {
  // Собирать её из одиночных жестов — это несколько обращений, каждое из
  // которых может наполовину не удаться, а защита «одна пустая панель за раз»
  // отклонит второе.
  assert.match(store, /arrangePanes\(st\.splitPanes, st\.splitFocusedIndex, \{ \.\.\.spec, windows \}, current\)/);
  assert.match(store, /if \(!res\) return null;/);
  // Одна запись в состояние на весь вызов.
  assert.match(store, /set\(\{ splitPanes: res\.panes, splitFocusedIndex: res\.focusedIndex \}\);/);
});

test('вложенность списка и есть разница «рядом» против «в одном окне»', () => {
  // Отдельный флаг был бы вторым способом сказать то же самое, и два способа
  // разошлись бы: [[a],[b]] — два окна, [[a,b]] — одно окно с двумя чипами.
  assert.match(mcp, /Outer array = windows in order; inner array = the tabs inside one window/);
  assert.match(server, /Nesting carries the distinction, so no extra flag/);
  // Голый id — окно из одной вкладки: частый случай пишется как ["a","b"].
  assert.match(mcp, /Array\.isArray\(entry\) \? entry : \[entry\]/);
});

test('несуществующая вкладка не превращается в пустое окно', () => {
  assert.match(store, /st\.openProjects\.get\(e\.projectId\)\?\.tabs\.has\(e\.tabId\)/);
});

test('форк вкладки переиспользует существующую реализацию, а не заводит вторую', () => {
  // Живой промах: `forkAgentTab` в мосте УЖЕ был — им пользуется оркестрация.
  // Вторая, написанная рядом, оказалась и слабее (без отказа занятой вкладке,
  // без проверки что разговор сохранён, без родословной форка и без закрытия
  // вкладки при неудачном запуске), и недостижима: первый обработчик с тем же
  // именем отвечал раньше.
  assert.equal(
    (app.match(/if \(action === 'forkAgentTab'\)/g) || []).length,
    1,
    'обработчик действия должен быть ровно один',
  );
  // Эндпоинт зовёт именно его, по его же контракту (sourceTabId, не tabId).
  assert.match(server, /bridgeRequest\('forkAgentTab', \{\n\s+sourceTabId: tabId,/);
  // И с тем же таймаутом: форк от последнего сжатия сперва материализует файл.
  assert.match(server, /fromLatestCompact: body\.fullHistory !== true[\s\S]{0,80}\}, 60_000\);/);
});

test('форк не утаскивает пользователя с текущей вкладки', () => {
  // ГДЕ показать результат — отдельный вопрос, на него отвечает раскладка.
  const forkRoute = server.slice(
    server.indexOf('// Форк вкладки: копия разговора'),
    server.indexOf('// ── Рабочая область'),
  );
  assert.match(forkRoute, /background: true,/);
});
