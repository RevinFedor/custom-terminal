# Fix: Mobile chat scroll-jitter (`content-visibility: auto` + virtuoso)

## Симптом

На phone в SDK-чате юзер скроллит вверх → курсор резко **отматывается назад вниз** во время движения. Жалоба: *«я скроллю вверх, и у меня потом резко курсор что-то во время скролла дёргается вниз»*. Происходит даже на небольших чатах (10-30 messages). На desktop бага нет.

## Корень

`react-virtuoso` использует `ResizeObserver` чтобы измерять реальную высоту каждого item'а и кэшировать в своём индексе позиций. **`content-visibility: auto`** ставит `contain: size layout style paint` на off-screen элементы — браузер отдаёт `ResizeObserver`'у **фейковую** высоту = `contain-intrinsic-size` (200px у нас). Когда юзер скроллит вверх и item приближается к viewport — браузер «оживляет» его, `ResizeObserver` фиксирует **реальную** высоту (например 600px у длинного assistant text). Virtuoso пересчитывает total list height → **scrollTop bump** → пользователь видит «дёрг назад».

## Почему изначально добавили content-visibility

Хотели «free win on iOS 18+» — браузер пропускает paint для off-screen контента. Это полезно когда **нет виртуализатора**. С виртуализатором — pure overhead: virtuoso уже не рендерит off-screen items в DOM (~30 нод max). content-visibility ничего не оптимизирует, только ломает измерения.

## Решение

Убрать `contentVisibility: 'auto'` и `containIntrinsicSize` со всех item-обёрток внутри `<Virtuoso>`. Это касается **двух** мест в `mobile-web/src/App.tsx`:
- main chat virtuoso (`itemContent` в ChatView)
- timeline drawer virtuoso (`itemContent` в TimelineDrawer)

После удаления virtuoso меряет настоящие высоты сразу при mount item'а — позиции стабильны, scrollTop не bump'ается.

## Правило для будущего

`content-visibility: auto` несовместим с любой виртуализацией, которая опирается на ResizeObserver или DOM-measurement (react-virtuoso, react-window, virtua, tanstack/react-virtual). Применяй CV только в **не-виртуальных** длинных списках где DOM полный.

См. `methodology/переносимый-дизайн-mobile.md::content-visibility: auto + virtualization = конфликт`.

## Telemetry для подтверждения

Добавлены `[ScrollDiag]` логи в `Api.log` (флаги `flushReducer / followOutput / atBottomStateChange / isScrolling / scroll`). Позволяют детерминированно увидеть `scroll {delta:-N, ...}` — backward jump в момент когда юзер двигал палец вперёд. Без этого диагностика делалась гипотезами (3 итерации с угадыванием followOutput / WS race / setState batch).
