# Fix: SDK tab freeze — virtualization on display:none tabs

## Симптомы

- Cold start с 3+ открытыми SDK-табами замораживает app на 10+ секунд (видимый chrome/menu откликается, content blank).
- Клик по неактивному SDK-табу даёт 1-2 секунды paused-state перед тем как content прорисуется.
- Глобальный `RestoreLoader` (`Restoring sessions...`) исчезает раньше чем SDK-табы реально показывают контент — юзер видит пустые шапки, потом через 200-500мс прилетает история.
- На active-табе после рефреша Anchor сразу прыгает в самый низ; вертикальный скролл вверх не работает (контент будто магнитом тянет к низу).
- В логах при попытке скролла — сотни строк `[ClaudeSDKTab:RENDER]` за один тик, callstack из `flushSync` внутри Virtuoso.
- ErrorBoundary: `tapClientLookup: Index 0 out of bounds (length: 0)` стек идёт из `MessageByIndexProvider` → `useExternalStoreRuntime`.
- TDZ runtime error `Cannot access 'filteredMessages' before initialization` в Timeline scroll-handler.

## Что было невидимо

`display:none` на скрытых табах **не** останавливает React reconciliation. При monoflood `setMessages([744 items])` парент-компонент пересобирает всё дерево независимо от visibility — для 3 табов × 744 message-trees это 12.8 секунд блокировки main thread на cold start, 1.5 секунды на каждое раскрытие `display:none → flex`. Lazy-mount табов не помогает: реальный bottleneck — размер дерева, не его видимость. См. `methodology/переносимый-дизайн.md::Виртуализация vs display:none`.

Замер из live-сессии (deterministic logs `[SDKVisibility]` + `[SDKMsgRender]`): `setMessages` (T0) → первый `MessageRender` (T0+12 887мс) на cold start; для tab-switch через display:none — 1 511мс reconcile + 157мс paint.

## Решение

`react-virtuoso` 4.18.7 (уже был в проекте через mobile-web). Замена `ThreadPrimitive.Messages` на отдельный компонент `VirtualizedMessages` который владеет Virtuoso-инстансом и рендерит каждый item через `MessageByIndexProvider` из `@assistant-ui/core/react` — это публичная API которой пользуется assistant-ui внутри `ThreadPrimitive.Messages`, drop-in replacement. Рендер ограничен видимым окном (~30 нод) независимо от длины data — hidden tab платит fixed cost, активный — не блокирует main thread.

Лоадер `RestoreLoader` дополнительно держится пока pre-fetch SDK-history заканчивается — см. `fact-claude-sdk-tab.md::History prefetch in restoreSession`. Без этого юзер увидит «Restoring sessions» → blank → реальный контент с задержкой 300мс.

## Graveyard

**`customScrollParent={parentRef.current}` + Virtuoso внутри overflow-y-auto родителя.** Хотелось чтобы родительский div оставался scroll-источником (он уже rendered ThreadPrimitive.Viewport), а Virtuoso только показывал windowed range. Результат: бесконечный цикл `flushSync(updateRange)` → parent re-render → ResizeObserver на items → следующий flushSync. В логах сотни render'ов за тик, скролл стопорится. Принцип в `methodology/переносимый-дизайн.md::Single source of scrolling`. **Не возвращаться** — это структурное ограничение react-virtuoso, не bug; виртуализатор должен владеть скроллом единолично.

**Manual auto-scroll-on-messages useEffect (`scrollTop = scrollHeight` при изменении `messages`).** Боролся с Virtuoso owned-scroll: каждое прибытие чанка дёргало scrollTop в низ, Virtuoso тут же перерасчитывал — content прыгал. Удалён, заменён на `followOutput="auto"` + `initialTopMostItemIndex={length-1}` + `atBottomStateChange` callback для tracking «юзер сейчас внизу или нет».

**Naive `totalCount={filteredMessages.length}` напрямую из родительского state.** На первом рендере `useExternalStoreRuntime` ещё не успел залить store — длина props=744, длина store=0, Virtuoso вызвал `MessageByIndexProvider(index=0)` → store.tapClientLookup throws `Index out of bounds`. Решение: новый `VirtualizedMessages` читает длину через `useAuiState((s) => s.thread.messages.length)` — lock-step с тем же store что использует `MessageByIndexProvider`. Render skipped пока store пустой; как только sync произошёл, Virtuoso монтируется с уже корректной длиной.

**`messagesRef.current = filteredMessages` (синхронно при render) для Timeline scroll-to-entry handler.** TDZ — `filteredMessages` объявлена ниже по файлу. Замена на `messagesRef.current = messages` (raw, без filter) — для `findIndex(m => m.text?.includes(snippet))` filter не критичен (он только пустые assistant выкидывает, а они и так не матчатся по тексту).

**Skeleton-overlay для окна mount→first-paint.** После того как core-фриз вылечен виртуализацией, остался косметический пробел: при первом открытии тяжёлого таба (744 msgs) на 100-500мс видна серая пустота между моментом когда Virtuoso смонтирована и моментом когда markdown первых ~30 items нарисован. Попробовали три подхода чтобы закрыть пробел плейсхолдер-«пузырями»:

1. **`historyPhase: 'idle' | 'loading' | 'done'` state + tri-state branch в `ThreadPrimitive.Empty`** — `setHistoryPhase('loading')` перед `loadHistory`, `.finally(() => setHistoryPhase('done'))`. С warm-cache (CACHE_HIT за 0мс по логам) React батчит оба setState в один tick — кадр с `loading` никогда не commit'ится, юзер видит сразу `done`.
2. **Безусловный skeleton когда `hasBeenVisibleRef.current === false && messages.length > 0`** — закрывает «restore done, юзер ещё не кликнул таб» промежуток. Тоже не отображается: между моментом когда `messages` появились в state и моментом когда юзер реально кликает таб может пройти секунды, но в момент клика `hasBeenVisibleRef` ставится в `true` в том же tick где `display:flex` срабатывает — снова batching съедает кадр skeleton'а.
3. **Overlay div поверх Virtuoso (`position:absolute inset-0`) с `virtuosoReady` флагом, флипаемым через `itemsRendered` callback Virtuoso.** Идея: skeleton живёт **поверх** Virtuoso всё время пока `itemsRendered` не отрапортует первое placement. Не помогло — юзер по-прежнему репортит «серый фон полсекунды, скелетона не вижу».

Гипотезы почему overlay не виден: либо React не успевает commit-нуть `virtuosoReady=false` состояние в первом кадре (mount сразу со state `false` → setState `true` в effect cycle того же tick → один visible render с `true`), либо overlay перекрывается paint-цепочкой Virtuoso (`absolute inset-0` рисуется одновременно с items, browser показывает items раньше background-fill overlay'а). Дальше не копали — пробел ≤500мс не критичен, базовый фриз 12.8с уже вылечен.

Отброшены: tri-state hook, overlay div, `virtuosoReady` state, `onFirstRender`/`itemsRendered`-callback bridge, компонент `SDKChatSkeleton`. Empty-state остался single-flavor («Type a message to start»). См. соответствующую секцию в `methodology/переносимый-дизайн.md::Skeleton ≠ emptystate во время загрузки` — принцип верный, но реализация на assistant-ui + Virtuoso стеком из коробки не вышла; следующая попытка должна стартовать с измерения **где именно** теряется кадр с skeleton (React DevTools Profiler на запись tab-switch + поиск reconciliation gap'а), не с очередного варианта компоновки.

## Heavy-tab + случайный Cmd+C → renderer freeze 60-100с

Эпизод 10:36-10:39 МСК: юзер открыл sdk-mobile (recordMap=3940, activeBranch=3878 — самый тяжёлый таб в проекте на этот день), несколько раз попереключал табы туда-обратно (`Perf:TabSwitch durMs 60-280ms`, всё в норме), нажал `Cmd+C`, и renderer замолчал на **94 секунды** (последний `[R]`-лог 07:36:58.288, следующий 07:38:32.188; в этом окне есть только два `[R]` события за всё время, оба на самом краю). Main process всё время работал нормально — `[Timeline:Backtrace]` шёл каждые 2 секунды без пропусков, ~47 итераций в этом окне. Это **только renderer-фриз**, не глобальный блокировщик.

Сигнатура для опознания в логах:
- Последний осмысленный renderer-event перед тишиной — `[Hotkey] Cmd + KeyC`.
- `[Timeline:Backtrace] recordMap.size > 3000` для активной сессии — таб тяжёлый, цена операции зависит от размера DOM.
- В окне тишины: `[Timeline:Backtrace]` от main продолжается, но никаких `[R] [Workspace:RENDER]` / `[Perf:TabSwitch]` / `[ClaudeSDKTab:RENDER]` — renderer стоит.

Гипотеза причины: `Cmd+C` без явного user-selection триггерит дефолтный browser-copy. Chromium синхронно собирает text/html clipboard payload по всему document; на virtualized chat с DOM `26057px` (height contains ~30 mounted items, но цельный flat range через виртуализатор включает все non-rendered placeholder'ы) cost собирания huge. Не подтверждено профайлером — нужен `chrome://tracing` или React DevTools Profiler с трейсом момента.

Не критично, не воспроизводится при обычных tab-switch / scroll операциях, не блокирует main process. Юзер репортил как «непонятный 1:43 фриз», но это не Tab-switch regression — это разовое side-effect от случайного Cmd+C. Решать (если будем): глобальный `keydown` handler на Cmd+C в active SDK-tab без selection → `preventDefault` (или explicit `navigator.clipboard.writeText('')` no-op), чтобы Chromium не запускал full-document serialization. До тех пор — антипаттерн «не нажимать Cmd+C без выделения в heavy SDK-tab» документирован здесь.

## HistoryPanel: тот же virtuoso-паттерн + три специфических грабли

`HistoryPanel.tsx` смигрирован на `react-virtuoso` тем же паттерном что SDK. Триггер: для сессий 200+ entries прежний `entries.map() + contentVisibility:auto` отдавал ~30% видимого окна, кнопки Timeline'а приходилось «жать 2-3 раза чтобы дорисовалось». Юзер прямо сослался на SDK как канонический образец: *«посмотри как работает Claude из SDK, там какой-то добавляли функционал типа lazy loading только продвинутый»*. Тот же `<Virtuoso>` + `scrollToIndex` решает за один клик.

**Грабли 1 — race в scroll-to-uuid когда entries ещё не загружены.** Cmd+click на Timeline синхронно делает `setHistoryPanelOpen(true) + setHistoryScrollToUuid(uuid)`. Panel mount'ится, `loadHistory` запускается асинхронно — entries=[] в течение ~200-500мс. Effect-watcher uuid'а раньше early-return'ил при `entries.length === 0`, **но сбрасывал uuid в null безусловно** (`setHistoryScrollToUuid(null)` после early-return блока). Следствие: первый Cmd+click до загрузки бесследно терялся, никакого scroll не происходило когда entries прилетали. Фикс: при `loading || entries.length === 0` возвращаемся **без сброса** uuid — он живёт в Zustand store, следующая итерация effect (когда entries появятся) увидит непустой store и отработает.

**Грабли 2 — IntersectionObserver на `[data-uuid]` детях не работает с виртуализатором.** Прежний impl наблюдал за DOM-детьми scrollRef через IO, derived оттуда `historyVisibleUuids` для Timeline viewport indicator. С Virtuoso off-screen items unmount'нуты — IO видит только окно ~30 узлов, а юзер визуально может скроллить через 500 entries без того чтобы IO зарегистрировал движение. Заменено на `rangeChanged` callback от Virtuoso (`{startIndex, endIndex}`) → `visibleRangeRef` → `recomputeVisibleUuids()` мапит индексы на uuid'ы по текущему `entriesRef.current`. Чище и cheaper: нет наблюдения за DOM, нет threshold-guessing, диапазон точный.

**Грабли 3 — Virtuoso не прокидывает onScroll prop через свой Scroller**. Нашему `handleScroll` нужен прямой доступ к внутреннему scroller-element'у (FAB-arrow toggle через `style.display`, position save в Zustand debounced 150мс, scroll direction tracking для single-turn highlight). Решение — `scrollerRef={(el) => { if (prev) prev.removeEventListener(...); virtuosoScrollerRef.current = el; el?.addEventListener('scroll', handleScroll, {passive:true}); }}`. Один и тот же ref-callback служит и для CSS Highlight API (Cmd+F treeWalker по `virtuosoScrollerRef.current`).

**Graveyard миграции:**
- `el.scrollTo({top: el.scrollHeight, behavior:'smooth'})` для scroll-to-bottom **не работает** на виртуализованном списке — `scrollHeight` неизвестен пока items не измерены, smooth-scroll останавливается на пол-пути. Заменено на `virtuosoRef.current.scrollToIndex({index: length-1, align:'end'})`.
- `el.scrollTop = savedPos` в restore-effect — то же самое. Решение: writing `virtuosoScrollerRef.current.scrollTop = savedPos` дважды через два `requestAnimationFrame` (после первого Virtuoso перемеряет items, scrollTop переинтерпретируется). `initialScrollTop` prop Virtuoso не подходит — он только initial при mount, а sessionId/loading rebuild'ят список.
- `contentVisibility: auto + containIntrinsicSize` в `entryWrapperStyle` удалены — виртуализатор уже владеет рендером, browser-native skip двойного слоя.

## Code map

- `src/renderer/components/Workspace/ClaudeSDK/ClaudeSDKTab.tsx::VirtualizedMessages` — отдельный мемо-компонент, читает length из `useAuiState`, маппит индексы через `MessageByIndexProvider` + `MessageRoleDispatch`. Принимает stable `components` map от родителя через `useMemo` — без stable ссылки Virtuoso re-mount'ит item-tree на каждый родительский render.
- `src/renderer/utils/sdkHistoryPrefetch.ts` — module-level Map cache `(tabId::sessionId) → rawMessages[]`. Single-shot read через `consumePrefetched` (delete-on-read), запись через `setPrefetched` из `useWorkspaceStore.restoreSession` параллельным `Promise.all`.
- `[SDKVisibility]` / `[SDKMsgRender]` / `[SDKHistory:Main/Client]` / `[TerminalArea:useMemo RECALCULATING]` логи — оставлены как regression-сенсоры, не удалять. Без них следующая регрессия незаметна (фриз feels random; deterministic logs показывают ровно где).
- `src/renderer/components/Workspace/HistoryPanel.tsx` — Virtuoso instance с `data={entries}` + `computeItemKey={(_,e)=>e.uuid}` + `scrollerRef`-callback подключающий `handleScroll` + `rangeChanged` для visible-uuid set. `virtuosoRef.scrollToIndex({index, align:'center'})` используется в `historyScrollToUuid` watcher, search-jump (Cmd+F), scroll-to-bottom (FAB + window event `history-panel:scroll-to-bottom`). `historyScrollToUuid` Zustand state доживает entries=[] фазу — effect только сбрасывает uuid после успешного scroll или явного `idx < 0` (entry не в сессии → emit `history-panel:scrolled-to` с `found:false`).
