# React / Zustand методология

Переносимые паттерны и ловушки React 19 + Zustand. Не привязано к custom-terminal: применимо в любом проекте на этом стеке. Project-specific примеры даются как иллюстрации со ссылкой на конкретные файлы — сами правила формулируются абстрактно.

---

## Reconciliation Trap: условный child меняет индексы соседей

React сравнивает детей по позиции, если у них нет стабильных ключей. Условный child (`{flag && <Foo />}`) при включении/выключении сдвигает индексы соседей — React видит «на месте [N] теперь другой компонент» и **уничтожает поддерево** (unmount + remount). Тяжёлые компоненты (xterm, WebGL canvas, video) теряют состояние и заново инициализируются.

**Симптомы:**
- Открытие overlay'а / sidebar'а ломает соседний компонент: терминал перерисовывается с нуля, canvas мигает, потеряны listener'ы.
- Поведение зависит от того, есть ли над компонентом условный child.

**Решение:**
- **Stable indexing** — условные children рендерятся **последними** среди соседей. Их появление/исчезновение не сдвигает индексы остальных.
- **Absolute positioning** — если overlay визуально должен быть «сверху», использовать `absolute inset-0` + z-index. Тогда он физически в конце списка детей, но визуально перекрывает их.
- Альтернатива — стабильные `key` пропы для всех children, но это требует помнить о ключах на каждом уровне.

---

## Portal + handleClickOutside = мгновенный сброс стейта

Кнопка внутри React Portal живёт в `document.body`, **вне** ref'а родительского компонента. Если родитель имеет `window.addEventListener('click', handleClickOutside)` с проверкой `containerRef.current.contains(e.target)` — клик по кнопке внутри Portal:
1. вызывает `onClick` → стейт устанавливается ✅
2. событие bubbles до `window` → `containerRef.contains(target)` = `false` → стейт сбрасывается ❌

В итоге стейт устанавливается и моментально сбрасывается в одном тике.

**Решение:** на всех `onClick` кнопок внутри Portal — `e.stopPropagation()`. Правило универсальное: любая интерактивная кнопка в Portal, меняющая родительский стейт, **обязана** останавливать bubbling, иначе global click-outside listener убьёт изменение.

Альтернатива (capture-on-parent) **не работает** — capture идёт сверху вниз и съедает событие до самой кнопки внутри Portal. Только `stopPropagation` на bubble-фазе.

---

## useCallback + auto-refresh = stale closure

Когда массив/состояние, читаемое из обработчика, обновляется в фоне (auto-refresh каждые 2с, polling), а обработчик обёрнут в `useCallback([staleDeps])` — обработчик захватывает массив из старого рендера. К моменту вызова через 10+ секунд массив пустой.

**Симптом:** `array.findIndex(x => x.id === knownId)` возвращает `-1`, хотя элемент существует в актуальном стейте.

**Решение — паттерн State + Ref:**
```tsx
const [value, setValue] = useState<T>(initial);
const valueRef = useRef<T>(initial);

// Установка — обновляем ОБА:
const update = (v: T) => { valueRef.current = v; setValue(v); };

// В async/задержанных обработчиках — читаем из ref:
if (valueRef.current === ...) { ... }
```

Дополнительно: **не оборачивать в `useCallback` обработчики для не-мемоизированных детей** (`<div>`, `<button>`). Пересоздание функции на каждый рендер не влияет на performance для них, зато избавляет от stale-closure головной боли.

---

## Deterministic oscillator: useEffect ↔ backend = бесконечное переключение

`useEffect([value])` вызывает IPC/API → backend возвращает новое значение → `setValue` → ре-рендер → effect снова запускается → backend по той же логике возвращает старое значение. Бесконечный цикл `A → B → A → B`.

**Симптомы:** session ID, tab ID, route — что-то «дрожит» между двумя значениями раз в 100-200мс, console замусорен повторными запросами.

**Решение — useRef memory о последней резолюции:**
```tsx
const lastResolved = useRef<{ from: T; to: T } | null>(null);

if (result.value !== current) {
  // Блокируем "отскок" обратно
  if (lastResolved.current?.from === result.value &&
      lastResolved.current?.to === current) {
    return;
  }
  lastResolved.current = { from: current, to: result.value };
  setValue(result.value);
}
```

Принцип: запоминать последнюю **пару** `from→to`. Если приходит ответ, который её разворачивает обратно — игнорировать. Циклы длиннее 2 встречаются редко; для них уже нужна полноценная reconciliation-логика на backend'е, а не клиентский workaround.

---

## Loop closure trap: переменная цикла в callback

Классическая JS-ловушка, актуальная при регистрации обработчиков в цикле (xterm.js link providers, IntersectionObserver per-item callbacks, и т.п.):

```js
let match;
while ((match = regex.exec(text)) !== null) {
  links.push({ activate() { console.log(match[0]); } });
  // match[0] здесь — ссылка на переменную, ставшую null в конце цикла
}
```

Все колбэки видят финальное значение `match` (null или последний match), не своё.

**Решение:** захват значения во **внутреннюю константу** в теле итерации:
```js
let m;
while ((m = re.exec(text)) !== null) {
  const captured = m[0]; // новый scope per итерация
  links.push({ activate() { console.log(captured); } });
}
```

`let`/`const` в блоке `while` создаёт новый binding на каждой итерации, `var` — не создаёт. Старый код с `var` или с прямым использованием `match` в колбэке — основной источник этой ошибки.

---

## Zustand: селектор, возвращающий массив/объект = бесконечный ре-рендер

Zustand использует `Object.is` для сравнения результата селектора. Любая операция, конструирующая новый массив/объект (`filter`, `map`, `Array.from`, `Object.values`), возвращает новый instance на каждый вызов → `Object.is` всегда `false` → компонент считает что стейт изменился → ре-рендер → селектор снова создаёт новый массив → ...

**Симптом:** `Maximum update depth exceeded`, профайлер показывает один и тот же компонент в бесконечном ре-рендер-петле.

**Три решения:**

**1. Primitive key (fingerprint).** Селектор возвращает строку, которая меняется только при реальном изменении состава:
```tsx
const fingerprint = useStore(s => s.items.map(i => `${i.id}:${i.status}`).join(','));
const items = useMemo(() => deriveItems(fingerprint), [fingerprint]);
```

**2. `useShallow`** (zustand/react/shallow) — поверхностное сравнение элементов:
```tsx
const ids = useStore(useShallow(s => s.items.filter(i => i.active).map(i => i.id)));
```

**3. Не подписываться на Map/Set целиком.** Если в сторе `Map`, обновление через `set({ map: new Map(get().map) })` создаёт **новую ссылку** — подписчики на весь Map ре-рендерятся при любом изменении любого ключа. Подписывайся только на нужные значения (`s => s.map.get(id)`) или на fingerprint состава ключей (`Array.from(s.map.keys()).join(',')`).

Project-specific: см. также CLAUDE.md anti-pattern «Zustand: Не подписывайся на Map целиком».

---

## Layering: Portal + pointer-events для UI поверх Canvas

Большие canvas-компоненты (xterm.js, WebGL, video) создают локальные **stacking context'ы** через `transform`/`filter`/`opacity` родителей, ломая `z-index` соседей. UI-элементы, которые должны быть «поверх» canvas, оказываются под ним или не получают клики.

**Два паттерна, в зависимости от расположения:**

**1. Полностью отдельный overlay → React Portal.** `createPortal` в `document.body` обходит локальные stacking context'ы целиком. Подходит для модалок, file pickers, screen-wide overlays.

**2. Overlay внутри родительского контейнера → Layering Pattern** (соседние слои):
```tsx
<div className="absolute inset-0">
  <div ref={canvasRef} className="absolute inset-0" />  {/* Слой 1: canvas */}
  <div className="absolute inset-0 pointer-events-none z-10">  {/* Слой 2: UI */}
    {showButton && <button className="pointer-events-auto">↓</button>}
  </div>
</div>
```

Ключевое:
- **`absolute inset-0`** на обоих слоях — избегает конфликтов размеров (canvas чувствителен к flex/grid sizing).
- **`pointer-events-none`** на UI-контейнере + **`pointer-events-auto`** на конкретных интерактивных элементах. Клики проходят сквозь пустые места к canvas, но кнопки кликабельны.
- **Явный `z-index`** на UI-слое — иначе порядок зависит от непредсказуемого DOM-order'а.

---

## Init lock: `isCreatingRef` против double-init в Strict Mode

React 18+ Strict Mode вызывает `useEffect(() => { init(); return cleanup; }, [])` **дважды** в dev. Если `init()` инициализирует что-то тяжёлое в shared-ресурсе (DOM-узел, WebGL контекст, WebSocket), а cleanup не успевает отрабатывать корректно — получаешь два инстанса в одном слоте.

**Симптом (dev only):** двойная инициализация терминала, дубликаты WebGL контекстов, два слушателя на одном сокете. В production не воспроизводится.

**Решение — ref-флаг как lock:**
```tsx
const isCreatingRef = useRef(false);
useEffect(() => {
  if (isCreatingRef.current) return;
  isCreatingRef.current = true;
  const instance = createHeavy();
  return () => {
    instance.dispose();
    isCreatingRef.current = false;
  };
}, []);
```

Не использовать `useState` для флага — `setState` асинхронен, второй `useEffect` уже стартует до того как state обновится. `useRef` мутирует синхронно.

---

## subscribe() vs useEffect для batched state transitions

React 18 batch'ит несколько `set()` из одного async-контекста в один render. `useEffect([value])` видит только финальное значение, **промежуточные пропускает**.

**Симптом:** async-функция делает `set({ loading: true })` → `await fetch()` → `set({ loading: false })`. Компонент с `useEffect([loading])` видит только `false → false`, не успевает реагировать на `true`.

**Решение:** `useStore.subscribe((state, prev) => { ... })` — синхронный callback на **каждом** `set()`, минует React render cycle. Ловит все промежуточные transitions, включая batched.

```tsx
useEffect(() => {
  const unsub = useStore.subscribe((state, prev) => {
    if (!prev.loading && state.loading) startSpinner();
    if (prev.loading && !state.loading) stopSpinner();
  });
  return unsub;
}, []);
```

Применять когда: нужна детекция перехода `A → B → C` через async, и состояние B критично (показать индикатор, запустить timer, etc). Для обычной derived-логики `useEffect` достаточно.

---

## Связи

- **Project-specific React/Zustand шрамы** — `knowledge/fix-zustand-silent-mutation.md`, `knowledge/fix-codemirror-controlled-editor.md`, `knowledge/fix-performance-lags.md`.
- **UX-паттерны** (Invisible Bridge, Immediate Injection, GPU-loaders) — `methodology/design.md`. Они опираются на технические решения отсюда, но описывают user-facing поведение.
