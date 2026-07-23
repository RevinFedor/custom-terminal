# History как основная поверхность AI-вкладки

## Зачем изменили роли

Для Claude/Codex PTY-вкладок основная работа идёт с ходами диалога, status, Send/Stop/Resume/Rewind, а не с ANSI-экраном CLI. Поэтому History теперь занимает центр рабочего места, а raw-терминал стал полноценным escape hatch по кнопке. Это не просто перестановка вёрстки: History должна сохранить все сценарии живого TUI, а терминал — весь буфер, focus, search и ввод.

Режим включён для обычных PTY-вкладок Claude и Codex, включая новую вкладку без ещё созданного session ID. Не распространять его на Gemini, Claude SDK, browser и file-tab просто ради симметрии. У Gemini нет парного History composer/runtime-контракта, а остальные типы вкладок вообще имеют другую primary surface; скрыть их до появления этого контракта было бы downgrade.

## Контракт поверхностей

- History не имеет панельной шапки `History`, reset-width, крестика и постоянной кнопки поиска. `Cmd+F` открывает временную строку поиска над историей.
- Единый control слева над input показывает READY/BUSY/STOPPED и переходные STARTING/STOPPING/REWINDING/UPDATING/interrupted/error в одном месте. Отдельные BUSY + THINKING плашки запрещены: один lifecycle не должен занимать две строки. Круглая точка и отдельная кнопка terminal тоже объединены в цветную SVG-иконку terminal внутри status-control.
- Клик по status-control открывает и сворачивает floating xterm; белая рамка всего control означает, что окно показано. Описание открывается сразу по hover, правый клик копирует title, description, полные session ID и tab ID для логов.
- Когда terminal открыт, `Cmd+F` принадлежит terminal search; когда свёрнут — History search. В titlebar terminal нет отдельной search-кнопки. Два global capture-listener не должны открывать оба инпута.
- Обычные user/assistant-блоки показывают контент без повторяющейся строки `CODEX/CLAUDE · время · message id`: агент уже понятен из вкладки, а техническая строка перед каждым сообщением разрушает сканирование. Правый клик по пустой части блока открывает native action `Copy ID and details`; правый клик по самому тексту не перехватывается, чтобы сохранить системную работу с выделением и копированием.
- Под durable user-блоком зарезервирована компактная строка действий Copy/Rewind, которая проявляется по hover или keyboard-focus. Она остаётся в геометрии строки даже когда визуально скрыта, иначе Virtuoso переизмеряет сообщение при каждом наведении. Copy берёт только prompt; Rewind передаёт raw UUID в Timeline и проходит тот же runtime/boundary guard, что контекстное меню точки, а не поддерживает второй rollback-flow.
- Composer по умолчанию начинает с трёх строк и растёт по переносу текста до пользовательского предела в 20 строк. И начальная высота, и предел настраиваются отдельно в `Settings → Размеры → AI-интерфейс → Поле ввода`; предел никогда не может стать меньше начальной высоты. После него высота фиксируется и появляется тонкий внутренний scrollbar, browser resize-handle намеренно отсутствует. Шрифт transcript/tool-блоков задаётся отдельно в «История», шрифт набираемого текста — в «Поле ввода».
- В composer простой `Enter` и `Cmd+Enter` отправляют, `Shift+Enter` вставляет новую строку. Pull и Send занимают одну вертикальную колонку: Pull сверху, Send снизу.
- Правый клик по composer открывает кастомный первый уровень `Insert Prompt / Scripts` в той же визуальной грамматике, что Opt+V. Оба пути вставляют в tab-scoped History draft, а не в скрытый xterm. Скрипт вставляется как редактируемый текст без `CR` и без запуска; рабочая директория берётся у живого PTY с fallback на cwd вкладки.
- `Cmd+V` с bitmap вставляет короткий синий `[Image #N]`, а durable файл хранится отдельно от редактируемого текста. Marker и ref принадлежат tab-scoped draft вместе: переключение вкладки их не теряет, полное удаление marker освобождает только его ref, повреждённый marker сохраняет ref для ремонта и блокирует отправку. После Send тот же marker или materialized `[imagePath: …]` остаётся синим внутри user-блока: commit не должен превращать узнаваемое вложение в обычный текст.
- Пока bitmap сохраняется, composer показывает `[Image saving…]`; Send и перенос в Run After запрещены. Перед Send файл заново проверяется, после чего marker раскрывается в transport path. Если пользователь успел допечатать или заменить вложение во время этой асинхронной проверки, отправляется нажатый snapshot, а более новый draft не очищается.

## Быстрый возврат и раскрытие блоков

При возврате A → B → A History сразу показывает последний ограниченный snapshot A, не заменяя уже известные строки экраном `Loading`. В фоне main проверяет durable revision источника; неизменившийся transcript не проходит повторный parse/projection/IPC. Старый ответ первого открытия A не имеет права примениться к новому A после промежуточного B: каждая привязка owner получает новое поколение.

Durable cache хранит сырые server rows, а локальные queued/sent/rewind строки и временные suppression — отдельный малый overlay. Presentation-фильтр нельзя записывать как durable snapshot: иначе отменённый prompt останется скрытым после истечения suppression, пока файл физически не изменится. Лимиты и точный контракт revision описаны в `fact-transcript-сервис.md`.

Primary composer закреплён отдельным absolute-слоем у нижней границы History, а не является flex-соседом, который уменьшает viewport списка при каждой новой строке. Virtuoso остаётся одного размера; его Footer резервирует ровно измеренную высоту composer’а, поэтому последнее сообщение достижимо. Если пользователь читает середину, рост input не меняет `scrollTop`; если он уже у хвоста, список догоняет новый реальный низ.

При раскрытии Thinking/tool/MCP/Edit/Compact/Subagent History не прыгает к глобальному низу и не сохраняет старую верхнюю координату блока. После того как виртуализатор измерил новую высоту строки, список сдвигается только на положительный overflow нижней границы раскрытого блока; если блок и так помещается, scroll не меняется.

Раскрытый code/diff/output не получает колесо только потому, что курсор оказался над ним. До клика wheel прокручивает общую History; клик по реально переполненному body передаёт вложенному scroll ownership и делает существующую левую rail светлее. Клик снаружи, scroll общей History или попытка пройти верхний/нижний край блока снимают ownership. Listener живёт на одном native non-passive capture уровне Virtuoso: React `onWheelCapture` в React 19 passive и не может надёжно отменить внутренний scroll.

Standalone tool-call уже является отдельной строкой transcript, поэтому не должен одновременно наследовать вертикальный padding обычного assistant-сообщения и полные внешние margins карточки из общего renderer-пакета. Пользовательский симптом — вокруг `BASH ls …` появляется почти пустая строка сверху и снизу при нормальных данных rollout. Уплотнение scoped только внутри History: общий пакет используют другие поверхности с другой композицией, и глобальная правка изменила бы их без доказанной проблемы.

Production-цепочка переключения вкладок диагностируется через `[HistoryHandoff] SURFACE_OWNER`, `LOADER_VISIBLE/LOADER_HIDDEN`, `LOAD_START/LOAD_APPLY/LOAD_UNCHANGED/LOAD_STALE_DROP` и `CACHE_WRITE/CACHE_REJECT`. В одной цепочке есть короткие tab/session, digest полного owner, generation, cache age/rows/bytes и digest вытесненных owners. Это различает четыре внешне одинаковых loader’а: exact miss, новый writer/session в той же вкладке, LRU/oversize rejection и поздний ответ предыдущего поколения.

## Единственный xterm и связанные слои

Floating-окно оборачивает тот же единственный `TerminalArea`; второй `TerminalArea`, новый React key или Portal для самого xterm запрещены. Закрытие меняет только presentation (`visibility`, `opacity`, `pointer-events`) и не меняет active/runtime lifecycle. Иначе сворачивание потеряет terminal buffer, PTY listeners, composer draft или фоновое управление из API/iOS.

Скрытый xterm продолжает быть текущим TUI и main/headless screen authority, но сам факт живого процесса не означает «на экране пустой composer». Перед History Send приложение различает composer, startup, model picker и native Rewind overlay; последние три оставляют History draft на месте и не получают Enter. Это короткая проверка режима прямо у границы записи, а не прежний долгий status/process/session preflight: обычный физический Enter пользователя по-прежнему сразу уходит в PTY.

Run After логически принадлежит AI-вкладке, а не видимому прямоугольнику xterm. Он продолжает жить внутри `Terminal`, но в primary-History рендерится через Portal в workspace-level host над History; нижняя граница host измеряется по controls, поэтому очередь не перекрывает input. Это сохраняет один store/lifecycle при скрытом terminal; кнопка History в rail скрыта как дубль уже основной поверхности. Task panel остаётся отдельным workspace-overlay.

У Run After два разных класса действий. Обычный Replay и `+grab` манипулируют тем input, который пользователь видит: в primary-History это tab-scoped History draft, причём Replay аппендит текст и не затирает уже набранное. `Cmd+Replay` и автоматический Run After остаются на общем подтверждаемом PTY scenario-path: переводить их через запись draft + синтетический клик Send нельзя, иначе появятся два владельца handoff и риск двойной отправки. Отдельная кнопка Pull в History остаётся явным способом забрать draft именно из floating terminal; она доступна и во время BUSY, потому что читает отдельно набранный TUI draft и не вмешивается в текущий ответ. Stop, Rewind, pending question и другая незавершённая History-операция по-прежнему блокируют Pull.

При обычном Replay изображение переезжает как semantic `[Image #N]` плюс отдельный durable ref; ID перенумеровываются относительно уже набранного draft. Длинный `[imagePath: …]` появляется только на границе Send. Для Codex transport затем создаёт native image slot через whitespace-free alias, Claude получает стабильную file-reference — одинаковое хранение не означает одинаковый native TUI transport.

Тот же ownership действует для внешнего ввода внутри вкладки: диктовка и другие composer-injection действия дописывают tab-scoped History draft, а не невидимый xterm. Enter после остановки диктовки вызывает канонический History Send, который уже владеет attachments, readiness и rollback; сырой `CR` в скрытый terminal отправил бы не тот текст, который пользователь видит.

Обычные READY/BUSY/STOPPED остаются проекцией существующего History runtime. Детальные startup/stopping/interrupted берутся из уже существующего lifecycle в `TerminalArea` и передаются как готовое presentation. Не создавать ещё один набор IPC listeners в status-row: два независимых вычисления одного lifecycle дадут READY в History одновременно с LOADING в terminal overlay.

History Start/Resume не пишет launch-команду напрямую через `terminal:input`. Остановленный агент может оставлять обычный shell с незапущенным пользовательским текстом; поэтому History вызывает тот же main-side launch boundary, что control bar, aliases, auto-resume и внешний API. Boundary отменяет shell-строку только после свежего доказательства, что foreground-процесса нет, а затем атомарно запускает агент. History снимает interrupted-состояние лишь после ответа `accepted`; отказ оставляет Resume и исходный статус доступными, а не превращает попытку в ложный `STARTING`. Это не распространяется на Send в живой TUI — там terminal draft имеет отдельный ownership/preflight-контракт.

## Геометрия floating-окна

Окно перемещается за titlebar и меняется с четырёх сторон и четырёх углов. Каждая ручка двигает только схваченные границы; противоположные остаются на месте. Пределы: 30–80% ширины и 20–80% высоты рабочей зоны. Первоначальный максимум 60% оказался неочевидным: сохранённое окно уже стояло на лимите, поэтому drag верхней/нижней грани наружу выглядел сломанным, хотя pointer hit-test работал. Геометрия хранится в процентах, чтобы переживать другой размер окна.

Нижняя граница рабочей зоны floating terminal не фиксирована: `ResizeObserver` меряет реальную высоту status/composer, поэтому auto-grow input и AskUserQuestion поднимают нижний clamp окна. Сам viewport History при этом не сжимается — безопасное место под composer задаёт Footer spacer. После достижения предела скроллится input. В начале drag/resize нужно снимать фактический `getBoundingClientRect()` окна, а не доверять ref после async hydrate: иначе первый drag одновременно переместит и изменит размер. Preview обновляется не чаще одного `requestAnimationFrame`, persistence применяется один раз на `pointerup`.

## Что проверять при изменениях

- Открыть/свернуть terminal и убедиться, что DOM-rect и buffer сохранились, а hidden layer не забрал focus у History input.
- После fresh restore первый drag меняет только position; каждая из восьми resize-ручек сохраняет противоположные edges и clamp.
- Увеличить textarea до настроенного max-height: terminal stage должен уменьшиться, окно остаться выше controls, а следующий текст — прокручиваться внутри input без ручной resize-ручки.
- Прогнать `Cmd+F` в обоих режимах, trusted terminal input, нижний scroll-to-bottom, status copy и живой Run After. В titlebar остаётся только Hide; scroll появляется внизу лишь после прокрутки вверх. В Run After не должно остаться кнопки History, а обычные `+grab → Replay` должны перенести draft History → queue → History без фокуса скрытого xterm.
- Продиктовать текст, затем нажать Enter: сначала он должен появиться в видимом History input, затем уйти через History Send; скрытый terminal composer остаётся нетронутым.
- Проверить `Enter`, `Cmd+Enter`, `Shift+Enter`, вертикальные Pull/Send, ПКМ `Insert Prompt / Scripts` и Opt+V: вставка остаётся в History draft, а выбранный скрипт не исполняется.
- Вставить два bitmap подряд: получить `[Image #1]`/`[Image #2]`, переключить вкладку и вернуться, удалить один marker, затем прогнать `History → +grab → Replay → History`. Pending/damaged marker не должен покидать History; допечатанный во время проверки файла текст остаётся следующим draft.
- На длинной History раскрыть блок у нижнего края: его низ должен стать виден без прыжка к концу всей истории. Wheel над блоком до клика двигает History; после клика светлая rail показывает внутренний focus, а click-outside/outer scroll его снимает.
- Переключиться A → B → A: строки A должны быть видны в первом кадре без `Loading`, а фоновая проверка не должна вернуть старый ответ другой генерации. Если loader появился, одна последовательность `SURFACE_OWNER → LOADER_* → LOAD_* → CACHE_*` должна объяснить точную причину.
- Навести durable user prompt: Copy/Rewind появляются без сдвига соседних строк. Copy берёт только prompt, а Rewind на idle-вкладке даёт тот же preview/draft и lifecycle, что действие Timeline; во время busy должен быть видимый отказ.
- Увеличить composer в середине длинной History: видимое сообщение и `scrollTop` не меняются. Повторить у самого низа: хвост остаётся доступен над composer, floating terminal не перекрывает input.
- Между соседним текстом и standalone Bash/tool-call не должно быть «пустой строки» из сложившихся отступов; раскрытый output остаётся внутри измеренной строки и не перекрывает следующий блок.
- Правый клик по пустой части сообщения должен предложить копирование ID/details, а по тексту — не открывать это меню.
- В остановленном Claude и Codex набрать в floating terminal уникальную shell-команду без Enter, нажать History Resume и проверить: агент дошёл до READY, незапущенная команда не выполнилась, а повторный launch при живом агенте отклонён без `Ctrl+C`.

Связанные факты: `fact-terminal-rendering.md`, `fact-prompt-queue.md`, `fact-codex.md`, `fact-claude-tui-control.md`.
