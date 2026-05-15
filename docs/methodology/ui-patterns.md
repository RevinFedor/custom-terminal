# UI patterns — переносимые приёмы UI-реализации

Реализационные паттерны для интерактивного UI: hover-зоны через Portal, виртуализация, GPU-анимации, координация панелей, race-fix через immediate state. Не привязано к custom-terminal — применимо в любом React/Web проекте.

**Граница с другими methodology-файлами:**
- `design.md` — **что и почему** видит пользователь (детерминизм клика, destructive ≠ status, layout reservation). UX-видение и философия.
- `react.md` — **как** Zustand/React-конструкции себя ведут (selectors, closures, oscillator). Чистые stack-level ловушки.
- `ui-patterns.md` (этот файл) — **готовые приёмы** для конкретных UI-задач (hover между триггером и порталом, длинные списки, race на init). Промежуточный слой: ниже философии, выше синтаксиса.

---

## Invisible Bridge: hover между триггером и Portal-окном

При hover-открытии Portal-окна (тултип, превью, dropdown) триггер и окно физически разорваны в DOM — Portal живёт в `document.body`. `relatedTarget` в `onMouseLeave` триггера показывает Portal-окно как «чужую» ветку → окно закрывается мгновенно, пользователь не успевает дойти курсором.

**Решение — Directional Closing (логический мостик):**
В `onMouseLeave` триггера проверяй направление движения мыши и положение окна. Если курсор движется **в сторону окна** — закрытие игнорируется, окно остаётся.

```tsx
const handleTriggerLeave = (e: React.MouseEvent) => {
  const rect = e.currentTarget.getBoundingClientRect();
  // окно слева от триггера → курсор уходит влево = в сторону окна
  if (e.clientX < rect.left) return; // не закрывать
  setOpen(false);
};
```

Положение окна (слева / справа / сверху / снизу) определяет, какое направление «дружественное».

**No-Scale Policy для триггеров:** триггер не должен иметь `transform: scale` при hover. Изменение размера меняет `getBoundingClientRect` → между «маленьким» и «большим» состоянием возникает миллисекундный gap, в котором курсор находится «вне» обоих → false-leave. Если нужен hover-эффект — менять `background`/`color`, не размер.

**Почему не таймеры:** `setTimeout(close, 200ms)` ломается от быстрых пользователей (закроется когда они уже взаимодействуют) и от медленных (300мс задержки на каждое окно складываются в раздражение). Direction-based закрытие срабатывает мгновенно для враждебных направлений и никогда — для дружественных.

**Почему не прозрачные `<div>`-мостики:** дополнительный DOM-узел, ловит клики «над» соседними элементами, конфликтует с `pointer-events: none` родителей. Логический мостик не добавляет узлов вообще.

---

## Cmd+Hover Settings Panel: реактивная видимость для модификатор-зависимых popup'ов

Когда popup открывается комбинацией «модификатор (Cmd/Alt/Ctrl) + hover», обычный `onMouseEnter → show` ломается на ключевом сценарии: курсор **уже на месте**, пользователь зажимает/отпускает Cmd. `onMouseEnter` не стреляет повторно → popup не появляется/не исчезает.

**Решение — derived state, не отдельный `useState` под видимость:**
```tsx
const [triggerHovered, setTriggerHovered] = useState(false);
const [panelHovered, setPanelHovered] = useState(false);
const isCmdPressed = useCmdKey(); // глобальный keyboard listener

// Видимость — derived. Пересчитывается каждый render.
const visible = (isCmdPressed && triggerHovered) || panelHovered;
```

`isCmdPressed` — глобальный listener в module-scope `Set<setter>` (не каждый Tooltip со своим хуком — иначе 100+ listener'ов на странице). При нажатии/отпускании Cmd React делает re-render всех подписчиков → `visible` пересчитывается → popup появляется/исчезает **без участия mouse events**.

**Логика входа в panel** — pinning через второй флаг:
- `panelHovered = true` при `onMouseEnter` panel'а → popup остаётся видимым **независимо от Cmd** (пользователь зашёл внутрь, отпустить Cmd теперь безопасно).
- `panelHovered = false` при `onMouseLeave` panel'а → полный сброс.

**Когда применять:** opt-in affordances, которые должны быть скрыты по умолчанию (`design.md::Opt-in affordances через модификатор-клавишу`). Cmd-hover говорит «продвинутый функционал, шум для базового пользователя».

**Связь с Invisible Bridge:** при выходе курсора из триггера в сторону panel'а используется directional closing (см. выше) — иначе popup закроется на gap'е между ними.

---

## Native virtualization vs JS libraries: правило 1000 элементов

Для списков с **высокой вариативностью высот** элементов (markdown с code blocks от 30px до 1000px, чат-сообщения, timeline entries) JS-библиотеки виртуализации (Virtuoso, react-window, virtua) дают **scroll jitter** — они угадывают высоту неотрендеренных элементов через `defaultItemHeight`, и при ре-измерении `scrollHeight` контейнера меняется, вызывая прыжок позиции.

**Решение для списков до ~1000 элементов — нативный CSS:**
```css
.list-container { overflow-y: auto; }
.list-item {
  content-visibility: auto;
  contain-intrinsic-size: auto 100px;
}
```

- **`content-visibility: auto`** — браузер пропускает layout/paint для элементов вне viewport. Аналог виртуализации на уровне движка.
- **`contain-intrinsic-size: auto 100px`** — `auto` заставляет браузер **запомнить реальную высоту** после первого рендера. Повторный скролл / re-mount использует кэш → jitter исчезает.
- **Scroll Anchoring** (встроен в Chromium) — компенсирует сдвиги сверху курсора пользователя на уровне композитора, всегда плавнее JS-решений.

**Когда JS-виртуализация всё-таки нужна:** 10k+ элементов, или работа с virtualized data source (lazy fetch по mid-scroll). Для типичных list views на 100-1000 элементов native выигрывает по стабильности, размеру бандла (минус ~20KB на библиотеку) и интерактивности (раскрытие/сворачивание элементов не ломает скролл).

**Граница правила:** если в списке элементы **гарантированно одной высоты** (table rows, virtualized grid) — любая библиотека работает корректно, разница только в производительности. Правило про jitter актуально только для вариативных высот.

---

## Compositor-thread animations: GPU-слой для индикаторов под Main Thread Block

При тяжёлой работе на Main Thread (React reconciliation 200+ элементов, JSON.parse мегабайтных файлов, blocking sync IPC) **все анимации замораживаются** — спиннеры останавливаются, hover не реагирует. UI выглядит «висящим», пользователь теряет доверие.

**Решение — некритичные анимации на compositor thread (GPU):**
```css
.spinner {
  will-change: transform;
  animation: spin 1s linear infinite;
}
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
```

`will-change: transform` создаёт отдельный compositing layer. Анимация `transform` обрабатывается GPU независимо от Main Thread — спиннер крутится 60fps даже когда JS блокирует поток на 2 секунды.

**Какие анимации выносить на GPU:**
- ✅ **Фоновые лоадеры** (спиннеры, progress, pulse) — пользователь хочет «приложение живо, работает».
- ✅ **Decorative animations** (subtle background gradients, particle effects) — не зависят от user input.
- ❌ **Интерактивные** (hover feedback, click ripples, accordion expand) — должны быть на Main Thread. Если они «зависают» — это честный сигнал что приложение тормозит, его нельзя маскировать.

**Принцип:** анимация на GPU создаёт **иллюзию параллельной работы**. Это допустимо для информирования («ещё грузится, не зависло»), не для интерактивности — иначе пользователь видит, как кнопка реагирует на клик через 2 секунды, и считает что глюк UI, не задержка.

---

## Immediate Injection: race-fix для async-create + state-read

Классическая race condition: код создаёт entity (вкладка, проект, документ), который должен сразу иметь некоторый state (sessionId, owner, defaults). Между `createEntity()` и `setEntityState()` — async-промежуток (init worker, PTY ready, network response). Consumer (UI-компонент через polling/effect) в этот промежуток видит entity без state и рендерит пустой/error экран.

**Симптом:** «прыжок» — после действия (Fork, Rollback, New Project) UI на 300-500мс показывает «Нет сессии», потом state появляется. Пользователь видит мигание.

**Решение — передавать state в options создания:**
```tsx
// Плохо: создаём пустой → ждём ready → инжектим state
createEntity().then(() => setState(initial));

// Хорошо: state передаётся в момент создания
createEntity({ initialState }); // entity создаётся уже со state
```

Pattern требует чтобы entity-конструктор принимал initial values и применял их **до** того как consumer успеет подписаться.

**Когда применять:** любая async-creation с предсказуемым initial state. Если state приходит из external source (API response), который ещё не получен — этот паттерн неприменим, нужен loading-state с явным «ожидание».

**Антипаттерн:** показывать `null`-state и надеяться что «пользователь не заметит за 200мс». Заметит — и не доверяет интерфейсу после первого глюка.

---

## Manual bounds check: hover-state не сбрасывается при click-outside backdrop

Сценарий: карточка с hover-эффектом (зелёный overlay, например), внутри открывается dropdown через backdrop `fixed inset-0`. Пользователь кликает в backdrop чтобы закрыть dropdown. Backdrop ловит click → закрывает dropdown. Но карточка **не получает** `onMouseLeave` — мышь технически осталась в её bounding rect (backdrop сверху, не «снаружи»). Hover-state карточки залипает в `true`.

**Решение — ручная проверка координат при backdrop-клике:**
```tsx
const handleBackdropClick = (e: React.MouseEvent) => {
  closeDropdown();
  if (!cardRef.current) return;
  const rect = cardRef.current.getBoundingClientRect();
  const outside =
    e.clientX < rect.left || e.clientX > rect.right ||
    e.clientY < rect.top || e.clientY > rect.bottom;
  if (outside) setHovered(false);
};
```

Если клик пришёлся вне границ карточки — синхронно сбрасываем `hovered`. Если внутри (пользователь кликнул в саму карточку через backdrop) — оставляем.

**Альтернатива — listener на `mouseleave` document:** работает, но шумный (срабатывает на любое движение к краю окна, не только на closing-кейс).

**Принцип:** когда backdrop технически «над» интерактивным элементом, браузер не генерирует mouse leave для элемента. Полагаться на естественные события нельзя — нужна явная reconciliation при закрытии overlay'а.

---

## Mutual panel exclusion: одна тяжёлая боковая панель за раз

Если в проекте есть две+ боковые панели, каждая из которых дорогая для рендера (список 200+ элементов, расширенная timeline, file tree с virtualization), и они расположены в одной зоне экрана — **открытие одной автоматически закрывает другую**.

**Зачем:**
- **Визуально:** две панели рядом превращают центральную рабочую область в узкую полоску — пользователь теряет фокус. Один компонент в зоне → монофокус, понятная ментальная модель.
- **Производительно:** обе панели подписаны на active state → одновременный mount даёт O(n²) ре-рендер при изменении.
- **Когнитивно:** пользователь редко нуждается в обоих контекстах одновременно. Choose-one — нативное поведение, не ограничение.

**Реализация:**
```tsx
const openPanelA = () => { setA(true); setB(false); };
const openPanelB = () => { setA(false); setB(true); };
```

Не пытайся сделать «обе открыты, но узкие» — пользователь не разберётся в двух кашах информации в узких колонках. Лучше явный toggle.

**Когда исключение:** если панели имеют **разный масштаб** (одна — узкий nav-rail 48px, вторая — content panel) и они дополняют друг друга, mutual exclusion вредит. Правило про **боковые панели одного класса**.

---

## State-driven async refresh: IPC event + 500ms delay для SQLite commit

Если Main-процесс пишет в SQLite и сразу шлёт IPC-событие renderer'у «обнови данные» — renderer может прочитать **до того как транзакция закоммитилась** на диск. Результат: запрос вернул старые данные, UI рендерит stale-state.

**Решение — задержка 500мс между IPC-сигналом и чтением:**
```tsx
ipcRenderer.on('data:changed', () => {
  setTimeout(() => loadData(), 500); // SQLite WAL commit window
});
```

500мс — эмпирический safe-margin для SQLite WAL mode commit на SSD. Для критичных кейсов (single source of truth) лучше передавать новые данные **в самом IPC-событии** (`data:changed` с payload), а не делать round-trip через диск.

**Антипаттерн:** polling каждые N секунд «на всякий случай». Поллинг создаёт постоянную нагрузку и всё равно имеет окно неконсистентности 0-N секунд. Event-driven с явным delay-buffer лучше во всех метриках.

---

## Silent automation cleanup: skipProcessCheck для programmatic close

Если есть UI-checkpoint (confirm dialog «у вас запущен процесс, точно закрыть?»), который защищает **пользовательский** случайный close — он же ломает **программный** close из автоматизации (post-task cleanup, batch operations).

**Решение — флаг `skipProcessCheck`/`silent` в close API:**
```tsx
// Пользовательское закрытие — confirm
closeTab(id);

// Программное закрытие — без диалога
closeTab(id, { skipProcessCheck: true });
```

**Принцип:** confirm нужен **только для случайных действий**. Намеренные действия (программные, или подтверждённые пользователем в первой стадии flow) не должны переподтверждаться. Flag-pattern даёт opt-in: API по умолчанию консервативное, автоматизация явно отказывается от защиты.

**Что считается «программным»:**
- Post-task cleanup (закрыть Gemini-таб после Update Docs).
- MCP tools от sub-agent'ов.
- Restore/rollback (сжигаем старые табы при rollback'е).
- Batch-операции (Close All в Project).

---

## startTransition для тяжёлых смен контекста

React 19 `startTransition` помечает обновление как **низкоприоритетное** — браузер продолжает обрабатывать клики, hover, анимации, пока тяжёлая reconciliation выполняется в фоне.

**Когда применять:** переключение между «тяжёлыми» представлениями, где новый view рендерит сотни DOM-узлов (открытие проекта с большим деревом терминалов, switch между Dashboard и workspace, route change в SPA).

```tsx
import { startTransition } from 'react';

const switchView = (newView: string) => {
  startTransition(() => {
    set({ activeView: newView });
  });
};
```

Без `startTransition` React успевает закончить тяжёлую работу и только потом обрабатывает следующий клик/hover. С ним — успевает реагировать на input в параллель, и пользователь видит «приложение живое», даже если новый view ещё не отрендерен полностью.

**Не применять для:** обычных state updates (показ модалки, переключение тогла, изменение поля формы). Это вносит лишнюю асинхронность и `useTransition`-логику без выгоды.

---

## Tiered debounce: задержка пропорциональна тяжести операции

Когда один пользовательский input запускает несколько операций разного веса (легкий highlight + средняя проверка + тяжёлая загрузка), **единый debounce не оптимален**: малый таймаут перегрузит тяжёлую операцию, большой таймаут сделает лёгкую медленной.

**Решение — отдельный debounce per операция, прогрессивный:**
```
Виртуальная подсветка (DOM в viewport)  →  100мс
Проверка состояния (сканирует весь буфер) →  500мс
Загрузка с диска + перестроение дерева  →  2000мс
```

Принцип: задержка пропорциональна **стоимости** операции + **частоте**, с которой её результат меняется. Лёгкие сигналы делают UI «живым» (быстрый отклик на скролл), тяжёлые — экономят CPU.

**Когда применять:** сложные view'ы с многими derived состояниями от одного источника (timeline с подсветкой/check'ами/preload, code editor с syntax/lint/typecheck, search с suggest/filter/full-results).

**Не применять для:** независимых операций, каждая со своим источником ввода. Tiered debounce — про **один input** → каскад операций разной тяжести.

---

## Связи

- **UX-философия** (детерминизм, destructive ≠ status, layout reservation) — `design.md`.
- **React/Zustand ловушки** (Portal click-outside, Zustand selectors, useCallback stale closure) — `react.md`.
- **Project-specific UI-факты** (брендирование Claude/Gemini, action-row layout) — `knowledge/fact-*.md`.
