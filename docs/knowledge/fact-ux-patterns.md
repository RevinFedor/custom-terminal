# UX/UI факты — custom-terminal

Project-specific UI-решения, привязанные к конкретным компонентам (InfoPanel, ActionsPanel, TabBar, BookmarkCard) и брендингу (Claude/Gemini цвета). Переносимые принципы — в `docs/methodology/design.md` (раздел «UI implementation patterns») и `docs/methodology/design-bugs.md`.

---

## Брендирование движков: цветовое кодирование Claude/Gemini

- **Claude:** оранжевый `#DA7756`. Применяется в Timeline-точках, рамке `ActionsPanel`, статусных сообщениях, Stop-кнопке `Stop Claude`.
- **Gemini:** синий `#4E86F8`. Активируется автоматически при переключении на таб с Gemini-сессией.

### ActionsPanel адаптируется под движок
- **Скрытие Claude-only опций** для Gemini: переключатели «Include Reading», «Include Editing», «From Start» скрываются. Эти концепты завязаны на структуру JSONL Claude — Gemini-сессии устроены иначе.
- **Контекстные подписи**: подзаголовок меняется на `Claude JSONL → clipboard` или `Gemini JSON → clipboard`. Юзер видит формат источника без открытия dropdown'а.

### Командные кнопки (Status Styles)
Unified стиль для интерактивных команд (запуск, продолжение, экспорт):
- Тег `<code>`, фон `#1a1a1a` (глубокий чёрный), font `text-xs`.
- Hover: `underline`.
- Resume Button подстраивается под тип активной сессии — оранжевый текст для Claude, синий для Gemini. Визуальная преемственность без перегрузки цветами.

---

## Unified AI Launch: session-actions в ClaudeControlBar

Для минимизации кликов отказались от модального переключения между движками. Раньше split-button (`claude` | `gemini` запуск) жил в правой `InfoPanel`-сайдбаре — после удаления правой колонки lifecycle-affordance (`Continue` / `Stop` + fork в новый PTY/SDK-таб + copy session-id + force-refresh timeline) переехал в `ClaudeControlBar` под Terminal (см. `fact-claude-control-bar.md`).
- **Inline lifecycle**: триплет `[⎘ session-id | Continue/Stop | ↻ refresh]` всегда виден когда у активной вкладки есть AI-сессия. Visible одинаково для PTY и SDK табов.
- **Engine asymmetry**: `⑂→SDK` (fork в SDK-таб) появляется ТОЛЬКО для Claude — SDK не запускает Gemini. Copy-prompt split-pill (`⎘ prompt | + clear`) тоже Claude-only — Gemini CLI не отдаёт текущий input через IPC, аналога нет.

---

## Multi-select Persistence через `data-keep-selection`

### Проблема
При Shift+Click выделении нескольких вкладок любой клик в UI вне `TabBar` (например, в поле ввода промпта в `ActionsPanel`) сбрасывал выделение. Массовое обновление документации с кастомным промптом было невозможно — пока юзер кликал в textarea, выделение пропадало.

### Решение — exclusion attribute
В `TabBar.tsx` (обработчик `mousedown` на `document`) добавлена проверка атрибута `data-keep-selection`:
- На контейнеры `ActionsPanel` навешен этот атрибут.
- Если `e.target` или любой его родитель имеет `data-keep-selection` — `clearSelection` **игнорируется**.

Юзер может выделять табы и свободно взаимодействовать с инструментами в боковой панели, не теряя контекст выбора.

---

## Browser Tab Navigation: интерсепт Cmd+click и Refresh switches view

### Cmd+click внутри BrowserTab
В обычном терминале Cmd+click на ссылку открывает её в системном браузере ОС. Но внутри **BrowserTab** ожидание иное: если юзер запустил dev-сервер в этой же вкладке, он хочет увидеть результат рядом — клик на ссылку из логов должен открыть `localhost:5173` **в этой же вкладке**, а не в Safari.

`onLinkClick` callback в `Terminal` различает «внешние» (открываются в ОС) и «контекстные» (открываются внутри BrowserTab).

### Refresh button → view: 'browser'
Кнопка Refresh в BrowserTab принудительно вызывает `setBrowserActiveView(tabId, 'browser')` (даже если юзер сейчас смотрит на terminal-pane). Pattern «ожидаемого результата»: после ручного обновления страницы пользователь в 100% случаев хочет видеть UI, а не терминал, где он только что перезапустил сервер.

---

## Toast Layout & Copy Persistence (API Results)

Стандарт (с 2026-03) для отображения результатов API-запросов в Toast уведомлениях.

### Layout
```
[✕] [Icon] [Message] [copy]
```

- **Кнопка закрытия** (✕): слева (раньше была справа).
- **Иконка**: визуальный тип (успех / ошибка / info).
- **Сообщение**: основной текст результата API.
- **Кнопка copy**: справа. Повторное копирование результата без засорения основного буфера обмена случайным копированием другого текста.

### Action toast (clickable navigation)
Тип `'pink'` — розовый фон для фоновых процессов (edit-range Gemini fetch). Поддерживает `actionLabel` (кликабельный подчёркнутый текст после message) + `onAction` callback. Используется для навигации: `"Rewind готов — [имя вкладки]"` → клик переключает на вкладку (включая кросс-проект через `showWorkspace` + `switchTab`). Toast закрывается при клике на actionLabel.

### Motivation
Toast автоматически исчезает через 8 сек, но результат остаётся в памяти Toast-компонента — copy доступен пока Toast виден.

---

## Interrupted Overlay Persistence (`overlayDismissed`)

### Проблема
Приложение помечает активные сессии `wasInterrupted = true` перед закрытием (`beforeunload`), чтобы предложить восстановление при следующем запуске. Если юзер закрывал overlay вручную (Escape / клик) и обновлял страницу — overlay появлялся снова. `beforeunload` срабатывал повторно и видел, что сессия всё ещё привязана к табу.

### Решение — флаг «осознанного закрытия»
1. **В Tab (SQLite)** добавлена колонка `overlay_dismissed` (0/1).
2. **В UI** при закрытии overlay вызывается `dismissInterruptedSession()` → `overlayDismissed = true`.
3. **При закрытии приложения** `markAllSessionsInterrupted()` проверяет `if (hasSession && !overlayDismissed)`.
4. **Сброс флагов** `wasInterrupted` и `overlayDismissed`:
   - При нажатии «Continue».
   - При полной очистке сессии таба.
   - **При запуске НОВОЙ AI-сессии** (`setClaudeSessionId`/`setGeminiSessionId`) — гарантирует, что overlay покажется снова, если новая сессия будет прервана.

### Жизненный цикл

```
Запуск Claude/Gemini → wasInterrupted=false, overlayDismissed=false
  ↓
beforeunload → if (hasSession && !overlayDismissed) → wasInterrupted=true
  ↓
Следующий запуск → if (wasInterrupted && sessionId) → показать overlay
  ↓
Continue            ИЛИ           Закрыть overlay
→ claude --resume                  → overlayDismissed=true
→ wasInterrupted=false             → overlay не появится снова
                                     (пока не запустит НОВУЮ сессию)
```

Юзер видит overlay только один раз. Если закрыл — выбор сохраняется. Но запуск **новой** AI-сессии сбрасывает флаги, и цикл начинается заново.

---

## Global Terminal Selection Sync (`terminalSelection`)

### Проблема
Компоненты (GeminiPanel, поиск в табах) не могли получить выделенный в терминале текст без прямого доступа к инстансу `xterm.js`. Кнопки поиска не знали, когда текст выделен, и не могли быть `disabled`.

### Решение
Глобальный стейт `terminalSelection` в `useUIStore`:
1. **Terminal.tsx** слушает `onSelectionChange` и обновляет глобальный стейт.
2. **Context menu** принудительно вызывает `getSelection()` перед открытием меню.
3. **UI**: кнопки поиска используют `terminalSelection` для `disabled` и счётчика символов.

См. также: `fact-terminal-core.md`.

---

## Compact paths + instant tooltips + path validation (Dashboard polish)

Группа мелких UX-улучшений для Dashboard и Project Edit, дающих ощущение «продуманности».

### 1. Компактные пути
Чтобы не забивать интерфейс длинными `/Users/fedor/Projects/Web/my-app`, в карточке проекта показываются только **последние две** директории. Реализация: `parts.slice(-2).join('/')`.

### 2. Мгновенные тултипы
Сокращённый путь может быть неоднозначен — при наведении на путь в `ProjectCard` полный адрес всплывает **без задержки** (через стандартный `title` + кастомный `Tooltip` компонент для консистентности).

### 3. Живая валидация путей (Edit Modal)
IPC-хендлер `project:validate-path` использует `fs.existsSync`. UI: ✅ при валидном пути, ⚠️ если папка не найдена. Юзер ловит typo до сохранения.

### 4. Prepare-before-show
Для устранения «эффекта белого экрана» при создании/переключении проекта:
1. Система генерирует ID и создаёт записи в БД.
2. Инициализирует PTY-сессии.
3. Дожидается готовности рендерера терминала.
4. Только после этого убирает `RestoreLoader` и показывает проект.

Без этого юзер видит мигание пустого workspace перед загрузкой содержимого. Принцип: см. `methodology/design.md::Immediate Injection`.

---

## Floating Panels Alignment (Anchored CSS Transforms)

### Проблема — хрупкость JS-расчётов при динамическом контенте
Изначально панели «Параметры» / «Настройки» позиционировались через расчёт `left: blockRect.left - panelWidth`. Если контент панели менялся (длинный текст перевода, layout shift) — `panelWidth` переставал соответствовать реальности, панель наезжала на блок или улетала. При Portal'е возникали микро-задержки между получением координат и отрисовкой → визуальное «дёрганье».

### Решение — anchored CSS transforms
Вместо расчёта координат для левого края панели, **левый край ставится в точку начала блока, а сама панель сдвигается на свою полную ширину через CSS**:

```tsx
style={{
  position: 'fixed',
  left: blockRect.left - 3,           // привязка с небольшим gap
  top: blockRect.top + blockRect.height / 2,
  transform: 'translate(-100%, -50%)', // -100%X = вся ширина панели, -50%Y = центр
}}
```

- `-100%` (X) — сдвигает панель влево ровно на её текущую ширину. Правый край панели всегда оказывается **точно** в точке привязки, независимо от content size.
- `-50%` (Y) — идеально центрирует вертикально.

**Логический bridge вместо физических `<div>`-мостиков**: отказались от прозрачных div'ов в пользу проверки в `onMouseLeave` (если мышь идёт влево, к панели → не закрывать). DOM чище, позиционирование независимо от размеров мостика. См. `methodology/design.md::Invisible Bridge`.

### Применение
- `ActionsPanel.tsx`: ⚙ API Settings, 📋 Copy Settings.
- `useCmdHoverPopover` хук в `TabBar.tsx`, `ProjectHome.tsx`, `Dashboard.tsx` — обобщённая версия для list items.

---

## Связи

- **Переносимые UI-паттерны** (Invisible Bridge, Virtualization, Mirror Editing, Home-toggle, Scroll-to-bottom): `docs/methodology/design.md` + `docs/methodology/design.md` (раздел «UI implementation patterns»).
- **React/Zustand технические паттерны**: распределены по `fix-*` файлам по симптомам — Zustand selector loops и Reconciliation Trap в `knowledge/fix-performance-lags.md`, Portal click-outside и Layering поверх canvas в `methodology/design-bugs.md`, stale closure в `knowledge/fix-stale-closure-timeline.md`, inline-компонент trusted click в `knowledge/fix-inline-компонент-click.md`.
- **Конкретный CodeMirror controlled-editor шрам**: `knowledge/fix-codemirror-controlled-editor.md`.
- **Performance работы по Zustand Map**: `knowledge/fix-performance-lags.md`.
