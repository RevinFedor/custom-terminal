# Fix: миграция с react-virtuoso на virtua для mobile chat

## Симптом

На phone в SDK/PTY-чате при скролле вверх в большом чате (1000+ entries) экран **резко уезжает** на тысячи пикселей назад. На рывок: сначала плавная прокрутка пальцем, потом отпускаешь — и за 200-800ms scrollTop телепортируется на −15000px каскадом из 4-8 jumps. Иногда после каскада ещё плавно укатывается в самый низ чата. На коротких чатах (<500 entries) — менее заметно или не возникает вообще.

Жалобы юзера на разных раундах: *«листал-листал, в какой-то момент произошло дёрганье... скролл просто телепортировался хуй пойми куда»*, *«нихуя баг абсолютно тот же самый»*, *«5 раз подряд телепортация»*. Плюс UX-разрывы при попытках починить: чёрные экраны, не работающий «↓ to bottom», ломающийся GoTo.

## Root cause (архитектурный, не баг)

`upwardScrollFixSystem.ts` в react-virtuoso — **by-design**, не баг. Механика:

1. Virtuoso для never-mounted items использует **median уже измеренных** как initial estimate. В нашем чате tail полон длинных markdown/tool-блоков (200-3000px) → median ≈ 160px.
2. Items выше viewport — короткие user-сообщения (40-100px). Каждый mount даёт diff −80..−120px.
3. Virtuoso честно копит deviation в stream и публикует одним `scrollBy()` ровно когда `isScrolling=false` (по design: спрятать прыжок под пальцем, применить после release).
4. На iOS WebKit `scrollTop`-writes во время momentum-scroll **defer'ятся** до конца инерции. К моменту publish'а deviation накоплено на тысячи пикселей → cascade jumps.

**Это известная семья багов с 2020 года** — issues #70, #598 (wontfix), #716, #788, #945, discussion #1083, #1094. Maintainer (petyosi) **не фиксит** open-source virtuoso, продаёт `@virtuoso.dev/message-list` ($168-312/seat/год) как «chat-specific» решение. См. [Issue #1065 — официальный анонс Message List](https://github.com/petyosi/react-virtuoso/issues/1065): *«built specifically for AI/human chat interfaces»*.

## Почему VirtuosoMessageList не подошёл

Платный продукт имеет жёсткий **runtime license-check на hostname** — в `node_modules/@virtuoso.dev/message-list/dist/index.js` зашит regex:

```js
Ai = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|.+\.local)$/
```

Без лицензии при заходе с любого нелокального IP компонент **блокирует рендер** и выдаёт `VirtuosoMessageListLicense error`. У нас mobile-web раздаётся с LAN-IP (`192.168.x.x:7878` через web-server) — это **убивает наш use case полностью**. BloopAI/vibe-kanban купили VirtuosoMessageList → снесли через ~год (коммит `77485b5`, *«Replace commercial @virtuoso.dev/message-list with MIT react-virtuoso»*) из-за Docker-сборки и self-host блокировок. Обход через `patch-package` (заменить regex на `/./`) — это crack коммерческого продукта, юридически серая зона + ломается на каждом npm update.

## Что пробовали на virtuoso и почему не работало

Все попытки — на 4.18.7 (latest). Кладбище:

1. **`computeItemKey={(_,e) => e.entryUuid || e.id}`** + **`atBottomThreshold:32`** + **gate `setAtBottom(true)` через `isScrollingRef`** — убрали один класс false-positive auto-pin, но cascade-shrink остался. Юзер: *«нихуя баг абсолютно тот же самый»*.

2. **`scrollSeekConfiguration` с placeholder'ом при velocity > 1500px/s** — virtuoso должна была swap'ить items на placeholder'ы при fling-scroll. Не помогло: cascade всё равно происходил после finger-up. Юзер: *«опять CSR, опять как все»*.

3. **`defaultItemHeight={60}`** — пытались подменить median estimate низким значением. Сломало рендер: virtuoso issue #132 явно описывает что `defaultItemHeight` ниже реальных items при `initialTopMostItemIndex` даёт **пустой экран**. Юзер: *«у меня экран тупо пропал нахуй»*.

4. **`defaultItemHeight={70}` + `heightEstimates: number[]` per-index по `entry.kind`** (user=70, assistant=400, tool=300, etc.) — официально рекомендованный petyosi'м максимум для free-tier (Discussion #1083). Логи показали: `scrollHeight` мгновенно рос с 139k → 167k px за 13 сек по мере того как virtuoso мерила реальные items больше estimate. Юзер: *«звучит как костыль в обоих случая, есть другие решения это же костыль на костыле»* — за этим прямой сигнал menяТЬ инструмент, не подкручивать.

5. **ChatItemWrapper с per-item ResizeObserver** для логирования какие entries shrink'аются — диагностический. Не починка. Снят при откате.

Каждая итерация сопровождалась logs `[ScrollDiag]` (kept до сих пор как regression-canary, см. ниже).

## Решение: миграция на virtua

`virtua@0.49.1` (MIT, ~3kB gzip) — другая архитектура virtualization:

- **`overflow-anchor: none`** ставит **сам** на скроллер (virtuoso этого не делает — она вступает в гонку с browser scroll-anchor)
- compensation на size-change применяется **per-resize внутри одного React-dispatch'а**, не копится в `deviation` stream для отложенного `scrollBy()` после finger-up
- 2026 PR #866 «Improve scroll fix accuracy when scrolling up while resizing» + #868 «Improve scroll fix accuracy while markdown streaming» — фиксы **точно нашего класса**
- Production-используется в **Rocket.Chat** (миграция в process), **Lobe Chat** (77k⭐, в canary держат virtuoso+virtua параллельно через фича-флаг, идут на virtua)

Bundle: 532KB → **484KB** (−48KB, −9%).

## Структура замены

Главное архитектурное отличие: virtua **не владеет** scroll-контейнером. У virtuoso `<Virtuoso>` сам был scroller. У virtua **наш** div — scroller, ему передаётся `scrollRef`. Это даёт контроль над `overflow-anchor`, `WebkitOverflowScrolling: 'touch'`, `overscrollBehavior: 'contain'` без обхода чужой обёртки.

```tsx
// Pattern: flex-spacer bottom-anchor (документирован в virtua 0.48 release notes
// как замена удалённой prop `reverse`).
<div ref={scrollRef} onScroll={...} style={{
  height: '100%', overflowY: 'auto',
  overflowAnchor: 'none',           // virtua ставит и внутри, у нас на всякий
  WebkitOverflowScrolling: 'touch', // iOS momentum
  overscrollBehavior: 'contain',
  display: 'flex', flexDirection: 'column',
}}>
  <div style={{ flexGrow: 1 }} />   {/* пушит контент к низу когда короче viewport */}
  <Virtualizer ref={virtualizerRef} scrollRef={scrollRef} onScroll={...}>
    {entries.map((e) => <div key={e.entryUuid || e.id}><EntryView /></div>)}
  </Virtualizer>
  {/* Footer inline (virtua не имеет components.Footer slot) */}
  {busy && <DotsLoader />}
</div>
```

## Маппинг API (virtuoso → virtua)

| virtuoso | virtua | примечание |
|---|---|---|
| `<Virtuoso data={entries} itemContent={fn}>` | `<Virtualizer>` + `entries.map(...)` | virtua принимает children, не itemContent callback |
| `ref.scrollToIndex({index, align, behavior:'auto'})` | `ref.scrollToIndex(idx, {align, smooth:false})` | первый аргумент позиционный |
| `followOutput={fn}` | useEffect[entries.length] + ручная логика if-atBottom-then-scroll | virtua не имеет — реализуется вручную |
| `atBottomStateChange={cb}` | onScroll DOM-обёртки + `scrollSize − scrollOffset − viewportSize < N` | virtua не имеет — считается через handle API |
| `isScrolling={cb}` | `onScrollEnd={cb}` | только конец скролла, не начало |
| `components.Footer` | inline `<div>` после `<Virtualizer>` | virtua не имеет component slots |
| `initialTopMostItemIndex` | imperative `scrollToIndex(last, {align:'end'})` в useEffect | onMount-семантика реализуется вручную |
| `firstItemIndex` | не нужен (мы не делаем prepend, только append-at-tail) | удалить |
| `increaseViewportBy` | `bufferSize` (default 200) | другой механизм; default достаточен |

## Известные ограничения virtua

Все **не пересекаются** с нашими сценариями, но фиксируем для будущих регрессий:

- **#883** — `First prepend after initial reverse-chat mount jumps to latest rows`. У нас prepend не используется (tail-load grab всё сразу), не задевает.
- **#367, #473** — Safari fast-prepend race / layout pause after finger-release. Те же причины, не наш случай.
- **ResizeObserver loop completed with undelivered notifications** в console — annoying warning от ResizeObserver-engine, не функциональный баг.

## Регрессия-canary

`[ScrollDiag]` логи (`scroll / isScrolling / scrollToIndex / atBottomStateChange`) **сохранены** в коде после миграции. Если когда-то снова появится cascade-shrink или другой class scroll-jitter:

1. `awk '$1 >= "HH:MM:00"' logs/dev.log | grep ScrollDiag` (UTC = MSK−3, см. CLAUDE.md::Логирование).
2. Серия `scroll {delta:-XXX, force:true}` с `XXX > 500` подряд = cascade. Если это вернулось — virtua тоже не справилась, копать в её GitHub issues по симптомам.
3. `followIntent {armed:false}` транзиент во время стрима без касания экрана, или отсутствие `pin` событий пока чат стримит = follow-bottom сломался. Полный разбор + что НЕ делать — `fix-mobile-follow-bottom-intent.md`. (Раньше follow гейтился distance-флагом `atBottomStateChange {atBottom}` — заменён на intent-ref, тот лог удалён.)

## Что НЕ делать при будущих регрессиях

Не возвращаться к **уже отброшенным** virtuoso-patches при работе с virtua:

- ❌ `computeItemKey` — virtua использует React `key`, обычный `key={entry.entryUuid || entry.id}` достаточен
- ❌ `defaultItemHeight` низкий — у virtua механизм estimation другой, низкое значение не нужно и может сломать измерения
- ❌ `heightEstimates per-kind` — у virtua нет такой prop, попытка эмулировать через `itemSize` будет тем же костылём
- ❌ `scrollSeekConfiguration` — у virtua нет аналога, эта механика была virtuoso-specific

См. также `methodology/дизайн-принципы.md::Костыли поверх костылей`, `methodology/дизайн-принципы.md::Внешний research до 4-й итерации`.

## Связанные шрамы

- `fix-mobile-scroll-jitter-virtuoso.md` — `content-visibility: auto` ломал virtuoso ResizeObserver (другой класс jitter на той же поверхности). Принцип общий: virtualization + любой механизм скрытой высоты = конфликт. См. `methodology/переносимый-дизайн-mobile.md::content-visibility: auto + virtualization = конфликт`.
- `fix-mobile-scroll-teleport.md` — graveyard первых попыток фикса на virtuoso (round 1 и round 2). Сохранён как защита от регрессии: не пытаться повторить эти patches.
