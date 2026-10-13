import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.resolve(here, '../components/Workspace/PromptQueueOverlay.tsx'),
  'utf8',
);

test('collapsed queue count hover reuses the canonical interactive item list', () => {
  assert.match(source, /ref=\{queueCountButtonRef\}[\s\S]{0,700}onMouseEnter=\{openQueueHoverPreview\}/);
  assert.match(source, /\{\(panelOpen \|\| queueHoverPreviewVisible\) && \(/);
  assert.match(source, /data-prompt-queue-hover-preview/);
  assert.equal(
    (source.match(/data-prompt-queue-item-list/g) || []).length,
    1,
    'hover preview and expanded panel must share one canonical card list',
  );
  // Кнопки строк (replay/remove/триггеры) живут в том же каноническом списке,
  // который панель показывает и в превью — якорь по контейнеру списка, а не по
  // флагу превью: раньше здесь стоял guard «клик в превью игнорируется», но
  // клик по строке теперь открывает ту же боковую модалку и в превью.
  assert.match(source, /data-prompt-queue-item-list[\s\S]{0,12000}data-chip-action="replay"/);
  assert.match(source, /data-chip-action="remove"/);
  assert.match(source, /data-prompt-trigger-row=\{it\.id\}/);
  assert.ok(
    !/isMetaAction \|\| queueHoverPreviewVisible\) return;/.test(source),
    'клик по строке в ховер-превью снова заглушен — модалка из превью не откроется',
  );
  // Раньше здесь проверялась строка, в которой оба блока перечислялись как
  // «не закрывай окно, если курсор на них». Тот же смысл теперь живёт в
  // кластере наведения — см. следующий тест.
});

test('окно под курсором держится геометрией, а не задержкой', () => {
  // Задержка отвечает на вопрос «сколько ждать», хотя вопрос был «где курсор»:
  // она либо коротка для медленного движения, либо держит окно уже после ухода.
  assert.ok(
    !/queueHoverCloseTimerRef/.test(source),
    'таймер закрытия предпросмотра очереди вернулся',
  );
  assert.match(source, /pointInHoverCluster\(\{[\s\S]{0,400}hub: previewRect/);
  // Счётчик, панель и открытые из неё блоки входят в кластер. Соседние
  // кнопки rail явно исключены, даже если широкий gap-bridge их перекрывает.
  assert.match(source, /queueCountButtonRef\.current\?\.getBoundingClientRect\(\)/);
  assert.match(source, /pointInRect\(railRect, point\.clientX, point\.clientY, 0\)/);
  assert.match(source, /point\.clientX < countRect\.left \|\| point\.clientX > countRect\.right/);
  assert.doesNotMatch(source, /satellites:[\s\S]{0,100}railRef\.current\?\.getBoundingClientRect\(\)/);
  assert.match(source, /HOVER_CLUSTER_SELECTOR/);
  for (const marker of [
    'data-run-after-picker-menu',
    'data-prompt-queue-chip-menu',
    'data-prompt-queue-meta-actions',
  ]) {
    assert.ok(
      new RegExp(`HOVER_CLUSTER_SELECTOR[\\s\\S]{0,300}${marker}`).test(source),
      `${marker} должен входить в кластер наведения`,
    );
  }
});

test('закрытием предпросмотра владеет только обход по геометрии', () => {
  // `onMouseLeave` срабатывает на границе за миг до того, как обход успевает
  // сказать «курсор в зазоре» — вместе они дают мигание на каждом переходе.
  const previewPanel = source.slice(
    source.indexOf('data-prompt-queue-hover-preview'),
    source.indexOf('data-prompt-queue-hover-preview') + 600,
  );
  assert.ok(previewPanel.length > 0);
  assert.ok(
    !/onMouseLeave/.test(previewPanel),
    'панель предпросмотра снова закрывается по onMouseLeave',
  );
  assert.ok(
    !/scheduleQueueHoverPreviewClose/.test(source),
    'вернулось отложенное закрытие предпросмотра',
  );
});

test('global hover departure commits only an admitted native-event close synchronously', () => {
  const global = fs.readFileSync(path.resolve(here, '../components/Workspace/GlobalRunAfterControl.tsx'), 'utf8');
  const close = global.slice(global.indexOf('const closePanel ='), global.indexOf('const lastPositionWarningRef ='));
  const hover = global.slice(global.indexOf('const recheckPreviewHover ='), global.indexOf('const { start: startResizeGesture }'));
  assert.match(close, /if \(!beforeCloseRef\.current\(reason\)\) return false;/);
  assert.match(close, /if \(immediate\) flushSync\(\(\) => setMode\('hidden'\)\);/);
  assert.doesNotMatch(close + hover, /setTimeout|setInterval|requestAnimationFrame/);
  assert.match(hover, /recheckPreviewHover\(event, true\)/);
  assert.match(hover, /recheckPreviewHover\(null, true\)/);
  assert.match(hover, /hasOwnedClickPopup\(panelRef\.current\)/);
  // These calls can run inside React effects/child cleanup. Only native
  // departure is urgent; flushing an effect reentrantly is not safe.
  assert.match(hover, /recheckPreviewHover\(previewPointerRef\.current\);/);
  assert.doesNotMatch(hover, /recheckPreviewHoverRef\.current\(previewPointerRef\.current, true\)/);
});

test('клик по строке закрепляет только её редактор, не родительское hover-меню', () => {
  const hover = source.slice(source.indexOf('const recheckQueueHover ='), source.indexOf('// ─── drag-and-drop reorder'));
  assert.doesNotMatch(hover, /if \(editorOpen/);
  assert.match(hover, /el\.dataset\.runAfterHoverOwner === editorLockTokenRef\.current/);
  assert.doesNotMatch(source, /pinPanelForInteraction|PANEL_SLIDE_MS|panelOpening|panelClosing/);
  assert.doesNotMatch(source, /onPointerDownCapture/);
  assert.match(source, /const editorSurfaceVisible = panelOpen \|\| queueHoverPreviewVisible;/);
  assert.match(source, /\{editorSurfaceVisible && editorOpen && editorAnchor && createPortal\(/);
  // Outside click remains an editor exit; hover leave now is also an exit.
  const closeGuard = source.slice(source.indexOf('const prepareQueueClose ='), source.indexOf('const suppressChipReopen ='));
  assert.match(closeGuard, /commitEditor\(\);/);
  const closeHover = source.slice(source.indexOf('const closeQueueHoverPreview ='), source.indexOf('const recheckQueueHover ='));
  assert.match(closeHover, /if \(!prepareQueueClose\('outside'\)\) return;[\s\S]*setQueueHoverPreviewOpen\(false\);/);
  // Internal controls still work and do not count as an outside click.
  assert.match(source, /previewPanel\?\.contains\(target\)\) return;/);
  assert.match(source, /previewPanel && queueCountButtonRef\.current\?\.contains\(target\)/);
});

test('модалка редактора живёт в body, выше всех окон сплита', () => {
  // Внутри окна сплита position:fixed не спасает: обёртка окна создаёт свой
  // стековый контекст (zIndex:2), и DOM-позднее соседнее окно красится поверх.
  // Меню сообщений и контекстное меню уже в body — модалка и её превью тоже.
  const editorBlock = source.slice(
    source.indexOf('{editorSurfaceVisible && editorOpen && editorAnchor && createPortal('),
  );
  assert.ok(editorBlock.length > 0);
  const portalCloses = (source.match(/,\n        document\.body,\n      \)\}/g) || []).length;
  assert.ok(portalCloses >= 2, 'редактор и его превью должны закрываться порталом в document.body');
});
