# Fact: Cmd+Tab DOM-refocus

Когда macOS поднимает Noted Terminal в frontmost через Cmd+Tab, Mission Control, dock-click или внешний `NSRunningApplication.activate` (как делает Voice Record `cgpaste --target`), Chromium **не восстанавливает DOM-focus** ни на один элемент. `document.activeElement === document.body`, `AXFocusedUIElement` возвращает `kAXErrorNoValue` (-25212). Симптом: следующий Cmd+V из source-app (Voice Record dictation overlay, clipboard manager, любой synthesised keyboard event) уходит «в никуда» — Chromium NSEvent monitor видит модификатор+keycode, но routing уходит в первый responder, которого нет.

Tab-switching **внутри** приложения работает потому что код активного компонента (Terminal.tsx mount, ClaudeSDKTab focusEffect) явно делает `.focus()` при смене tab. Window-level focus такого pre-existing хука не имел.

## Второй путь: NT уже frontmost, focus на кнопке/sidebar

Window-focus event покрывает только сценарий «окно только что подняли». Если NT всё время был frontmost (юзер кликнул на кнопку Stop диктовки, sidebar, voice-mic в ClaudeControlBar — потом сразу Alt+`), `BrowserWindow.on('focus')` не fires и refocus не выполняется. CGEvent Cmd+V прилетает в DOM-focus = `<button>` → нативный paste-handler no-op'ит → текст пропадает.

Симптом «то работает, то нет» зависит исключительно от того, на каком элементе стоял внутренний focus в момент Alt+`. Воспроизводится 100%: клик на кнопку → Alt+` → говорю → Alt+` → текст не вставился. Клик на терминал → то же самое → вставился.

Решается **window-level capture-phase keydown** в `App.tsx`: при Cmd+V (без модификаторов кроме Meta) проверяем `e.target.tagName` — если это INPUT/TEXTAREA/contentEditable, не трогаем (это легитимный target для paste — Settings field, search box). Иначе диспатчим тот же `nt:window-refocus-active` event синхронно ДО bubble-phase → xterm/SDKComposer успевает захватить focus за один тик до того как Chromium доставит paste в `<button>`.

```tsx
const handlePasteRefocus = (e: KeyboardEvent) => {
  if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
  if (e.code !== 'KeyV' && e.key !== 'v' && e.key !== 'V') return;
  const t = e.target as HTMLElement | null;
  if (t) {
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) return;
  }
  try { window.dispatchEvent(new CustomEvent('nt:window-refocus-active')); } catch {}
};
window.addEventListener('keydown', handlePasteRefocus, true); // capture
```

Capture-phase критичен: bubble-фаза запоздает — нативный paste-handler `<button>` отстреливает первым на bubble. Capture бежит сверху вниз ДО того, как событие достигнет target — за тот же `keydown` мы успеваем переснять focus, и когда браузер начнёт обрабатывать paste-семантику, активным элементом уже будет xterm/textarea.

## Симптомы для роутера

- После Cmd+Tab в Noted Terminal клавиатура не работает в активном табе, надо кликнуть в input/terminal явно
- Voice Record диктовка `[Paste:CG] ok=true focusedRole=AX-error--25212` но текст не появляется в NT (Cmd+V в окно без first responder)
- Paste из VR работает **только** если кликнуть на input перед hotkey, и не работает после Cmd+Tab в NT
- Paste из VR не работает после клика на кнопку (Stop / sidebar item / Voice-mic), но срабатывает если успеть кликнуть на терминал перед окончанием записи
- "То работает, то нет" зависимость paste от того, что юзер кликал последним внутри NT
- Tab-switch / project-switch внутри NT — фокус корректный, Cmd+V вставляет; только cross-app (Cmd+Tab) flow ломается
- В UI Inspector видно `document.activeElement === body` сразу после window focus

## Архитектура фикса

Два независимых триггера, единая шина:

```
[main]           mainWindow.on('focus')                            ← Cmd+Tab / dock / Mission Control
                      │ webContents.send('window:refocus-active')
                      ↓
[App.tsx]        ipcRenderer.on('window:refocus-active', ...) ───┐
                                                                  │
[App.tsx]        window.addEventListener('keydown', ..., true) ──┤  ← intra-window Cmd+V
                 if Cmd+V && target ∉ {INPUT,TEXTAREA,CE}         │
                                                                  │
                                                                  ↓
                          window.dispatchEvent('nt:window-refocus-active')
                                                                  ↓
[per-component]  window.addEventListener('nt:window-refocus-active', () => ref.focus())
```

**Почему через DOM CustomEvent, а не прямой вызов через store/registry?**

- **Слабая связность.** Terminal.tsx и SDKComposer не знают друг о друге, у каждого свой ref. App.tsx не знает что куда фокусить. Если завтра появится третий тип таба — он просто подписывается на тот же window event, ничего не меняя в App.tsx.
- **Per-component active check на месте.** Каждый компонент сам знает свой `active` / `effectiveActive` / `isVisible` флаг. Terminal.tsx: `if (!effectiveActive) return;`. SDKComposer mount только при visible SDK табе — флаг не нужен.
- **Альтернатива через terminalRegistry.focus(activeTabId)** требовала бы вытаскивать `getEffectiveTabId()` в App.tsx из Zustand, плюс ветвление по tabType (`commandType === 'sdk'` → fetch textareaRef откуда-то). Это coupling App.tsx со специфичной логикой каждого типа таба.

## Per-component implementation

`Terminal.tsx` (PTY/xterm):

```tsx
useEffect(() => {
  if (!effectiveActive) return;
  const onRefocus = () => {
    const term = terminalRegistry.get(tabId);
    if (term) { try { term.focus(); } catch {} }
  };
  window.addEventListener('nt:window-refocus-active', onRefocus);
  return () => window.removeEventListener('nt:window-refocus-active', onRefocus);
}, [tabId, effectiveActive]);
```

`effectiveActive` уже учитывает `active && projectCurrentView === 'terminal' && workspaceView === 'workspace'` — не сфокусит при просмотре Dashboard или Home.

`ClaudeSDKTab.tsx::SDKComposer` (textarea):

```tsx
useEffect(() => {
  const onRefocus = () => {
    const ta = composerTextareaRef.current;
    if (ta) { try { ta.focus({ preventScroll: true }); } catch {} }
  };
  window.addEventListener('nt:window-refocus-active', onRefocus);
  return () => window.removeEventListener('nt:window-refocus-active', onRefocus);
}, []);
```

SDKComposer **mount'ится только когда SDK tab визуально активен** (parent рендерит conditionally на основе active + view + expandedTaskId-not). Поэтому unconditional refocus безопасен — нет рисков «несколько SDK компонентов борются за focus». `preventScroll: true` важен — без него window-focus event сопровождается прыжком scroll-position'а messages-list к textarea, что для длинной сессии раздражает.

## Что НЕ нужно учитывать

- **Гонок не бывает.** Чем бы ни был активный таб, его компонент уже mounted к моменту window:focus (компонент жил до Cmd+Tab). Race window-focus / re-mount не возникает.
- **Refocus только при mount тоже работает «иногда»** — но только для PTY-табов (Terminal.tsx уже фокусит xterm при `active` mount). После Cmd+Tab компонент не re-mount'ится, mount-эффект не fires. Need explicit window-focus listener.
- **Не нужен setTimeout / requestAnimationFrame** — `mainWindow.on('focus')` fires когда window уже key, `webContents.send` synchronous в IPC, dispatchEvent synchronous, focus() synchronous. Любой задержки = visible click latency.

## Что лечится этим фиксом

| Источник activate | До фикса | После фикса |
|---|---|---|
| Cmd+Tab из любого app | DOM focus = body, Cmd+V no-op | Active tab сразу focused |
| Mission Control switch обратно в NT | то же | то же |
| Dock-click на NT иконку | то же | то же |
| `NSRunningApplication.activate(.activateIgnoringOtherApps)` из Voice Record `cgpaste` | то же | Voice Record paste теперь приземляется надёжно |
| Внутри-окна клик на кнопку → Alt+\` → диктовка → Cmd+V | DOM focus = `<button>`, paste no-op | Capture keydown переснимает focus на xterm/textarea до bubble → paste landed |
| Внутри-окна клик на input в Settings/search → диктовка → Cmd+V | Работало (paste в input) | Работает (capture skip'ит INPUT/TEXTAREA, focus не двигается) |
| Tab-switch внутри NT (TabBar click) | Работало (явный `.focus()` в mount/effect) | Работает (window-focus event тоже fires но это no-op — focus уже там где надо) |

## Code Map

- `src/main/main.js::createWindow` — `mainWindow.on('focus', ...)` + `[Window:Focus]` log marker. Один listener, идемпотентный.
- `src/renderer/App.tsx` — main ipcRenderer listener, преобразует IPC → DOM CustomEvent. Cleanup в return useEffect.
- `src/renderer/components/Workspace/Terminal.tsx` — listener после `activeRef sync` useEffect, deps `[tabId, effectiveActive]`.
- `src/renderer/components/Workspace/ClaudeSDK/ClaudeSDKTab.tsx::SDKComposer` — listener рядом с `composerTextareaRef`, deps `[]` (mount-only).

## Связанные системы

- **Voice Record paste flow** ([`fact-global-dictation.md`](fact-global-dictation.md)) — основной потребитель. Без этого фикса VR работал только когда юзер вручную кликал в NT input перед hotkey.
- **`fact-claude-sdk-tab.md::Focus + selection coordination в чате`** — отдельный flow для click-внутри-чата (mouseup recovery). Window focus ≠ in-tab click — два разных кода, не конфликтуют.
- **`methodology/переносимый-дизайн.md::Window focus event ≠ DOM focus`** — переносимый принцип для любого Electron-приложения на macOS.
