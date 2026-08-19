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
  assert.match(source, /ref=\{queueCountButtonRef\}[\s\S]{0,500}openQueueHoverPreview\(\)/);
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
  // Полоска кнопок и всё, что открыто ИЗ панели, входят в то же целое.
  assert.match(source, /railRef\.current\?\.getBoundingClientRect\(\)/);
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

test('клик по строке превью закрепляет модалку, и кластер закрывается только кликом снаружи', () => {
  // «Кликаю на строку — сбоку модалка; могу увести курсор куда угодно;
  // закрывается по клику в другом месте».
  // 1. Пока модалка открыта, геометрический обход курсора спит.
  assert.match(
    source,
    /if \(dragIdRef\.current\) return;[\s\S]{0,700}if \(editorOpen\) return;[\s\S]{0,700}queueHoverPreviewPanelRef/,
  );
  // 2. Модалка и её превью-сосед рендерятся и в свёрнутом режиме (из ховер-превью).
  assert.match(source, /const editorSurfaceVisible = \(!collapsed && !panelClosing\) \|\| queueHoverPreviewVisible;/);
  assert.match(source, /\{editorSurfaceVisible && editorOpen && editorAnchor && createPortal\(/);
  // 3. Клик снаружи гасит весь кластер: и модалку, и карточки превью.
  assert.match(source, /commitEditor\(\);[\s\S]{0,300}setQueueHoverPreviewOpen\(false\);/);
  // 4. Клики ВНУТРИ превью и полоски кнопок — не «снаружи».
  assert.match(source, /previewPanel\?\.contains\(target\)\) return;/);
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
