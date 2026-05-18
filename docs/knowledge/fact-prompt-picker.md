# Feature: Prompt Picker (Opt+V)

## Intro
Двухколонный keyboard-first picker для вставки промпта в активный таб. Заменил native macOS `Menu.popup({positioningItem})` который раньше открывался на Cmd+E как нативное контекстное меню с пунктом *Insert Prompt*. Те же данные из SQLite (`prompts` + `prompt_groups`), но рендерится React-portal'ом в `document.body`. Открывается одним хоткеем — **Opt+V**. Раньше существовал alias **Cmd+E**, но 16.05.2026 слот переназначен на toggle Tab Notes Slideout (см. `fact-notes.md`); Opt+V остаётся единственным keyboard-входом в picker.

## Why not native menu
- Native menu **не настраивается визуально** — нельзя поменять шрифт, паддинги, скрыть фон.
- На Cmd+E переключение фокуса на пункт работает через `positioningItem` (placement относительно курсора), и на коротких окнах меню вылезало в неудобное место.
- Кастомный picker = одна React-компонента + один store-флаг (`promptPickerOpen`); не нужно дёргать `ipcMain → Menu.buildFromTemplate` на каждое открытие.

## Behavior

### Keyboard navigation (master-detail)
Левая колонка — flat-список групп + ungrouped промптов (сортировка по `position`, как в native menu). Правая — промпты выбранной группы.

- **↑ / ↓** — навигация по левой колонке (если фокус там) или по правой (если фокус на промптах группы).
- **→** на группе — вход в правую колонку, фокус на первом промпте.
- **←** на правой колонке — возврат фокуса на группу (правая остаётся видимой, но dim).
- **←** на левой колонке — закрытие picker'а (как Esc).
- **Enter** на ungrouped промпте — вставка + закрытие.
- **Enter** на группе с промптами — равнозначно `→`.
- **Enter** на промпте справа — вставка + закрытие.
- **Esc** — закрытие.

При входе фокус автоматически на первой строке, `pickerLevel='group'`. Mouse hover тоже двигает selection (left/right level переключается по hover-зоне).

### Layout reservation: правая панель не сжимает левую
Правая колонка имеет **слот фиксированной ширины** даже когда содержимое скрыто:

```tsx
<div style={{ width: RIGHT_W, flexShrink: 0 }}>
  {selectedLeftItem?.kind === 'group' && <div style={panelStyle}>…</div>}
</div>
```

Когда выделен ungrouped промпт — внутреннего `panelStyle`-блока нет, но wrapper держит ширину, и левая колонка не центрируется в overlay'е. Без этого при движении ↓ через смешанный список «группа → ungrouped промпт → группа» основное окно прыгало бы влево-вправо. Принцип переносимый — см. `methodology/design.md::Layout reservation`.

Для пустой группы (есть группа, нет промптов в ней) внутри слота показывается placeholder *«пусто»* — отдельное состояние от «не группа выбрана».

### Capture-phase listener: arrow keys в picker, не в xterm
Все keyboard-handler'ы picker'а навешены через `window.addEventListener('keydown', onKey, true)` (capture). До bubble phase, на которой работают xterm `attachCustomKeyEventHandler` и assistant-ui textarea. Иначе:
- Стрелочки `↑/↓` уходят в Claude TUI как навигация по history.
- `Enter` отправляет в PTY пустой `\r` (тогда как picker должен был вставить промпт).
- `Esc` закрывает только модалку assistant-ui (если она была видна), а picker остаётся.

После reading store-флага `promptPickerOpen=true` listener делает `e.preventDefault() + e.stopPropagation() + e.stopImmediatePropagation()` и не пускает событие дальше. Double-safety: оба xterm `attachCustomKeyEventHandler` в `Terminal.tsx` тоже проверяют `useUIStore.getState().promptPickerOpen` и возвращают `false` на arrow/Enter/Esc — если capture-flow по какой-то причине пропустит событие, xterm всё равно его не пошлёт в PTY. Принцип переносимый — см. `methodology/design.md::Global shortcut в capture phase`.

### Layout-agnostic шорткаты через `event.code`
Открытие picker'а: `e.altKey && e.code === 'KeyV'` (Opt+V). Не `e.key === 'v'` — на Mac Opt+V в QWERTY-layout это символ `√` (option layer), а в Cyrillic-layout — `М`. `e.code` указывает физическую клавишу, не глиф. Принцип переносимый — см. `methodology/design.md::Layout-agnostic shortcuts`. Cmd+E больше не открывает picker (см. Intro).

Стрелочки/Enter/Esc — non-printable, `e.key` для них одинаков везде, можно проверять по `key`.

## Settings: font + scale
Шрифт picker'а вынесен в Settings → Шрифты («Prompt picker», default 12, диапазон 9-20). Все размеры панелей и паддингов скейлятся пропорционально:
- `LEFT_W = max(140, fontSize * 15)` ≈ 180px на 12px шрифте
- `RIGHT_W = max(160, fontSize * 17)` ≈ 204px на 12px
- `ROW_PAD_Y = max(3, fontSize * 0.33)` ≈ 4px
- `ROW_PAD_X = max(6, fontSize * 0.66)` ≈ 8px

Стор: `useUIStore.promptPickerFontSize` / `setPromptPickerFontSize`. Persist в `localStorage('noted-terminal-prompt-picker-font-size')`. Слайдер рендерится тем же `<FontSizeSlider>` что и остальные шрифты UI в `SettingsModal.tsx`.

## Tab-type routing для вставки
Picker сам резолвит куда вставлять через `getEffectiveTabId()` (sub-agent aware) + `tab.tabType`:
- `claude-sdk` → `window.dispatchEvent(new CustomEvent('claude-sdk:composer-insert', { detail: { tabId, text } }))` — тот же event что использует right-click SDK menu.
- иначе (PTY: claude/gemini/bash) → `ipcRenderer.send('terminal:input', tabId, content)` + `ipcRenderer.invoke('terminal:paste', …)` для file_paths. Идентично существующему `cmd === 'insert-prompt'` handler'у в `App.tsx`.

## Backdrop отсутствует
Полупрозрачной подложки нет — только click-outside listener на `mousedown` capture phase (см. `App.tsx::onDown` для других overlay'ев — палитра, контекст-меню). Юзер прямо: *«оверлей быть тоже не должно»* — picker должен открываться поверх UI без визуального dimming.

## Anchor: курсор или fallback при выходе из окна
Picker появляется у курсора, если последний `mousemove` внутри Electron-окна был свежим (≤ 1500мс), иначе fallback на фиксированную позицию (по горизонтали по центру viewport'а, по вертикали на 22% от верха — выше геометрического центра, чтобы не конфликтовать со statusbar'ом снизу).

Почему именно так. Координаты курсора доступны рендереру только через `mousemove`, и это событие приходит **только пока курсор внутри окна** (Electron/Chromium не присылает координат вне `<window>`). Если юзер фокусирует приложение через `Cmd+Tab` или хоткей с курсором над другим монитором — последний `mousemove` устарел или вообще никогда не приходил с момента старта. Свежесть проверяется по timestamp'у: `Date.now() - lastMouseMove.t <= 1500`. Сам трекинг — singleton-listener на window (capture phase, чтобы не зависеть от того что под курсором).

Якорь решается **один раз** при открытии — picker не следует за курсором пока висит, иначе arrow-навигация ломает mental model «окно стоит, я в нём двигаюсь стрелочками». В cursor-режиме координаты — top-left picker'а со смещением `+4,+4` от позиции курсора (классическое context-menu offset, чтобы клик не попал внутрь picker'а).

После размещения координаты клемпятся в viewport: `left/top` уезжают внутрь если правый/нижний край вылез бы за `innerWidth/innerHeight - 8px`. Реальный размер picker'а измеряется через `useLayoutEffect` + `rootRef.current.offsetWidth/offsetHeight` после первого рендера — оценка по `LEFT_W + GAP + RIGHT_W` используется как fallback до того, как DOM смерил себя. Принцип переносимый — см. `methodology/design.md::Геометрия popup — от измерения, не от формулы`.

## Path-зависимости

| Файл | Что делает |
|---|---|
| `src/renderer/components/Workspace/PromptPickerOverlay.tsx` | Сам компонент. Mounted один раз в App.tsx. |
| `src/renderer/App.tsx::handlePickerOpenCapture` | Window keydown capture для Opt+V. |
| `src/renderer/store/useUIStore.ts` | `promptPickerOpen` / `setPromptPickerOpen`, `promptPickerFontSize` / `setPromptPickerFontSize`. |
| `src/renderer/components/Workspace/Terminal.tsx` (оба `attachCustomKeyEventHandler`) | Double-safety guard: блокирует Opt+V и navigation keys, когда picker open. |
| `src/renderer/components/UI/SettingsModal.tsx` | Слайдер «Prompt picker» в секции «Шрифты интерфейса». |

## Что НЕ удалили (умышленно)
- **Right-click context menu** на терминале/SDK — open'ится через `ipcMain.on('show-terminal-context-menu')` / `show-sdk-context-menu`. Native menu всё ещё нужен для правого клика, потому что macOS context-menu имеет правильный mouse-pointer-binding и кастомный picker мы туда не привязывали. Removed только клавиатурное открытие native menu (раньше — Cmd+E с `focusInsertPrompt:true`).
- **`focusInsertPrompt` параметр и `_insertPromptAnchor` маркер** в `main.js::show-*-context-menu` handler'ах — пока оставлены на случай, если решим вернуть keyboard-open native menu отдельным хоткеем.

## Что пробовали и не сработало
- **Capture-listener BEZ `stopImmediatePropagation`** — stopPropagation останавливает bubble, но не другие listeners на том же phase. Если bubble-listener xterm уже сам зарегистрирован на capture (что у xterm.js именно так), он получит событие. `stopImmediatePropagation` блокирует все остальные listeners на этом же event.
- **Listener в bubble phase на window** — xterm и assistant-ui textarea получают keydown первыми (они подписаны на nested DOM-элементы, по DOM-flow bubble идёт snizu вверх). Capture фaza идёт сверху вниз — window-handler срабатывает раньше.
- **Backdrop с `background: rgba(0,0,0,0.18)`** — был в первой версии, юзер потребовал убрать («оверлей быть тоже не должно»). Заменён на чистый click-outside.
- **`top: 50%` (по центру)** — picker конкурировал со statusbar'ом на коротких окнах; в fallback'е перешли на `top: 22%`, а в основном кейсе — к курсору.
- **Анкор по `clientX/clientY` глобального `MouseEvent` без свежести** — если юзер пришёл в окно через `Cmd+Tab`, последний mousemove мог быть полчаса назад над случайной точкой; picker открывался под мышью, которой там уже не было. Лекарство — timestamp + порог 1500мс, иначе fallback на статичную позицию.
- **Правая панель условным рендерингом без wrapper'а** — без зарезервированной обёртки левая колонка при `selectedLeftItem.kind === 'prompt'` центрировалась в overlay'е. Решение — обёртка с `flexShrink: 0` + `width: RIGHT_W` всегда в DOM, content внутри условный.
