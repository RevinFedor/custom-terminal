import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_TAB_NAME, isEmptyTab } from './emptyTab.mjs';

test('пустая вкладка — обычная вкладка, в которой ничего не запущено', () => {
  assert.equal(isEmptyTab({ tabType: 'terminal' }), true);
  assert.equal(isEmptyTab({}), true, 'тип по умолчанию — терминал');
  assert.equal(isEmptyTab({ tabType: 'terminal', claudeSessionId: 'x' }), false);
  assert.equal(isEmptyTab({ tabType: 'terminal', codexSessionId: 'x' }), false);
  assert.equal(isEmptyTab({ tabType: 'terminal', geminiSessionId: 'x' }), false);
});

test('запуск уже в пути — вкладка больше не пустая', () => {
  // Кнопки должны исчезнуть СЕЙЧАС, а не когда процесс отчитается: иначе между
  // нажатием и стартом можно запустить второго агента в тот же терминал.
  assert.equal(isEmptyTab({ pendingAction: { type: 'claude-new' } }), false);
  assert.equal(isEmptyTab({ commandType: 'claude' }), false);
  // Shell-команда — не агент: вкладка так и стоит пустой, в ней просто что-то
  // выполнили.
  assert.equal(isEmptyTab({ pendingAction: { type: 'shell-command', command: 'ls' } }), true);
});

test('файл, браузер и SDK пустыми не бывают', () => {
  // Они не ждут, чтобы их заполнили: файл показывает файл, браузер — страницу,
  // SDK-вкладка САМА и есть переписка.
  assert.equal(isEmptyTab({ tabType: 'file', filePath: '/x.md' }), false);
  assert.equal(isEmptyTab({ tabType: 'browser', url: 'http://x' }), false);
  assert.equal(isEmptyTab({ tabType: 'claude-sdk' }), false);
});

test('имя пустой вкладки говорит о состоянии, а не о порядковом номере', () => {
  // `tab-7` сообщает только, что до неё было шесть других.
  assert.equal(EMPTY_TAB_NAME, 'Пустая вкладка');
});

// ── Кнопки запуска в пустой вкладке ───────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.join(here, '..', 'components', 'Workspace');
const bar = fs.readFileSync(path.join(workspaceDir, 'ClaudeControlBar.tsx'), 'utf8');
const terminal = fs.readFileSync(path.join(workspaceDir, 'Terminal.tsx'), 'utf8');

test('кнопки в центре — та же полоса, а не вторая копия', () => {
  // Второй набор кнопок «которые просто запускают ту же команду» был бы вторым
  // лаунчером: гард жизненного цикла, авто-имя и проверки Codex живут в панели
  // управления, и копия разошлась бы с ней на первом же изменении правил.
  // Поэтому переезжает не компонент, а его ВЫВОД — порталом.
  assert.match(bar, /renderInto\(\s*\n?\s*emptyLaunchHost,/);
  assert.equal((bar.match(/<AiLaunchStrip/g) || []).length, 1, 'полоса в панели одна');
  assert.match(terminal, /setEmptyTabLaunchHost\(tabId, node\)/);
});

test('пустое место публикуется только пока вкладка пустая', () => {
  assert.match(terminal, /const node = isEmptyTabHere \? emptyLaunchSlotRef\.current : null;/);
  // Снимаем слот, только если он всё ещё наш: при перестроении раскладки новый
  // хост монтируется раньше, чем размонтируется старый, и очистка по одному
  // лишь id стёрла бы только что опубликованное место.
  assert.match(terminal, /releaseEmptyTabLaunchHost\(tabId, node\)/);
});

test('под кнопками остаётся живой терминал', () => {
  // Вкладка «пустая» — это описание, а не отдельный тип без процесса: под
  // плашкой обычный shell, и кому нужна просто команда — печатает её.
  assert.match(terminal, /pointerEvents: 'none',\n\s+zIndex: 40,/);
});

test('кнопки одного действия не разъезжаются по разным концам экрана', () => {
  // Живой баг: полоса уехала в центр, а ведущий чип Claude остался в баре —
  // внизу слева одиноко висел оранжевый «Start», а первой кнопкой в центре стал
  // зелёный «Start» Codex. То есть оба места врали, какой агент запустится.
  //
  // Чип уходит из бара ровно тогда, когда полоса уехала, и полоса в этом случае
  // рисует его сама.
  assert.match(bar, /\(!dockedInComposer && !emptyLaunchHost\) && \(/);
  assert.match(bar, /ownsClaudeChip=\{!!emptyLaunchHost\}/);
});

test('чип Claude в центре действительно запускает Claude', () => {
  // Полоса рисует чип только при ownsClaudeChip, и он шлёт действие 'claude' —
  // без ветки в обработчике кнопка была бы мёртвой. Запуск идёт через тот же
  // onStart, что у чипа в баре: там гард жизненного цикла и авто-имя.
  assert.match(bar, /case 'claude':\n(\s+\/\/[^\n]*\n)+\s+void onStart\(\);/);
});
