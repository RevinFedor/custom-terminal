# UI React Patterns

---

## 13. React Reconciliation Trap (Index Shift)

### Проблема
При переключении между Terminal и Home видом в проекте все терминалы внезапно уничтожались (`DISPOSE`) и создавались заново, хотя они находятся в разных ветках DOM.

### Причина
React выполняет реконсиляцию (сравнение) детей по их индексу, если не заданы ключи.
**В `Workspace.tsx` была структура:**
```tsx
<div className="flex flex-col">
  {currentView === 'home' && <ProjectHome />} // Элемент [0]
  <TabBar />      // Элемент [1] или [0]
  <TerminalArea /> // Элемент [2] или [1]
</div>
```
Когда `ProjectHome` (индекс [0]) появлялся или исчезал, у `TabBar` и `TerminalArea` **смещались индексы**. React видел, что на месте [0] теперь другой компонент, и уничтожал всё дерево ниже по каскаду.

### Решение
1.  **Stable Indexing:** Условные оверлеи должны рендериться **последними** в списке детей.
2.  **Absolute Positioning:** Использование `absolute inset-0` позволяет оверлею физически находиться в конце списка детей (не влияя на индексы соседей), но визуально перекрывать их.

---

## Portal + handleClickOutside = мгновенный сброс стейта

## Проблема
Кнопки внутри `TooltipPortal` (React Portal в `document.body`) при клике немедленно сбрасывают стейт, который они только что установили.

## Механизм бага
1. Компонент имеет `window.addEventListener('click', handleClickOutside)`.
2. `handleClickOutside` проверяет `containerRef.current.contains(e.target)`.
3. Кнопка "Начать копирование" рендерится через Portal → живёт в `document.body`, **вне** `containerRef`.
4. Клик по кнопке:
   - `onClick` → `setSelectionStartId("uuid-123")` ✅
   - Event bubbles to `window` → `handleClickOutside` → `contains()` = `false` → `setSelectionStartId(null)` ❌
5. Итог: стейт устанавливается и **мгновенно сбрасывается** в одном цикле.

## Решение
`e.stopPropagation()` на всех `onClick` кнопок внутри Portal:
```tsx
<button onClick={(e) => { e.stopPropagation(); startRangeSelection(entry); }}>
```

## Правило
Любая кнопка внутри Portal, которая меняет стейт родительского компонента, **обязана** вызывать `e.stopPropagation()`. Иначе `handleClickOutside` на `window` убьёт изменение.

---

## useCallback + Auto-Refresh = Stale Closure

## Проблема
В компоненте Timeline `entries` обновляется каждые 2 секунды (auto-refresh). Функция `handleEntryClick`, обёрнутая в `useCallback([tabId])`, захватывает `finishRangeSelection` из рендера, когда `tabId` последний раз менялся. `finishRangeSelection` в свою очередь захватывает `entries` из того же рендера.

Результат: при вызове `finishRangeSelection` через 10+ секунд после создания `handleEntryClick`, `entries` содержит устаревший массив (часто пустой `[]`). UUID не находятся → `findIndex` = `-1`.

## Симптомы
- `entries.findIndex(e => e.uuid === startId)` возвращает `-1`
- IPC вызов `claude:copy-range` возвращает `{ success: false }`
- Баг воспроизводится нестабильно (зависит от тайминга refresh)

## Решение
1. **Не оборачивать в `useCallback`** функции, которые читают часто меняющийся стейт (`entries`, `sessionId`). Для `<div>` элементов (не мемоизированных компонентов) пересоздание функции на каждый рендер не влияет на производительность.
2. **Использовать ref** для значений, которые нужны в обработчиках И в async-функциях: `selectionStartIdRef.current` вместо замыкания над `selectionStartId`.

## Pattern: State + Ref
```tsx
const [selectionStartId, setSelectionStartId] = useState<string | null>(null);
const selectionStartIdRef = useRef<string | null>(null);

// При установке — обновляем ОБА:
selectionStartIdRef.current = entry.uuid;
setSelectionStartId(entry.uuid);

// В обработчиках — читаем из ref (всегда актуальный):
if (selectionStartIdRef.current) { ... }
```

---

## Loop Closure Trap (Link Providers)

### Проблема
При регистрации провайдеров ссылок в xterm.js (например, для UUID), использование переменной итератора (match) внутри колбэка `activate()` приводит к тому, что все ссылки ссылаются на последнее найденное значение (или `null`).

**Ловушка:**
```javascript
let match;
while ((match = regex.exec(text)) !== null) {
  links.push({
    activate() { 
      // match здесь — это ссылка на переменную, которая 
      // станет null в конце цикла
      console.log(match[0]); 
    }
  });
}
```

### Решение
Захват значения во внутреннюю константу в теле цикла.
```javascript
let m;
while ((m = re.exec(text)) !== null) {
  const uuid = m[0]; // Создает новый скоуп для каждой итерации
  links.push({
    activate() { console.log(uuid); } // Замыкание на константу
  });
}
```

---

## Zustand: Primitive Selectors vs Array Instances (Infinite Loop Trap)

### Проблема
Использование селекторов, которые конструируют и возвращают новые массивы или объекты на каждый вызов, приводит к ошибке `Maximum update depth exceeded`.

**Пример ловушки:**
```tsx
const subAgentTabs = useWorkspaceStore((s) => {
  // ❌ ПЛОХО: Каждый раз возвращается новый экземпляр []
  return Array.from(s.tabs.values()).filter(t => t.parentId === id);
});
```
Zustand использует `Object.is` для сравнения результата селектора. Поскольку `[] !== []`, компонент считает, что стейт изменился, и инициирует ре-рендер, что снова вызывает селектор и так до бесконечности.

### Решение 1: Примитивные ключи (String Key Pattern)
Вместо возврата массива объектов, селектор возвращает строку-ключ, которая меняется только при реальном изменении состава данных.

```tsx
// ✅ ХОРОШО: Возвращает строку (примитив)
const subAgentKey = useWorkspaceStore((s) => {
  const tabs = getTabs(s);
  return tabs.map(t => `${t.id}:${t.status}`).join(',');
});

// Массив вычисляется через useMemo на основе ключа
const subAgentTabs = useMemo(() => {
  return deriveTabsFromKey(subAgentKey);
}, [subAgentKey]);
```

### Решение 2: useShallow
Использование хука `useShallow` для поверхностного сравнения массивов/объектов.
```tsx
import { useShallow } from 'zustand/react/shallow';

const subAgentTabIds = useWorkspaceStore(useShallow((s) => {
  // ✅ ХОРОШО: Массив пересоздается, но useShallow сравнивает элементы
  return s.tabs.filter(t => t.parentId === id).map(t => t.id);
}));
```

---

## Layering & Portals (stacking context, Layering Pattern, isCreatingRef lock)

## Проблема: "WebGL Canvas съедает мой интерфейс"
При использовании `xterm.js` (даже в режиме Canvas) и сложных UI-компонентов (модалки, кнопки поверх терминала), возникали две критические проблемы:
1. **Stacking Context:** Элементы с `position: fixed` и высоким `z-index` оказывались *под* терминалом или некорректно позиционировались из-за `transform` или `filter` у родительских контейнеров.
2. **Event Blocking:** Кнопки поверх терминала не реагировали на клики, либо клики проваливались "сквозь" них в терминал.

## Решение 1: React Portals
Для элементов, которые должны быть гарантированно поверх всего (FileExplorer, FilePreview), используется `createPortal`.

### Почему это помогло
Порталы рендерят компоненты напрямую в `document.body`, полностью игнорируя DOM-иерархию воркспейса. Это выводит их за пределы локальных контекстов наложения (Stacking Contexts), созданных Flex-контейнерами или анимациями.

```tsx
return createPortal(
  <motion.div style={{ position: 'fixed', zIndex: 99999 }}>
    {/* контент */}
  </motion.div>,
  document.body
);
```

## Решение 2: Layering Pattern (Слоеный пирог)
Для элементов внутри терминала (кнопка "Scroll to bottom", Restart Zone), где Portal не применим, используется паттерн соседних слоев.

### Структура (Terminal.tsx):
```tsx
<div className="absolute inset-0">
  {/* Слой 1: Тяжелый рендеринг терминала */}
  <div ref={terminalRef} className="terminal-instance absolute inset-0" />

  {/* Слой 2: Прозрачный UI слой поверх */}
  <div className="absolute inset-0 pointer-events-none z-10">
    {showScrollButton && (
      <button className="pointer-events-auto">↓</button>
    )}
  </div>
</div>
```

### Ключевые моменты:
- **`absolute inset-0`**: Вместо `relative w-full h-full`, чтобы избежать конфликтов с размерами `xterm.js`.
- **`pointer-events-none`** на контейнере слоя и **`pointer-events-auto`** на самих элементах (кнопках). Это позволяет кликать по кнопкам, но пропускать клики в терминал, если нажатие произошло в пустом месте слоя.
- **`zIndex`**: Явное указание `z-index` для UI-слоя заставляет браузер рисовать его после (поверх) холста терминала.

## Решение 3: Lock на инициализацию (isCreatingRef)
Чтобы избежать Race Condition при монтировании (когда React вызывает `useEffect` дважды или быстро переключает табы), введен флаг-замок `isCreatingRef`. Он гарантирует, что один и тот же DOM-узел не будет инициализирован терминалом дважды, что предотвращает краши отрисовки.

---

## Interactive Hover Zones / Invisible Bridge Pattern

## Проблема
При использовании **React Portals** (например, для тултипов или превью сообщений) всплывающий элемент рендерится в конце `<body>`, вне иерархии DOM триггера. Это делает невозможным использование `relatedTarget` в `onMouseLeave`, так как для браузера это абсолютно разные ветки.

**Следствие:** При попытке переместить курсор от "точки" (триггера) к "окну" (превью) оно мгновенно закрывается, так как между ними есть физический разрыв.

## Решение: Invisible Bridge
Для создания плавного перехода используется стратегия "Невидимого мостика":

1.  **Логический мостик (Directional Closing):** Вместо таймеров или дополнительных прозрачных слоёв используется проверка направления движения мыши в `onMouseLeave` триггера.
    - Если мышь ушла в сторону портала — игнорируем закрытие.
    - Если в любую другую сторону — закрываем мгновенно.
2.  **No Scale Policy:** Триггеры, открывающие сложные интерактивные зоны, не должны использовать `transform: scale` при hover. Изменение размеров элемента "на лету" меняет его `getBoundingClientRect`, что создаёт микро-разрывы между триггером и порталом.

### Преимущества
- **Чистый DOM:** Нет лишних прозрачных `div` слоёв, которые могут мешать кликам по другим элементам.
- **Точность:** Логика срабатывает мгновенно и не зависит от скорости движения мыши (в отличие от дебаунса).

## Примеры реализации
- `docs/knowledge/fact-timeline.md`: Превью сообщений.
- `src/renderer/components/Workspace/panels/ActionsPanel.tsx`: Меню настроек копирования (📋).

## Когда применять
Всегда, когда пользователю нужно взаимодействовать с контентом всплывающего окна, которое открывается по hover.
