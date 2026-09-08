import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '../../..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const history = read('src/renderer/components/Workspace/HistoryPanel.tsx');
const surface = read('src/renderer/components/Workspace/AIConversation/AIComposerSurface.tsx');

/**
 * Прикреплённые промпты живут НАД рамкой композера, а не внутри него.
 *
 * Договорённость дословно: «то, что касается прикреплённых промптов, их
 * по-хорошему перекреплять всё выше, тоже в позиции абсолют… перекреплять также
 * над рамкой». Причина не вкусовая: строка внутри рамки — слот фиксированной
 * высоты, чип с рамкой в него не влезает, и отданный туда чип рисовался ПОВЕРХ
 * набранного текста.
 *
 * Здесь закреплено и место, и то, что промпты не вернутся внутрь поверхности.
 */

test('промпты рисуются в слое над рамкой, а не внутри поверхности', () => {
  assert.match(history, /data-history-composer-prompt-band/);
  // Слой над рамкой отдаётся поверхности как overlay — единственный способ не
  // занять ни строки раскладки.
  assert.match(history, /overlay=\{historyComposerOverlay\}/);
  assert.match(
    history,
    /const historyComposerOverlay = \(\s*historyComposerFloatingStatus\s*\|\|\s*historyComposerPromptBand\s*\)/,
  );
  // И НЕ отдаются как chips: там они оказывались поверх поля ввода.
  assert.doesNotMatch(history, /chips=\{composerSurfaceChips\}/);
  assert.doesNotMatch(history, /const composerSurfaceChips/);
});

test('раскрытое тело промпта по-прежнему принадлежит поверхности', () => {
  // Область предпросмотра одна на промпты, вставки и картинки. Если чип рисуем
  // сами, а в список раскрываемых его не передать, клик по нему молча ничего не
  // сделает — предпросмотр не найдёт цель.
  assert.match(history, /composerPromptChipsForPreview/);
  const previewList = history.slice(
    history.indexOf('const composerInlineChipsForPreview'),
    history.indexOf('const basicStatusDescription'),
  );
  assert.match(previewList, /composerPromptChipsForPreview/);
  assert.match(history, /externalExpandableChips=\{composerInlineChipsForPreview\}/);
  assert.match(surface, /externalExpandableChips = \[\]/);
});

test('подъём полосы считается от шрифта, а не задан числом', () => {
  // Плашка состояния сидит верхом на рамке и растёт вместе с настройкой размера
  // шрифта. Фиксированные 8px (посчитанные для 13px) при 20px уже давали
  // наложение полосы промптов на плашку — измерено.
  assert.match(history, /const historyComposerStatusRise = \(transcriptFontSize: number\) =>/);
  assert.match(history, /Math\.ceil\(transcriptFontSize \* HISTORY_SERVICE_TEXT_RATIO \* 1\.35 \/ 2\)/);
  assert.match(history, /bottom: historyComposerStatusRise\(historyTranscriptFontSize\) \+ 3,/);
  assert.doesNotMatch(history, /HISTORY_COMPOSER_STATUS_HALF_HEIGHT/);
});

test('полоса не переносится на вторую строку', () => {
  // Перенос добавил бы вторую полосу, а scroll потребовал бы отдельного жеста
  // над input. Чипы вместо этого shrink'ятся внутри одной доступной ширины.
  const band = history.slice(
    history.indexOf('// Прикреплённые промпты — НИЖНЯЯ полоса'),
    history.indexOf('const historyComposerOverlay'),
  );
  assert.ok(band.length > 0);
  assert.match(band, /flexWrap: 'nowrap'/);
  assert.match(band, /overflowX: 'hidden'/);
  assert.match(history, /\[data-history-composer-prompt-band\] > \.cb-composer-chip,[\s\S]*flex: 0 1 auto;/);
  assert.match(history, /\[data-history-composer-prompt-band\] \.cb-composer-chip-label \{[\s\S]*text-overflow: ellipsis;/);
});

test('промпты и статус стоят на одной левой вертикали, но не в одном ряду', () => {
  // Обе полосы — подписи одной рамки, поэтому начинаются одинаково. И они
  // РАЗНЫЕ полосы: в одном ряду исчезновение статуса сдвигало бы промпты влево.
  // Оба маркера встречаются в файле дважды — сначала в CSS, потом в разметке.
  // Срез обязан начинаться от РАЗМЕТКИ, иначе он пустой и проверка проходит
  // вхолостую (именно так этот тест сначала и «упал» — и правильно).
  const status = history.slice(
    history.indexOf('const historyComposerFloatingStatus ='),
    history.indexOf('// Прикреплённые промпты — НИЖНЯЯ полоса'),
  );
  const band = history.slice(
    history.indexOf('// Прикреплённые промпты — НИЖНЯЯ полоса'),
    history.indexOf('const historyComposerOverlay'),
  );
  assert.ok(status.length > 0 && band.length > 0, 'оба среза непустые');
  assert.match(status, /left: 12,/);
  assert.match(band, /left: 12,/);
  // Статус сидит НА линии, полоса промптов — выше неё.
  assert.match(status, /bottom: 0,\s*\n\s*transform: 'translate\(0, 50%\)'/);
  assert.match(band, /bottom: historyComposerStatusRise/);
});

test('кнопки внутри чипа ужаты именно в полосе, а не везде', () => {
  // Чип на линии не тянет раскладку, но, распухнув, наедет на плашку. В обычной
  // строке те же кнопки должны остаться прежними.
  assert.match(history, /\[data-history-composer-prompt-band\] \.hp-composer-chip-action \{\s*\n\s*width: 14px;/);
  assert.match(history, /\.hp-composer-chip-action \{\s*\n\s*width: 18px;/);
});

test('чип в полосе непрозрачный: переписка под ним не просвечивает', () => {
  // Слой над рамкой сам по себе прозрачный, а под ним идёт переписка. Своего
  // фона у чипа 13% плотности — замерено, сквозь него проходило 87% того, что
  // под ним, и на светлой строке текста подпись чипа падала до контраста 1.28
  // (нечитаемо). С непрозрачной подложкой — 8.85.
  const rule = history.slice(
    history.indexOf('[data-history-composer-prompt-band] .cb-composer-chip {'),
    history.indexOf('[data-history-composer-prompt-band] .hp-composer-chip-action'),
  );
  assert.ok(rule.length > 0);

  // Подложка берётся от рамки ввода тем же токеном, что и плашка состояния
  // рядом: поменяется фон рамки — подложка поедет за ним, без второй правки.
  assert.match(rule, /background-color: var\(--cb-composer-bg, #0f0f0f\);/);
  assert.match(history, /background: 'var\(--cb-composer-bg, #0f0f0f\)'/,
    'плашка состояния обязана держать тот же токен — иначе две подложки разойдутся');

  // Свой цвет чипа ложится СВЕРХУ подложки, поэтому оттенок сохраняется.
  assert.match(rule, /background-image: linear-gradient\(\s*\n\s*var\(--cb-composer-chip-prompt-bg\),/);

  // Записи «два цвета через запятую» тут быть не может: в сокращённой записи
  // фона несколько слоёв — это только изображения, цвет допустим лишь
  // последним, и такую запись браузер отбрасывает ЦЕЛИКОМ. Поймано замером:
  // чип оставался прозрачным, хотя правило выглядело верным.
  assert.doesNotMatch(
    rule,
    /background:\s*\n\s*var\(--cb-composer-chip-prompt-bg\),/,
    'сокращённая запись с двумя цветами не применяется вовсе',
  );
});

test('средняя кнопка удаляет обычный prompt-chip над input', () => {
  const band = history.slice(
    history.indexOf('{composerPromptChips.map((chip) => ('),
    history.indexOf('{contextUpdates.map((update)'),
  );
  assert.match(band, /onAuxClick=\{\(event\) => \{/);
  assert.match(band, /event\.button !== 1/);
  assert.match(band, /discardComposerChip\(chip\.id\)/);
});
