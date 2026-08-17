import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '../../..');
const cssSource = fs.readFileSync(
  path.join(repoRoot, 'packages/claude-blocks/src/blocks.css'),
  'utf8',
);
const themeSource = fs.readFileSync(
  path.join(repoRoot, 'packages/claude-blocks/src/theme.css'),
  'utf8',
);
const panelSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

/**
 * «Раскрыть полностью» / «Свернуть» сидят ВЕРХОМ на рамке сообщения и не стоят
 * раскладке ничего — та же механика, что у плашки состояния на рамке композера.
 *
 * Проверяется именно то, что легко сломать молча: вернуть кнопку в поток (и блок
 * снова начнёт прыгать на собственной кнопке), взять полупрозрачную подложку (и
 * линия рамки будет просвечивать сквозь текст кнопки) или снять потолок размера
 * шрифта (и на крупной настройке кнопки соседних сообщений начнут наезжать друг
 * на друга и на текст — замерено на 24px: 9px и 3.5px наложения).
 */

const rule = (selectorList) => {
  const start = cssSource.indexOf(selectorList);
  assert.ok(start >= 0, 'правило ' + selectorList + ' должно существовать');
  const open = cssSource.indexOf('{', start);
  const close = cssSource.indexOf('}', open);
  return cssSource.slice(open + 1, close);
};

test('обе кнопки вынуты из потока — высота блока не зависит от раскрытия', () => {
  const body = rule('.cb-collapse-top,\n.cb-collapse-bottom');
  assert.match(body, /position:\s*absolute/);
  // Ряд под кнопку больше не отводится: прежние margin-компенсации удалены.
  assert.doesNotMatch(cssSource, /\.cb-collapse-top\s*\{\s*margin-bottom/);
  assert.doesNotMatch(cssSource, /\.cb-collapse-bottom\s*\{\s*margin-top/);
});

test('кнопка садится верхом на линию: половина снаружи, половина внутрь', () => {
  // Якорь — начало строки: короткое имя `.cb-collapse-bottom {` встречается и в
  // групповом селекторе выше, поэтому поиск подстрокой указал бы не на то правило.
  assert.match(cssSource, /^\.cb-collapse-top \{[^}]*top:\s*0[^}]*translateY\(-50%\)/m);
  assert.match(cssSource, /^\.cb-collapse-bottom \{[^}]*bottom:\s*0[^}]*translateY\(50%\)/m);
});

test('подложка кнопки непрозрачна, иначе линия рамки просвечивает сквозь текст', () => {
  const body = rule('.cb-collapse-top,\n.cb-collapse-bottom');
  assert.match(body, /background:\s*var\(--cb-user-bubble-bg-solid\)/);
  // Токен обязан быть НЕПРОЗРАЧНЫМ: rgba/transparent здесь не скроют линию.
  const decl = themeSource.match(/--cb-user-bubble-bg-solid:\s*([^;]+);/);
  assert.ok(decl, 'токен непрозрачного фона бабла должен быть объявлен');
  assert.match(decl[1].trim(), /^#[0-9a-f]{6}$/i);
});

test('точка отсчёта — сам бабл, иначе кнопка уедет к краю колонки', () => {
  assert.match(rule('.cb-user-bubble {'), /position:\s*relative/);
});

test('кнопка стоит у ЛЕВОГО края текста', () => {
  // Подпись читают слева — там, где начинается строка и куда возвращается взгляд
  // после чтения. У правого края к тому же уже стоит панель действий сообщения.
  const body = rule('.cb-collapse-top,\n.cb-collapse-bottom');
  assert.match(body, /left:\s*12px/);
  assert.doesNotMatch(body, /right:\s*12px/);
  // 12px = горизонтальный padding бабла, то есть ровно край текста, а не край
  // рамки: иначе кнопка висела бы левее первой буквы.
  assert.match(rule('.cb-user-bubble {'), /padding:\s*8px 12px/);
});

test('размер кнопки ограничен сверху — иначе она наедет на соседнее сообщение', () => {
  // Шов, в который она обязана уложиться: 6px до соседнего бабла снаружи
  // (половина 12px-зазора) и 8px собственного padding бабла внутри.
  const body = rule('.cb-collapse-top .cb-collapse-btn,\n.cb-collapse-bottom .cb-collapse-btn');
  const cap = body.match(/font-size:\s*min\(0\.85em,\s*(\d+)px\)/);
  assert.ok(cap, 'у шрифта кнопки должен быть верхний потолок');
  assert.ok(Number(cap[1]) <= 11, 'потолок больше 11px не оставляет зазора между кнопками');
  // line-height: 1 — без него кнопка свисает на лишние ~40% размера шрифта.
  assert.match(rule('.cb-collapse-top,\n.cb-collapse-bottom'), /line-height:\s*1\b/);
});

test('верхняя кнопка только у раскрытого блока', () => {
  // У свёрнутого начало текста видно целиком, дублировать «раскрыть» в двух
  // углах маленькой шапки нечего; у раскрытого конец текста может быть далеко.
  assert.match(
    panelSource,
    /\{open && !forceExpanded && <div className="cb-collapse-top">/,
  );
  assert.match(
    panelSource,
    /\{!forceExpanded && <div className="cb-collapse-bottom">/,
  );
});
