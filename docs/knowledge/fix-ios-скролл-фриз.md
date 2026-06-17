# Fix: iOS Terminal фриз скролла (SwiftUI rows -> UIKit table)

## Симптомы

Нативный iOS Terminal открывал тяжёлую Codex/Claude историю и зависал не только на
timeline-jump, но и на первом обычном скролле вверх. Пользовательские симптомы:
first scroll фризит ещё до открытия Timeline, после jump иногда несколько секунд
пустой экран, у верхней границы нельзя уйти выше текущих 80 записей, а после
первой попытки top paging viewport уезжает в новое место вместо того чтобы
остаться на текущем тексте. Отдельный UX-симптом той же зоны: строки tool/bash/MCP
после промежуточного UIKit slice начали выглядеть как обычные карточки
`write_stdin` + `Full`, хотя пользователь ожидал прежний компактный tool-header.

## Что доказали логи

Сеть и `/history` не были bottleneck. В нескольких прогонах `/history` и
`/history?around=...` возвращались за `455-610ms`, `publishMs=0`, а watchdog
писал `[hang] ... inFlight=none` уже после publish, во время materialize/layout
или первого scroll. Маленькое окно тоже не спасало: timeline-jump давал всего
`entries=49`, но внутри были tool rows по `30k-40k` raw chars и compact summary
около `160k-200k` chars. Позже логи показали, что `renderChars` у закрытых tool
rows уже малый (`~192`), но raw payload всё ещё жил в row model и проходил через
header/detail/diff path.

Самый важный контрольный прогон был до Timeline: `last=80`, `materialize display`
с `clippedTool=18`, `maxRawText=201341`, `maxRawTool=40156`, затем первый scroll
и скачок content height примерно с `7k` до `19k`, после чего `[hang] gap=4838ms`.
Это сняло гипотезу «виноват drawer/timeline»: фриз сидел в transcript list и
первом lazy materialize тяжёлых dynamic-height rows.

## Что пробовали и почему этого было мало

Ограничить видимый `Text` до preview было недостаточно: full raw string всё ещё
может быть дорогой через equality, signature, line counting, preview construction
или detail/header adapter. Лёгкий tool-header (`buildsToolCall=false`) и cached
lengths убрали один явный hot path (`entry.asToolCall` больше не строил полный
`VCToolCall` ради закрытой строки), но first-scroll freeze повторился без
Timeline. Это доказало, что проблема шире одного tool header.

Простой переход на UIKit тоже не был бы полным решением, если продолжать кормить
cell configuration полным `40k/200k` payload. UIKit решает reuse, scrolling и
часть layout-предсказуемости, но не делает синхронное сравнение/измерение
огромной строки дешёвым. Поэтому архитектурный фикс состоял из двух частей:
native table как контейнер и display-model, в котором строка списка не владеет
полным текстом.

Первый top paging (`last=80 -> 160`) исправил bounded-window, но открыл другой
базовый баг: prepend новой истории сверху сохранял абсолютный `contentOffset`.
При появлении старых rows текущий текст визуально уезжал, будто пользователь
продолжает бесконечно скроллить вверх. Для chat/history prepend абсолютный offset
не является смысловой позицией; смысловая позиция — конкретная первая видимая
строка и её delta от верхней границы viewport.

## Рабочая архитектура

Transcript list в native iOS рендерится через `UITableView`, а не через SwiftUI
`ScrollView + LazyVStack`. Строка списка получает bounded preview, stable id,
line-count/raw length metadata и display type. Полный payload хранится отдельно
по id и достаётся только для full view или явно раскрытого user prompt. Это
относится к tool/bash/MCP results, compact summaries и длинным user prompts.

Tool/bash/MCP rows в списке остаются компактными: tap открывает нижний sheet с
полным содержимым, правый счётчик показывает строки (`lines`), не сырые символы.
User prompt имеет inline `Show more` / `Show less`, потому что это основной
контент сообщения; tap по самому prompt всё равно открывает full sheet. Sheet
рендерит текст через native selectable text surface, чтобы long-press позволял
выделять фрагмент, а не только копировать весь блок.

История грузится хвостом и расширяется вверх инкрементально:
`last=80 -> 160 -> 240...`, пока loaded < total. Перед reload table снимает
`VisibleAnchor`: id первой видимой строки + смещение от верхней границы. После
reload находит тот же id в новом массиве и восстанавливает offset так, чтобы эта
строка осталась в той же точке экрана; второй deferred restore нужен для settle
после self-sizing. Проверочные логи: `older-history load`,
`uikit transcript preserve prepend`, `uikit transcript preserve prepend-settle`.

Timeline для native клиента должен быть готов заранее: prefetch после входа в
чат, а не только при открытии drawer. Jump может заменить окно истории на
around-target slice; после этого table получает команду scroll-to-anchor, а
target row кратко подсвечивается зелёным flash, чтобы пользователь понял куда
попал.

## Регрессия-canary

Если снова появляется «первый scroll завис», сначала смотреть не количество
entries, а строки вида `materialize display ... maxRawText/maxRawTool`,
`[hang] ... inFlight=none`, `heavy-row rawChars/renderChars` и content-height
jump во время первого scroll. После перехода на UIKit старый SwiftUI marker
`[term-render] row bodies=...` уже не должен быть главным объяснением transcript
rows; если он снова всплывает рядом с freeze, значит часть transcript вернулась в
SwiftUI hot path.

Если пользователь упирается в верхнюю границу, нужен лог `older-history load`.
Если лог есть, но текст прыгает, нужен лог `uikit transcript preserve prepend`.
Если оба есть, проверять stable id: prepend preservation не работает, когда row id
меняется между tail reloads или around-target reload.

См. также `fact-mobile-web.md::Native clients share the REST/SSE contract` и
`methodology/переносимый-дизайн-mobile.md::Длинная история: список для навигации`.
