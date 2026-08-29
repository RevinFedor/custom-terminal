# Fix: геометрия скролла History при переменной высоте

## Симптомы

- При обычном коротком скролле вверх уже показанный текст внезапно заменяется
  skeleton/чёрной областью, а viewport на мгновение движется против жеста.
- При отправке или завершении ответа пользователь находится у физического
  низа, но History прыгает вверх; Copy и соседние controls «плавают» вместе со
  строкой.
- Конечная позиция может оказаться правильной, хотя между началом и концом был
  заметный неверный кадр. Проверка только `до/после` даёт ложный PASS.

## Один симптом создавали разные владельцы позиции

Virtuoso сначала знает оценочную высоту никогда не показанной строки, затем
заменяет её реальным измерением и компенсирует общий offset. Production дал две
чистые подписи без restore/seek/hydration/mount-wave: рост `scrollHeight` на
1112px добавил движение вниз посреди upward-жеста, а shrink на 333px добавил
почти ровно −331px к пользовательскому движению. DOM `scroll` не сообщает, кто
его породил: wheel пользователя, browser anchoring или внутренний writer
виртуализатора.

Поверх этого History заводила собственных владельцев. Fast-seek release писал
`scrollTop` одновременно с компенсацией Virtuoso; send/completion tail pin уже
держал физический низ, но materialized-row bridge затем возвращал старую
смысловую строку (`−574px` и `−2408px`). CSS translate применялся ко всему
списку, поэтому двигались и кнопки внутри строк.

## Что пробовали и почему это не доказало исправление

1. Проверяли только конечный UUID/offset. На `tab-754` первый real-row кадр
   ушёл примерно на `+684px`, следующий вернулся на `−683px`; endpoint выглядел
   правильным, пользователь видел телепортацию.
2. Фиксировали wrapper по `data-known-size` на ordinary wheel. Для новой строки
   это может быть estimate, а не измерение: коробка `120→805px` оставалась
   искусственно большой до release, создавая пустые группы и поздние
   коррекции.
3. Считали сумму wheel packets доказательством fast-scroll. Обычный профиль
   `−216px` и измеренная скорость `258–361px/s` включали seek и сами заменяли
   готовый текст skeleton'ами.
4. Делали post-hoc semantic `scrollTop` settle поверх активного ResizeObserver.
   Два writer'а чередовались до `±900px`; правильный итог не означал чистого
   перехода.

## Текущий контракт

Обычное чтение всегда оставляет реальные строки, selection и focus. Оно не
замораживает оценочные wrapper-высоты. `rangeChanged` coalesce'ится до одного
hydration-centre после quiet; уже показанная full-row удерживается в bounded
окне только при exact physical revision proof и не деградирует обратно в stub.
Перед React apply mid-list reader вооружает смысловой якорь до DOM mutation.

Seek включается только по измеренной скорости (`>3000px/s`, либо `>2600px/s`
после единственного packet `≥600px`), а packet сам по себе лишь подтверждает
принадлежность sample жесту. Placeholder и real-row несут один exact
display-unit key; real-строка раскрывается после quiet measurement, а bridge
атомарно передаёт остаток единственному физическому scroller. Любой новый жест,
restore, Timeline jump, preview или смена presentation owner отменяет старую
транзакцию и очищает mask/bridge/frozen wrappers.

У tail-reader смысловой row bridge не запускается вообще: optimistic row,
composer collapse, live text и durable adoption принадлежат одной bounded tail
transaction. Mid-list semantic owner и tail owner взаимоисключающие.

## Приёмка

Ordinary-сценарий обязан иметь `SCROLL_SEEK_ENTER=0`, placeholders/mask `=0`,
`domRows>0` в каждом rAF/post-paint и движение видимой строки в пределах 1–2px
от wheel с учётом доказанной height delta. Fast-сценарий сравнивает последний
placeholder с первым real-row кадром и проверяет каждый последующий кадр, а не
только финал. После send→completion у физического низа допустим только
`MATERIALIZED_WINDOW_APPLY_TAIL_OWNED`; `WHEEL_GEOMETRY_BRIDGE_WRITE/RELEASE`
того же refresh — регрессия.

Текущий контракт и пороги — `fact-история-производительность.md`; пользовательская
геометрия поверхности — `fact-история-как-основная-поверхность.md`; исполняемый
physical сценарий — `electron-mcp/scenarios/25-history-gesture-height-anchor.md`.
