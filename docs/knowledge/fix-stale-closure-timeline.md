# Fix: stale closure в auto-refresh обработчиках Timeline

## Симптом

`array.findIndex(x => x.id === knownId)` возвращает `-1`, хотя элемент существует в актуальном стейте — видно через `useStore.getState()` или React DevTools. Symptom-сосед — обработчик, обёрнутый в `useCallback`, читает «пустой» массив или «старую» сессию через 10+ секунд после монтирования, хотя данные за это время обновились через polling.

В Timeline это особенно болезненно потому что polling Claude JSONL идёт каждые 2 секунды, и async-обработчик (например, Edit-Range fetch в Gemini), запущенный в момент T, через 30 секунд должен сверить `sessionIdRef.current` с тем что было на момент запуска — иначе ответ применится к чужой сессии.

## Причина

Когда массив или состояние, читаемое из обработчика, обновляется в фоне (auto-refresh каждые 2с, polling, IPC events), а обработчик обёрнут в `useCallback([staleDeps])` — обработчик захватывает массив из старого рендера. К моменту вызова через несколько секунд этот массив пустой или указывает на устаревшую сессию.

`useCallback` не магия — он сохраняет ту самую функцию, которая была создана в момент когда зависимости в последний раз менялись. Все замыкания внутри неё ссылаются на values того рендера. Если deps array не содержит обновляемый массив (или содержит, но обработчик передан в неперезаписываемое место — IPC handler, `addEventListener`, ref) — закешированная функция не получит обновлённые данные.

## Решение: паттерн State + Ref

```tsx
const [value, setValue] = useState<T>(initial);
const valueRef = useRef<T>(initial);

// Установка — обновляем ОБА:
const update = (v: T) => { valueRef.current = v; setValue(v); };

// В async/задержанных обработчиках — читаем из ref:
if (valueRef.current === expectedSessionId) { ... }
```

`useState` нужен для React-рендеринга (компонент перерисуется при изменении). `useRef` нужен для чтения свежего значения из async-замыканий — `.current` всегда указывает на последнее присвоенное значение, независимо от того, в каком рендере захватывалось замыкание. Пара живёт синхронно через одну setter-функцию.

Дополнительно — не оборачивать в `useCallback` обработчики для не-мемоизированных детей (`<div>`, `<button>`). Пересоздание функции на каждый рендер не влияет на performance для них (React всё равно diff'ит DOM), зато избавляет от stale-closure головной боли. `useCallback` имеет смысл только когда: (а) child обёрнут в `React.memo`, (б) функция уходит в `useEffect`/`useMemo` deps array, (в) функция передаётся в IPC `.on()` / `addEventListener` где замыкание живёт долго.

## В custom-terminal

`Timeline.tsx::sessionIdRef` — `sessionIdRef.current` сравнивается с `expectedSessionId` после `await fetch()` к Gemini API в Edit-Range flow. Если за время запроса (5-30 секунд) юзер переключил таб, ref содержит **новую** сессию; сохраняем результат в `_savedEditRangeMap.set(expectedSessionId, ...)` для отложенного применения, а не пишем в чужую сессию. Без ref'а здесь был бы stale-замыкание на исходный `sessionId` и тихая запись compact summary в неправильный JSONL.

### Prompt Summary: новый session id + старые entries

Прод-аудит 2026-07 доказал не гипотетический, а массовый owner-race: 3 321 из 5 172 Codex summary rows были сохранены под session-key, в canonical UUID set которого их entry UUID не входил; затронуто 43 session keys. После tab-switch React уже видел новый `sessionId`, но локальный `entries` ещё был массивом предыдущей вкладки, и auto-generation закрепляла уже невалидную пару.

Исправление не отключает background generation. Timeline хранит entries в immutable owner-snapshot по `tab/tool/session/cwd`; при смене owner старый массив немедленно перестаёт быть видимым, а late result проверяет generation + canonical UUID set. Нельзя заменять эту проверку условием `entry.sessionId === currentSessionId`: один resume-файл легитимно содержит несколько session IDs, хотя parent chain цела.

Похожий шрам в `Terminal.tsx` (`Only fit if active (use ref to get current value, not stale closure)`), `TabBar.tsx` (`Get fresh tabs from workspace (avoid stale closure)`), `ClaudeSDK/ClaudeSDKTab.tsx` (`Refs to break stale-closure in handleComposerKeyDown`). Везде один паттерн.
