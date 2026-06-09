# Fix: Notes-editor clipboard — Cmd+X/Cmd+C dead, AI-paste no-op, plain paste band-aided

## Симптомы
- В slideout-заметках (`TabNotesSlideout.tsx`) **Cmd+X не работает** — текст не вырезается и не удаляется (data-loss-shape: ни в буфере, ни удалён).
- **AI Paste** (`Cmd+/` → `📋 AI Paste` → `Cmd+V`) «не везёт» — вместо свёрнутого `^^`-блока с AI-заголовком вставляется обычный текст; индикатор `📋 AI Paste` не гаснет.
- Обычный **Cmd+V работает** (это и сбивало с толку — «paste же работает, почему остальное нет»).
- Раньше Ctrl+C/Ctrl+V вообще не работали; «какой-то фикс» частично починил **только** plain-paste.

## Три слоя (их нужно различать — у каждого свой фикс)

### Слой 1 — настоящий архитектурный баг: `navigator.clipboard` в Electron-renderer
Пакет `@gt-editor/markdown-editor` (`src/plugins/clipboard.ts`) реализовывал **весь** текстовый clipboard — `Mod-c` (copy), `Mod-x` (cut), `Mod-v` (paste), `Alt-Mod-v` (collapsed paste), `Shift-Mod-v` / AI-paste, image-probe ветку — **исключительно** через `navigator.clipboard.{readText,writeText,read}`. В этом Electron-renderer'е (нет нативного Edit-menu с `role:cut/copy/paste` через `setApplicationMenu`) эти API возвращают `''` / реджектятся / бросают — ровно анти-паттерн `CLAUDE.md::Не используй navigator.clipboard в renderer`. Следствие: copy/cut ничего не пишут, paste читает пусто.

**Cmd+X особенно коварен (data-loss shape):** удаление текста стояло **внутри** `navigator.clipboard.writeText(text).then(() => view.dispatch(delete))`. Когда `writeText` реджектится — `.then()` не выполняется, текст **ни скопирован, ни удалён**, в логе только `[Editor] Cut failed`. Любой «write-then-delete» через async-`.then()` на ненадёжном транспорте — потенциальная потеря данных. Фикс: захватить текст синхронно, write — fire-and-forget, `view.dispatch(delete)` — **безусловно в том же тике** (Electron `clipboard.writeText` синхронный).

### Слой 2 — capture-phase перехват глотал keymap-driven режимы
Прошлый «фикс» в хосте: `onKeyDownCapture` на корне slideout'а ловил **только** `Cmd+V` в **capture-фазе** (раньше, чем bubble-keymap CodeMirror), читал рабочий `electron.clipboard.readText()`, делал plain-insert + `preventDefault()` + `stopPropagation()`.

Почему это объясняет ровно наблюдаемое:
- **plain Cmd+V работал** — хост обходил сломанный keymap и использовал `electron.clipboard`;
- **AI-paste тихо деградировал в обычную вставку** — хост проглатывал событие **до** того, как keymap проверял модульный флаг `_waitingForAIPaste` (clipboard.ts) и роутил в `pasteAsCollapsedAI`. `cancelAIPasteIndicator()` (вызывается только внутри keymap) не срабатывал → индикатор висел, флаг оставался `true` и «отравлял» следующую вставку;
- **Cmd+X / Cmd+C / Shift-Mod-v / Alt-Mod-v не покрыты** хэндлером (он матчил только `KeyV`) → проваливались в сломанный-Слоем-1 keymap → молчаливый no-op.

Даже если убрать Слой 2, AI-paste всё равно бы падал: `pasteAsCollapsedAI` первым делом делал `navigator.clipboard.readText()` → пусто → ранний `return` до любого dispatch. Слой 1 латентен под Слоем 2.

### Слой 3 — устаревший собранный dist (ортогонален, но обязателен)
Бегущий артефакт `node_modules/@gt-editor/markdown-editor/dist/index.js` был от **17 мая**, исходник `clipboard.ts` — от **21 мая** (gt-editor собрал свой dist 28-го). `build:markdown` не перезапускался. Дискриминатор: `grep -c "Clipboard:Block" running-dist` = **0** (subtree-aware copy/cut добавлены в исходник, но отсутствовали в dist'е). **Пересборка сама по себе не чинит ничего** — и старый, и новый код одинаково ходят через мёртвый `navigator.clipboard`. Но без неё любая правка исходника — silent no-op. См. [`fix-vite-prebundle-cache.md`](fix-vite-prebundle-cache.md).

## Решение: инъекция ClipboardAdapter (DI-шов, как onImagePaste/onGenerateTitle)

Не патчить per-consumer в хосте (отвергнуто — см. ниже). Вместо этого редактор получает опциональный `clipboard?: ClipboardAdapter`, через который проходят **все** read/write пути; дефолт — `navigator.clipboard` (веб-портативность). Хост (Electron) инъектит адаптер на базе `window.require('electron').clipboard`.

**Интерфейс** (`gt-editor/packages/markdown-editor/src/plugins/clipboardAdapter.ts`, новый файл):
```ts
interface ClipboardAdapter {
  readText: () => Promise<string> | string
  writeText: (t: string) => Promise<void> | void
  readItems?: () => Promise<ClipboardItemLike[]>   // OPTIONAL
}
```
- `createClipboardKeymap` резолвит `const cb = config.clipboard ?? navigatorClipboardAdapter` **один раз** наверху (не per-call — иначе один забытый call-site ломает web-fallback). Все ~9 сайтов идут через `cb`; `pasteAsCollapsed`/`pasteAsCollapsedAI` принимают `cb` параметром.
- `readItems` **намеренно опционален**: Electron-хост его **омитит** → keymap-ветка image-probe (`if (!cb.readItems) → pasteTextOnly()`) уступает картинки нативному DOM-`paste` handler'у (`imagePaste.ts`, `event.clipboardData` — работает в Electron без permission). Две clipboard-механики сосуществовали и раньше — обе сохранены.
- `contextMenu.ts::copyToClipboard(text, cb?)` тоже через адаптер (тут была graceful `execCommand`-fallback, не баг — но single-source-of-truth).
- `Editor.tsx`: проп `clipboard` → `clipboardRef` (sync useEffect как у `onImagePasteRef`) → в `createClipboardKeymap` и `createContextMenuHandler`.

**Хост** (`TabNotesSlideout.tsx`): module-level `electronClipboardAdapter` (`readText`/`writeText` через `electron.clipboard`, `readItems` омитнут) → проп `clipboard={electronClipboardAdapter}`. Capture-band-aid (`handleSlideoutKeyDown` + `onKeyDownCapture`) **удалён** — keymap снова оживает, AI-paste/cut/copy получают реальный буфер.

## Что отвергли и почему (graveyard)
- **Host-only band-aid (расширить capture-перехват на KeyX/KeyC):** AI-paste/collapsed-paste/subtree-copy живут в module-scope пакета (`_waitingForAIPaste`, `pasteAsCollapsedAI`, `indentBlockRange`, fold-математика) и не экспортированы для хоста. Воспроизвести их в хосте = скопировать ~500 строк (`findBlock`, `foldedRanges`, indent-rebasing) → форк shape, удвоение bug-surface (`CLAUDE.md::не переизобретай — переиспользуй`). Годится только как аварийный stopgap.
- **Полная DOM-event миграция (весь clipboard на `copy`/`cut`/`paste` DOM-события):** AI/collapsed-режимы триггерятся из command-palette, у них **нет** соответствующего DOM-события. Единственное преимущество DOM-events (синхронный `event.clipboardData` без permission) уже используется для единственного кейса, которому нужны сырые байты — картинок (`imagePaste.ts`), и Option A его сохраняет.
- **setApplicationMenu с role:cut/copy/paste (чтобы оживить navigator.clipboard):** app-wide UX-изменение (появляется menu-bar, влияет на routing всех окон/клавиш), непредсказуемо взаимодействует с terminal/SDK-табами и context-popup'ами. Хрупкий косвенный фикс транспортной проблемы.
- **Rebuild-only:** необходимо-но-недостаточно (Слой 3 ≠ Слои 1/2).

## Риски (для регрессий)
- **External-sync echo:** clipboard-dispatch'и **обязаны** сохранять `userEvent: 'delete.cut'` / `'input.paste'` и **никогда** не помечаться `'external-sync'` — иначе `onChange` не выстрелит и `tab.notes` перестанет сохраняться (или вернётся ping-pong-краш `Position N out of range`). Единственный легит `external-sync` — prop-sync replaceAll. См. [`fix-codemirror-controlled-editor.md`](fix-codemirror-controlled-editor.md). Поверхность снижена: editable сейчас только slideout (FilePreview/TabPreviewPopover — readOnly).
- **`readItems` омитнут в Electron-адаптере** — image-paste идёт через DOM-handler. Если будущий хост-адаптер **добавит** `readItems` на базе `electron.clipboard.read`, две image-ветки могут конфликтовать. Держать `readItems` омитнутым в Electron.
- **Subtree copy/cut (`indentBlockRange`)** впервые становится функциональным в этом приложении (в stale-dist'е отсутствовал) — проверять явно.
- **Silent-prop:** новый editable-инстанс MarkdownEditor без пропа `clipboard` тихо упадёт обратно на сломанный navigator.clipboard, без ошибки в консоли. Документировано здесь.

## Build-последовательность (обязательна)
1. Правки в `gt-editor/packages/markdown-editor/src` (clipboardAdapter.ts + clipboard.ts + contextMenu.ts + Editor.tsx + barrel/index экспорты).
2. Правки хоста (`TabNotesSlideout.tsx`).
3. Из `custom-terminal`: `npm run build:markdown` (build → rsync dist → `rm -rf node_modules/.vite`). Очистка prebundle-кэша **встроена** в скрипт и обязательна.
4. **Верифицировать что dist доехал** (`CLAUDE.md::Success ≠ exit code`): `grep -c "Clipboard:Block" node_modules/.../dist/index.js` > 0 (в stale = 0), `grep -c navigatorClipboardAdapter` > 0.
5. Рестарт `npm run dev` (prebundled dep не подхватывается через HMR — только полный reload).
6. Smoke: plain Cmd+V / Cmd+C selection / Cmd+X (вырезает И удаляет) / AI Paste (свёрнутый блок, `onGenerateTitle` сработал, индикатор погас) / Alt-Mod-v / image-paste. После каждого — `tab.notes` персистится.

## Связанные файлы
- `gt-editor/packages/markdown-editor/src/plugins/clipboardAdapter.ts` (новый), `clipboard.ts`, `contextMenu.ts`, `Editor.tsx`, `plugins/index.ts`, `index.ts`.
- `src/renderer/components/Workspace/TabNotesSlideout.tsx` — `electronClipboardAdapter` + удалённый band-aid.
- [`fact-notes.md`](fact-notes.md) — секции «Manual Cmd+V» (заменена) и «AI Paste».
- [`fix-vite-prebundle-cache.md`](fix-vite-prebundle-cache.md), [`fix-codemirror-controlled-editor.md`](fix-codemirror-controlled-editor.md).
- Переносимый принцип — `methodology/переносимый-дизайн.md::Cross-package clipboard DI seam`.
