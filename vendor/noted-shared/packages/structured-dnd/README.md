# @noted/structured-dnd

Headless-ядро для списков, где в одном порядке живут обычные элементы и группы с
дочерними элементами. Пакет общий для GT Editor, Custom Terminal и Voice Record;
file explorer использует его outline-контракт целиком.

## Граница ответственности

Пакет владеет нормализованной моделью `containers + items` и outline-моделью,
pointer-session, snapshot-геометрией, semantic preview, автоскроллом, layout
animation и политикой движения за границей узкого sidebar. Он не владеет файловой
системой, React-разметкой строк, визуальными токенами, IPC и способом сохранения.
Приложение передаёт стабильные ID и атомарно применяет semantic result.

Есть два допустимых preview-контракта. Если интерфейс переставляет строки прямо во
время жеста, после каждой перестановки нужна новая revision геометрии. Если preview
сам перемещает semantic target под курсором, например раскрывает пустую группу, цель
остаётся статичной на весь жест и итоговое состояние применяется атомарно на drop.

## Несколько корней и внешнее завершение

Single-source остаётся default. `getDragSource` включает frozen forest: host один
раз отдаёт нормализуемые `rootIds` и свой opaque context. `sourceId` сохраняет
зажатую строку как anchor, `sourceIds` включает скрытых потомков всех корней.
Несмежные корни используют отдельные footprints; Y-проекция вставляет весь лес
в исходном порядке. Multi-X возвращает `multi-selection`, single-X прежний.

Внешний host передаёт тот же descriptor через `externalDrag`, чистый
`rollbackOutline` и стабильный `ownerKey`. `releaseOwner:'bridge'` явно передаёт
release в `commitExternalDrag`; без opt-in обычный pointerup остаётся прежним.
Перед записью host может проверить `payload.isCurrent()` после своей очереди;
это не заменяет его durable guards. Любая host-проекция конечной позиции должна
быть `previewOutline` до release, а не переписываться внутри commit callback.

Host с собственным imperative cursor preview может явно включить
`pointerPublication:'semantic'`; default `'frame'` сохраняет прежние публикации.
Обычный pointer update без изменения уже подтверждённого immutable preview
меняет live ref, но не painted receipt или React-view. Cmd, dwell, edge-scroll,
изменение слота/owner/geometry продолжают прежний путь. `dragState` описывает
отрисованное состояние; для imperative release есть read-only `getDragSnapshot()`.
Текущая физическая точка проверяет допустимость release, цель берётся из painted.
`externalDrag.readCurrentInput` позволяет cold host проверить актуальную физическую
identity/точку перед adoption. Pending release фиксирует уже submitted candidate,
а не создаёт новый из последней непоказанной координаты.

`getRowProps` передаётся целиком, включая `onPointerDownCapture`: новое нажатие
снимает suppression только от предыдущего drag-click. Оно не должно съедать
первый быстрый выбор/metadata action после принятого drop; keyboard click тоже
сохраняет своё действие. Без нового press сам post-drag click по-прежнему подавлен.

## Проверка

```bash
npm test
```

Тесты покрывают атомарное перемещение поддерева, вход/выход элемента из группы,
вертикальную геометрию, иерархические X-переходы, autoscroll lease и release/cancel.

## Модификатор вложенности

`hierarchyModifier: 'meta'` — явный host opt-in: plain Y и folder hover, только
Cmd-X меняет вложенность. Нажатие/отпускание учитывает последнюю физическую
координату, в том числе queued pointer-frame. Folder dwell локален и не включает
общую navigation-паузу. Подход к непустому header защищён от ранней перестановки
по grab-offset; после прохода за header возвращаются обычные Y-slots.

Без option прежние plain-X/Cmd-navigation остаются. FileOutlineExplorer передаёт
option по запросу host; GT/Voice автоматически на новую policy не переходят.
Terminal отдельно рисует hover mode hint без глобального React-state.
