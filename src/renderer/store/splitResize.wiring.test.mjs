// Resizable split dividers — the wiring contracts the pure model cannot see.
//
// The model owns the fraction math (splitSizes.test.mjs); these pin HOW the
// app talks to it: the live drag must not write the store per mousemove, the
// memo must read the committed sizes, and persistence must carry them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, ...p), 'utf8');
const store = read('useWorkspaceStore.ts');
const chrome = read('..', 'components', 'Workspace', 'SplitPaneChrome.tsx');
const terminalArea = read('..', 'components', 'Workspace', 'TerminalArea.tsx');
const snapshot = read('..', 'utils', 'sessionSnapshot.mjs');

function block(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
}

// ── One store write per finished drag ─────────────────────────────────────

test('the live drag repositions the DOM; only mouseup commits to the store', () => {
  const layer = block(chrome, 'export function SplitDividerLayer()', '\n// Markdown/file content');
  const onMove = block(layer, 'const onMove = (ev: MouseEvent) => {', 'const stopListening');
  // A commitSplitSizes (or any set()) inside onMove would rebuild the whole
  // terminals memo — every pane of every project — at pointer speed.
  assert.ok(!onMove.includes('commitSplitSizes'), 'onMove must not write the store');
  assert.ok(!/set\(\{/.test(onMove), 'onMove must not write the store');
  assert.match(onMove, /applyLiveGeometry\(next\)/);
  const onUp = block(layer, 'const onUp = () => {', 'cancelDragRef.current = () => {');
  assert.match(onUp, /commitSplitSizes\(finalSizes\)/);
});

test('live resize moves the outer window while heavy content stays frozen until release', () => {
  const layer = block(chrome, 'export function SplitDividerLayer()', '\n// Markdown/file content');
  const drag = block(layer, 'const startDrag = (', '\n  return (');
  assert.match(chrome, /function freezePaneContentsForResize\(host: HTMLElement\)/);
  assert.match(chrome, /data-split-resize-content-frozen/);
  assert.match(drag, /freezePaneContentsForResize\(host\)/);
  assert.match(drag, /applyLiveGeometry\(next\)/, 'outer wrappers still follow every pointer move');
  assert.match(drag, /flushSync\(\(\) => \{[\s\S]{0,500}commitSplitSizes\(finalSizes\)/,
    'final React geometry commits while content is still frozen');
  const commitAt = drag.indexOf('commitSplitSizes(finalSizes)');
  const releaseAt = drag.indexOf('freeze.release(', commitAt);
  assert.ok(commitAt >= 0 && releaseAt > commitAt, 'freeze releases only after the final commit');
  assert.match(drag, /window\.addEventListener\('blur', onWindowBlur\)/);
  assert.match(drag, /applyPaneGeometryToDom\(currentHost, current\.splitPanes, current\.splitSizes\)/,
    'lost mouseup cancels the preview and restores committed geometry');
  assert.doesNotMatch(drag, /requestAnimationFrame|setTimeout|setInterval/,
    'resize is event-driven; no cosmetic waiting window');
});

test('History captures before frozen-box mutation and restores only after release', () => {
  const freeze = block(chrome, 'function freezePaneContentsForResize', '\nfunction applyPaneGeometryToDom');
  assert.ok(freeze.indexOf('beginHistoryResize(host)') < freeze.indexOf("wrapper.setAttribute('data-split-resize-frozen'"));
  assert.ok(freeze.indexOf('finishHistoryResize(changed)') > freeze.indexOf('content.style.height = previous.height'));
  assert.match(chrome, /freeze\.release\(false\)/, 'cancel must not claim a committed resize');
});

test('commit packs against the CURRENT panes, and an equal split stores null', () => {
  const commit = block(store, 'commitSplitSizes: (sizes) => {', '\n  },');
  assert.match(commit, /packSplitSizes\(get\(\)\.splitPanes, sizes\)/);
  assert.match(commit, /saveSession\(\)/, 'a finished drag must persist');
  // No-op guard: dblclick-reset on an already-equal layout writes nothing.
  assert.match(commit, /packed === null && prev === null\) return/);
});

// ── The memo follows the committed sizes ──────────────────────────────────

test('the terminals memo reads splitSizes, or a later rebuild snaps panes back', () => {
  // Key: the memo's subscription string must carry a sizes fingerprint —
  // without it, a rebuild triggered by anything else (tab created, view
  // switched) would repaint the wrappers at the EQUAL split.
  const layerKey = block(terminalArea, 'const activeLayerKey = useWorkspaceStore', '});');
  assert.match(layerKey, /splitPanesFingerprint\(s\.splitPanes\)/,
    '[] and [empty pane] must invalidate the visible terminal memo');
  assert.match(layerKey, /splitSizesFingerprint\(s\.splitSizes\)/);
  assert.match(layerKey, /s\.spaces\.map/,
    'hidden workflow geometry also owns persistent pane shape');
  // And the rect calls must actually pass the sizes through.
  const memoBody = block(terminalArea, 'const terminals = useMemo(() => {', '\n  }, [');
  assert.match(memoBody, /splitPaneRectStyle\(layoutPaneIndex, layoutPanes, layoutSizes\)/,
    'tab-owned persistent surface must read the exact workflow geometry');
  assert.match(memoBody, /splitPaneRectStyle\(paneIndex, layout\.splitPanes, layout\.splitSizes\)/,
    'workflow-owned persistent chrome must read its own saved sizes');
  assert.match(memoBody, /splitPaneRectStyle\(paneIndex, splitPanes, splitSizes\)/,
    'active empty pane must read the live sizes');
});

test('the divider layer is a SIBLING of the pane wrappers', () => {
  // applyLiveGeometry finds the wrappers via parentElement — the layer must
  // mount in the same host, right next to {terminals}.
  const host = block(terminalArea, '{terminals}', 'currentView === \'terminal\'');
  assert.match(host, /<SplitDividerLayer \/>/);
});

// ── Persistence ───────────────────────────────────────────────────────────

test('the session snapshot carries splitSizes (both save paths share it)', () => {
  assert.match(snapshot, /splitSizes: state\.splitSizes \?\? null/);
  assert.match(snapshot, /'splitSizes',/, 'field list guards the two writers');
});

test('restore re-packs sizes against the SANITIZED panes', () => {
  // A pane whose tab died over the restart shrinks the structure; its sizes
  // must self-clean instead of shadowing the next layout with a stale shape.
  const restore = block(store, 'const restoredSplit = sanitizePanes(', 'RestoreSession] done');
  assert.match(restore, /splitSizes: packSplitSizes\(restoredSplit\.panes/);
});

test('a split STARTED from single mode opens equal, not at the dead layout\'s sizes', () => {
  // The read-time drift rule cannot catch this: a dead 2-column layout's
  // sizes still COUNT-match a fresh 2-column one, so each single-mode entry
  // point must clear them explicitly. The markers are the IMPLEMENTATION
  // forms — `name: (args) => {` — because the interface declares the same
  // names first and a bare `name: (` marker reads the type, not the code.
  const entryPoints = [
    'addTabToSplit: (projectId, tabId) => {',
    "addEmptySplitPane: (anchorPaneIndex, side = 'right') => {",
    'addVerticalSplitPane: (atPaneIndex, side) => {',
  ];
  for (const marker of entryPoints) {
    const body = block(store, marker, '\n  },');
    assert.match(body, /splitPanes\.length === 0 \? \{ splitSizes: null \}/, marker);
  }
});

// ── The split button at the limit ─────────────────────────────────────────

test('the split button greys out when refused instead of disappearing', () => {
  // Reported live: three panes open (one column + a stacked pair) and «кнопка,
  // отвечающая за разделение, тупо пропала». Two defects in one: the cap was
  // counted in panes rather than columns, and the control was mounted
  // CONDITIONALLY, so hitting it removed the button instead of explaining it.
  //
  // The caps themselves are gone (2026-08-17), so the only refusal left is an
  // unfilled placeholder — but the mounting rule outlives them: a control that
  // vanishes reads as a bug whatever made it unavailable.
  const row = block(chrome, 'export function SplitPaneAttachRow(', '\n/** Above every surface');
  assert.ok(!/\{canSplit && \(/.test(row), 'the button must not be conditionally mounted');
  assert.match(row, /splitAvailability\(splitPanes, paneIndex \?\? null\)/);
  // Both directions asked separately: a full column must not hide the
  // still-possible sideways split.
  assert.match(row, /splitCan\.horizontal/);
  assert.match(row, /splitCan\.vertical/);
  // And the disabled state must SAY why.
  assert.match(row, /Сначала выберите вкладку для пустой панели/);
});

test('«можно ли ещё делить» спрашивают у модели, а не считают панели', () => {
  // Когда-то это считалось числом панелей и отказывало в третьей колонке, пока
  // на экране ещё было место. Ограничений по числу давно нет, но правило,
  // которое их пережило, важнее: на вопрос отвечает ОДНО место, и вызывающие
  // спрашивают его, а не выводят ответ из числа заново.
  //
  // Пункты контекстного меню «Добавить в область» и «Открыть в этом окне»
  // удалены по просьбе пользователя (2026-08-18), поэтому единственный
  // оставшийся вызывающий — шапка окна; она проверена тестом выше.
  const tabBar = read('..', 'components', 'Workspace', 'TabBar.tsx');
  assert.ok(!/splitPanes\.length >= 3/.test(tabBar), 'счёт панелей не должен вернуться');
  assert.ok(!/Добавить в область/.test(tabBar));
});

// ── Gestures around the drag ──────────────────────────────────────────────

test('the strips are the violet drag language, same as the sidebar handle', () => {
  assert.match(chrome, /SPLIT_DIVIDER_HOVER_BG = 'rgba\(99,102,241,0\.4\)'/);
  const layer = block(chrome, 'export function SplitDividerLayer()', '\n// Markdown/file content');
  assert.match(layer, /col-resize/);
  assert.match(layer, /row-resize/);
});

// ── Меню направления: иконка + одно слово ─────────────────────────────────

test('пункты меню направления называют только СТОРОНУ, глагол остаётся на кнопке', () => {
  // Было «Разделить: панель сверху» / «Разделить: панель снизу» — две длинные
  // строки, отличающиеся одним словом в самом конце. Чтобы выбрать, приходилось
  // дочитывать обе до конца, хотя вопрос у меню ровно один: с какой стороны.
  // Глагол уже назван кнопкой, которая это меню открыла.
  const row = block(chrome, 'export function SplitPaneAttachRow(', '\n/** Above every surface');
  assert.doesNotMatch(row, /label: 'Разделить: панель/);
  assert.match(row, /side: 'above' as const, label: 'Сверху', Icon: PanelTop/);
  assert.match(row, /side: 'below' as const, label: 'Снизу', Icon: PanelBottom/);
  // Иконка показывает ФОРМУ результата — без неё одно слово осталось бы без
  // подсказки, что вообще произойдёт.
  assert.match(chrome, /import \{[^}]*PanelBottom[^}]*PanelTop[^}]*\} from 'lucide-react'/);
  assert.match(row, /<Icon size=\{13\}/);
});

// ── Зона захвата шире видимой полоски ─────────────────────────────────────

test('перегородку ловят по зоне ШИРЕ, чем она нарисована', () => {
  // Поймать границу мышью и увидеть её — разные задачи с разными правильными
  // размерами: полоска толщиной с прицел выглядит грубо, прицел толщиной с
  // полоску заставляет целиться. Два числа, и растёт только зона — на экране не
  // меняется ничего (юзер: «визуально идентично, область срабатывания больше»).
  assert.match(chrome, /const SPLIT_DIVIDER_VISUAL_PX = 6;/);
  assert.match(chrome, /const SPLIT_DIVIDER_HIT_GROW_PX = 2;/);
  assert.match(chrome, /SPLIT_DIVIDER_VISUAL_PX \+ SPLIT_DIVIDER_HIT_GROW_PX \* 2/);
  // Подсветка живёт на ВНУТРЕННЕЙ полоске: покрась её на всей зоне — и
  // «визуально идентично» сломается ровно в момент наведения.
  assert.match(chrome, /data-split-divider-visual/);
  assert.match(chrome, /const paintDivider = /);
});

// ── Контур наведения против рамки фокуса ──────────────────────────────────

test('контур наведения читается рядом с рамкой окна в фокусе', () => {
  // Окна лежат вплотную и рисуют рамки ВНУТРЬ себя — на шве оказываются две
  // соседние пиксельные колонки, а не одна общая. Тусклый контур наведения рядом
  // с яркой рамкой фокуса не читался: человек наводит на соседнее окно и не
  // видит отклика с той стороны, откуда пришёл курсор. Слоями это не лечится —
  // ничто ничего не перекрывает; решает только яркость.
  const css = fs.readFileSync(path.join(here, '..', 'styles', 'globals.css'), 'utf8');
  assert.match(css, /inset 0 0 0 1px rgba\(255, 255, 255, 0\.42\)/);
  assert.match(chrome, /SPLIT_PANE_HOVER_RING = 'inset 0 0 0 1px rgba\(255,255,255,0\.42\)'/);
});

// ── Recovery status не блокирует окно модалкой ────────────────────────────

test('interrupted recovery проецируется через lifecycle-контрол без Continue overlay', () => {
  const surface = fs.readFileSync(path.join(here, '..', 'components', 'Workspace', 'SplitPaneSurface.tsx'), 'utf8');
  const area = fs.readFileSync(path.join(here, '..', 'components', 'Workspace', 'TerminalArea.tsx'), 'utf8');
  assert.match(surface, /const paneLifecycleStatus = useAgentLifecycle\(\{/);
  assert.match(surface, /lifecycleStatus=\{paneLifecycleStatus\}/);
  assert.doesNotMatch(surface, /InterruptedSessionOverlay|continueInterruptedSession/);
  assert.doesNotMatch(area, /InterruptedSessionOverlay|continueInterruptedSession|ПРОДОЛЖИТЬ СЕССИЮ/);
});
