# Fix: Mobile chat scroll-teleport (resize-shrink → false-positive atBottom → followOutput pin)

> ⚠️ **УСТАРЕЛО.** Ни один из round-1 / round-2 фиксов в этом файле в итоге не сработал. Cascade-shrink на больших чатах (1700+ entries) оказался by-design behavior'ом `upwardScrollFixSystem.ts` в react-virtuoso, который maintainer не фиксит на open-source версии. Решение — миграция на virtua, см. **[`fix-virtuoso-to-virtua-migration.md`](fix-virtuoso-to-virtua-migration.md)**.
>
> Файл сохранён как **graveyard отброшенных подходов**: при следующих скролл-регрессиях НЕ применять `computeItemKey` / `atBottomThreshold:32` / `scrollSeekConfiguration` / `defaultItemHeight` к virtua — это virtuoso-specific patches, у virtua другая архитектура.

## Симптом

На phone в SDK/PTY-чате юзер скроллит вверх к старым сообщениям, в какой-то момент **скролл резко уезжает в самый низ** плавной анимацией. Не дёрг на ±50px (это был `fix-mobile-scroll-jitter-virtuoso.md`), а полноценный «телепорт» — экран показывает старое сообщение, и за секунду плавно укатывается вниз чата.

Жалоба: *«листал-листал несколько раз, в какой-то момент произошло дёрганье... скролл просто телепортировался хуй пойми куда. Ну, вниз сам.»*

## Воспроизведение по логам

Зацепили `[ScrollDiag]` для сессии 2026-05-28 17:25 MSK (= 14:25 UTC):

```
14:25:21-26  scroll deltas -66/-93/-55/-60/-62/-128/-59…     ← юзер тащит палец вниз,
                                                                идёт к старым сообщениям
                                                                (height стабильно 17083)
14:25:27.248 atBottomStateChange {atBottom:true}              ← ★ virtuoso ОШИБОЧНО
                                                                  решила что at-bottom
14:25:27.454 scroll {top:14551, delta:-1014, height:16069}    ★★ shrink #1 (-1014px!)
14:25:28.226 scroll {top:13537, delta:-1014, height:16069}    ★★ shrink #2
14:25:28-32  scroll +46/+61/+26/+22/+25/+23/+16…              ← virtuoso smooth-scroll-to-bottom
14:25:32.733 atBottomStateChange {atBottom:true}              ← окончательно at-bottom
```

`scrollHeight` за 200ms ушёл `17083 → 16069` (минус 1014px). Дважды по -1014 в `onScroll` — это virtuoso дважды компенсировал размер контейнера, чтобы визуально удержать положение item'a. Потом серия +20..+60 — её собственная анимация smooth-scroll к последнему index'у, спровоцированная транзиентным `atBottom=true`.

## Root cause (три слоя, сошлись в один шторм)

### 1. Один из item'ов чата ре-измерился на ~1000px короче

Что именно — assistant Markdown / collapsible ToolCard / lazy image — root cause всех вариантов один: ResizeObserver virtuoso ловит реальную высоту item'a, которая отличается от закэшированной. При прокрутке вверх off-screen item возвращается в DOM-window, его реальная высота прилетает, total list height пересчитывается. Это нормальный механизм virtuoso, но он становится опасным в комбинации со следующими двумя пунктами.

### 2. Отсутствие `computeItemKey` на главном Virtuoso

Без `computeItemKey` virtuoso идентифицирует item'ы по **индексу массива**, не по стабильному uuid. При unmount/re-mount (выход из viewport → возврат) кэш высот теряется. На следующем mount'е высота учится заново — и если соседний item успел занять тот же индекс, его кэш «загрязнён» чужими измерениями. Drawer-virtuoso (line 2831 был, оставлен) использовал `computeItemKey={(_index, e) => e.uuid}` — main chat был без этого.

### 3. `atBottomThreshold:120` — слишком толерантно

Virtuoso вычисляет `atBottom = (scrollHeight − scrollTop − viewport) < atBottomThreshold`. После shrink с -1014px denominator меняется мгновенно: `scrollHeight` падает на 1014, `scrollTop` остаётся прежним до следующего frame'а. Если viewport ≥ 400px (любой смартфон) и старый `scrollTop` был выше bottom'а на 500-1000px — после shrink этот gap становится <120 → atBottom=true. Транзиент на 1-2 frame'а, но distinct-фильтр virtuoso его пропускает, и в `atBottomStateChange` callback приходит true.

### Итог

Один transient atBottom=true → setAtBottom(true). Virtuoso continue smooth-scroll к последнему index (она думает «юзер хочет к bottom, помогу»). User видит плавную прокрутку 4 секунды до самого низа.

## Фикс (три минимальные изменения)

### 1. `computeItemKey` по entryUuid

```ts
<Virtuoso
  computeItemKey={(_index, entry) => entry.entryUuid || entry.id || _index}
  ...
/>
```

Virtuoso запоминает height per-uuid, не per-index. Возврат item'а в viewport — берёт реальную закэшированную высоту сразу, без ре-измерения. ResizeObserver продолжает работать (height-change всё ещё ловится), но новые значения уходят в правильный key — без перекрёстного загрязнения.

### 2. Gate `setAtBottom(true)` через `isScrollingRef`

```ts
const isScrollingRef = useRef(false);

<Virtuoso
  isScrolling={(s) => { isScrollingRef.current = s; ... }}
  atBottomStateChange={(b) => {
    if (b && isScrollingRef.current) return;  // ← transient true while user drags = ignore
    setAtBottom(b);
  }}
/>
```

Если atBottom=true приходит **во время активного скролла юзера** — игнорируем. Юзер сам приедет к низу естественно, тогда `isScrolling` settles to false и следующий true пройдёт. Это устраняет именно false-positive от SIZE_DECREASED compensation, не трогая нормальный путь.

### 3. `atBottomThreshold:120 → 32`

Default virtuoso = 4, у нас был 120, скомпромиссились на 32. Понижение сужает окно false-positive в frames между shrink и compensation. 32 достаточно для ergonomics chevron-FAB (`!atBottom` показывает кнопку «↓ вниз») — не показывается когда юзер только-только не доехал.

## Round 2 (2026-05-28 17:58 MSK): cascade-shrink на большом чате

Первый patch (computeItemKey + gate + threshold:32) убрал followOutput-auto-pin сценарий из round 1, но **не** покрыл другой класс телепорта на чатах с 1000+ entries. Логи 14:58:53 UTC показывают **8 shrink-event'ов подряд** суммарно `-15916px` за 800ms (`-4253, -833, -1007, -1786, -1746, -1765, -1990, -2605`). `followOutput` логи в это время чистые (`returned:false`), `atBottomStateChange` не флипается — то есть gate работает. Это **virtuoso собственная SIZE_DECREASED compensation cascade**, не наш followOutput.

### Root cause round 2

Виновник — virtuoso lazy-measurement model на длинных списках. При быстром fling-scroll через 1700-entry чат items проскакивают через viewport — virtuoso не успевает их **полноценно** замерить, в её internal model лежат estimated/stale heights. Когда скролл затухает (`isScrolling:false`) — ResizeObserver flushит накопленные measurements **batch'ем**, virtuoso applies their compensation **по очереди** в `onScroll`. Юзер видит это как «телепорт 5-8 раз подряд» — каждый shrink визуально сдвигает контент.

Триггер shrink (а не grow): items **выше viewport** уменьшаются. Кандидаты в нашем чате: ToolCard на `useEntryExpanded(id, isError||isPending)` — pending result защёлкнут `open=true`, после WS `result` доходит до клиента (`flushReducer replace prev:1720 next:1807` — 87 entries обновились разом), сам ToolCard не collapse'ится (Map хранит user-выбор), но измеримая высота ResultPreview меняется (raw text → formatted). Накладывается на любой явный user-toggle Раскрыть/Свернуть.

### Round-2 фикс: `scrollSeekConfiguration` placeholder

```ts
<Virtuoso
  scrollSeekConfiguration={{
    enter: (velocity) => Math.abs(velocity) > 1500,
    exit: (velocity) => Math.abs(velocity) < 100,
  }}
  components={{
    ScrollSeekPlaceholder: ({ height }) => (
      <div style={{ height, padding: '8px 14px', color:'#3a3a3a' }}>···</div>
    ),
    Footer: ...
  }}
/>
```

Velocity > 1500 px/s (быстрый fling) → virtuoso swap'ает реальные items на placeholder'ы (height тот же, content тривиальный `···`). ResizeObserver не срабатывает на placeholder'ах (стабильная высота). После затухания скорости < 100 px/s — обратно реальные items, они мерятся сразу с правильной высотой в стабильном состоянии, не batch'ем.

Эффект для юзера: при быстрой прокрутке вместо мелькающих markdown'ов видны серые `···` блоки той же высоты. Это **видимый**, но **детерминированный** UX — лучше чем «случайный телепорт назад».

Threshold 1500 px/s выбран эмпирически: палец-flick по iPhone обычно 2000-4000 px/s, медленное прокручивание 200-800 px/s. Граница 1500 пропускает «целенаправленное чтение» и ловит только «беглый поиск».

## Что **не** трогали и почему

- **`overflow-anchor: auto` на скроллере** — virtuoso специально ставит `overflow-anchor: none` (index.mjs:2453, 2773, 2886), потому что её собственный compensation path конфликтует с браузерным scroll-anchor. Переопределять = ловить новые баги в SIZE_INCREASED ветке.
- **`followOutput` логику** — она правильная. При легитимном atBottom (юзер сидит у низа, прилетает WS-message) auto-pin нужен. Проблема была в **сигнале** atBottom, не в реакции на него.
- **`skipAnimationFrameInResizeObserver`** — workaround virtuoso #1049 для Safari momentum-scroll, оставлен.

## Связанные шрамы

- `fix-mobile-scroll-jitter-virtuoso.md` — другой класс jitter на той же поверхности: `content-visibility:auto` ломал ResizeObserver (фейковые intrinsic-size). Тот фикс убрал CV, текущий — добавил key + gate. Оба «virtuoso измеряет неправильно», разные триггеры.
- `methodology/переносимый-дизайн-mobile.md::content-visibility: auto + virtualization = конфликт` — общий вывод.

## Регрессия-canary

`[ScrollDiag]` логи (`atBottomStateChange / scroll / isScrolling / followOutput`) оставлены. Если когда-то снова появится телепорт — нужно ловить:

1. `scroll {delta:-XXX, height:NEW}` где height < предыдущего height — это shrink-event. Размер shrink'а = подозреваемый item.
2. Сразу за ним `atBottomStateChange {atBottom:true, isScrolling:true}` — если приходит и проходит gate'у — gate сломался или новый код-path обходит его.
3. Серия positive +N deltas = virtuoso smooth-scroll к низу. Не баг сам по себе, но в комбинации с (1) и (2) — телепорт.

Grep'ать `awk '$1 >= "HH:MM:00" && $1 <= "HH:MM:59"' logs/dev.log | grep ScrollDiag` (помнить про UTC = MSK−3).
