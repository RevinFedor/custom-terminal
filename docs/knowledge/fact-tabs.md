# Feature: Tab Management

## Intro
Система вкладок в стиле VSCode с единым вертикальным рабочим списком, поддержкой интеллектуального именования и автоматического окрашивания. В 2026-05 она переехала в постоянный левый сайдбар (`TabSidebar` 200px default, drag-resize 140-400 через handle на правом краю). Root layout: `[Titlebar: проекты | кнопки рабочей области] / [TabSidebar: инструменты проекта + список вкладок | TerminalArea | TabNotesSlideout]`. Полоса `ProjectToolbar` во всю ширину удалена 2026-08-18 — см. [`fact-верхняя-полоса.md`](fact-верхняя-полоса.md). Отдельная зона Utils удалена: она больше не является ни пользовательской категорией, ни DnD-целью.

## Tab Naming Patterns
### Auto-generated Names
- `tab-1`, `tab-2`, ... — стандартные новые вкладки (непустой стек счетчика)
- `docs-01`, `docs-02`, ... — вкладки обновления документации (Gemini анализ + Claude редактирование). **Общий счетчик** для обоих потоков.
- `claude-1`, `gemini-1` — AI сессии (только если не переименованы вручную через `nameSetManually`)

### Persistence Guard
При создании таба через `createTabAfterCurrent` с опциями `{ nameSetManually: true }` флаг сохраняется в БД и блокирует авто-переименование в `setTabCommandType`. Это критично для вкладок типа `docs-XX`, которые не должны перезаписываться на `claude`/`gemini` при запуске AI.

Inline rename становится manual ownership только если значение реально изменилось. Fresh tab может быть создан в режиме редактирования имени; клик по кнопке Claude/Codex блюрит input, но unchanged `tab-N` не должен вызывать `renameTab` и ставить `nameSetManually=true`. Флаг manual-name персистится вместе с табом и историей закрытых вкладок, поэтому Cmd+Shift+T должен восстановить именно прежний ownership: вручную названная вкладка остаётся защищённой, unchanged auto-name остаётся доступным для первого AI auto-title.

Tab и tab-group используют общий mount-driven rename ref. Это важно для новой группы: parent-effect мог отработать до появления delayed outline-row и больше не повториться, поэтому input был виден без фокуса. Callback-ref вызывается на реальном DOM mount, один раз делает `focus()+select()` и guard'ится по node identity; controlled rerender на каждую букву не выделяет текст повторно. Тот же контракт используют project/workflow и pane-chip имена; filesystem folder выбирается целиком, а file сохраняет специальное выделение basename без extension.

### AI auto-title по первому пользовательскому prompt
Claude/Codex вкладка может получить человекочитаемое имя через встроенный prompt `tab-title` из Settings → AI. Prompt редактируемый пользователем; приложение только передаёт в Gemini первое **реальное** user-сообщение из Timeline/Codex rollout и применяет короткий ответ как название вкладки. Служебные команды (`#pack`, `#effort`, `#usage`, slash-команды модели/статуса/help/compact/exit и т.п.) не считаются первым prompt'ом — иначе вкладка получит название по настройке runtime, а не по задаче пользователя.

По требованию03.10 стандартный prompt даёт короткую узнаваемую тему, обычно1–3слова,
а не краткое содержание всех вопросов. Прежнее требование2–6слов провоцировало
«выбор массажа и терминология», когда пользователю нужна метка «массаж».
`\` или `/` отделяет только полезное уточнение (`history \ scroll`), `->` означает
направление (`yougile -> sc-desk`), не заменяет произвольный союз. Слова-процессы
и второстепенные вопросы не добавляются ради длины. Предпочтение32символам мягкое:
узнаваемое имя продукта не обрезается. Default общий для seed/migration/renderer;
точно прежний shipped text обновляется, собственные инструкции/model/name/files
сохраняются. Это не автоматическое переименование уже существующих вкладок.

Автоназвание — не постоянный watcher визуального Timeline, а одноразовый side-effect свежего запуска. При старте Claude/Codex launch-path сначала создаёт `AiLaunchSnapshot`, затем явно помечает его `autoTitleEligible`, и при первом materialized session id store армит transient pending `{tabId, toolType, sessionId}`. App-global `AutoTabTitleCoordinator` подписывает точную сессию через общий `SessionTranscriptService` и читает durable JSONL/rollout headless: открыта ли Timeline, видна ли панель и идёт ли сейчас длинный ответ, на именование не влияют. Pending живёт только в памяти: restore из БД, Cmd+Shift+T, app restart и обычный `--resume` не переименовывают старую вкладку.

Pending consume'ится только после terminal decision: успешного rename, manual-name skip, смены/очистки session id, закрытия вкладки, отклонённого запуска или другого честного terminal skip. Временного TTL до первого prompt больше нет: ответ может идти дольше десяти минут, а fresh-вкладка может оставаться фоновой сколько угодно. Gemini/API failure сам по себе не удаляет pending: сначала строится локальный fallback из первой содержательной строки prompt'а. Если ни AI, ни fallback не дают usable title, `generated-null` уже terminal skip. In-flight guard и trailing invalidation не дают параллельных генераций и не теряют append, пришедший во время чтения. Диагностический порядок: arm → coordinator subscribe → candidate → generator result/fallback → rename/skip → consume.

`nameSetManually` сильнее AI: если пользователь переименовал вкладку до запуска агента, auto-title не армится; если после arm — pending снимается сразу, а coordinator повторно проверяет имя и session id после чтения transcript и после генерации. ПКМ → `Обновить название` остаётся отдельным явным override через тот же headless reader, показывает per-tab loader и затем помечает результат как ручное имя.

Это относится и к переименованию ВО ВРЕМЯ запуска: старый `AiLaunchSnapshot`
не может снова армить auto-title или восстановить старое имя при отказе запуска.
Открытый inline input имеет приоритет над подписью подготовки на общей карточке;
после сохранения ручное имя видно сразу, даже если генератор названия ещё отвечает.
Без реального изменения текста unchanged blur/Enter по-прежнему не забирает ownership.
Сравнивать нужно с именем при открытии редактора, а не с текущим tab.name:
AI мог закончить генерацию, пока input оставался открытым без пользовательских
правок. Иначе blur восстанавливал старый draft как якобы ручное имя.

Прод-шрам `cli-tools-tab-635` (2026-08-21): intent и pending были корректно взведены, первый настоящий prompt появился в JSONL, History уже его прочитала, но visual Timeline получила только лёгкую пометку «сообщение отправлено» и отложила полный refresh с `reason=turn-busy`. Первый ответ шёл дольше прежнего 10-минутного TTL; следующая точка пришла уже после срока и лениво очистила pending как `expired`. Timeline была видима, session id совпадал — причиной был именно ошибочный ownership: продуктовый side-effect ждал presentation-кэш. Ремонт вынес именование в App-global coordinator; busy-gating Timeline сохранён, таймер не увеличен.

Шрам из production: fresh Codex вкладка `tab-2` получила session id `019ebbb1-76ef-79e1-a0ea-e2c4615742e0`, первый prompt был про настройку GPT-5.4/1M context, но auto-title не стартовал; ручное `Обновить название` сразу сработало и переименовало вкладку в `Настройка контекста 1М в Codex`. Логи показали, что запуск шёл через отдельный `ClaudeControlBar.startCodexTab`: `setTabCommandType` создал snapshot, но этот путь не вызывал `markAiLaunchAutoTitle`, поэтому `setCodexSessionId(..., reason:'detected')` не видел eligible snapshot и не армил pending. Любой новый launch-entrypoint для Claude/Codex обязан помечать auto-title eligibility там же, где он превращает pristine tab в AI tab; restore / обычный resume / повторное чтение Timeline, наоборот, не армят auto-title.

Практический аудит fresh launch entrypoint'ов: видимая кнопка Start в ControlBar — только один путь. Тот же контракт нужен для typed-intercept в Terminal, `pendingAction` `claude-new`/`codex-new` после `create_tab`/restore, external `createAgentTab(startNow=true)`, History runtime fresh-start и no-session `claude` chip в InfoPanel. Порядок один: сначала `setTabCommandType`, затем `markAiLaunchAutoTitle`, затем фактический запуск CLI. Если внешний caller передал явное имя вкладки, оно считается manual ownership (`nameSetManually=true`) и fresh auto-title не должен его перетирать.

UI-shortcut «сразу открыть вкладку с агентом» (ПКМ по пустому месту в списке вкладок → `Claude tab` / `Codex tab`) обязан делегировать этот контракт `pendingAction`, а не запускать CLI сам: второй launch-path гонялся бы с Terminal.tsx и стартовал два процесса в одном PTY. Такой shortcut передаёт только `pendingAction` + `color` (мгновенный визуальный отклик) + `skipInitialRename`; **`commandType` заранее ставить нельзя** — `setTabCommandType` переименовывает вкладку только на первом запуске (`isFirstRun = !tab.commandType`), поэтому предустановленный тип оставит `tab-N` вместо `claude-N`/`codex-N`. `skipInitialRename` обязателен по причине из третьего prod-шрама: unchanged имя, submit'нутое на blur inline-rename, засчитывается как manual ownership и блокирует auto-title. Проверено живьём: обе кнопки → `pendingAction` → `setTabCommandType` (`null → codex`/`claude`) → snapshot → `auto-title-eligible mode=fresh` → реальный запуск CLI до готового composer.

Сами строки создания — общий компонент `NewTabMenuRows.tsx`, который рендерят оба меню: пустое место списка вкладок (TabBar) и пустое место оконной полосы (PaneTabStrip). Подписи без слова «New» (`Terminal tab` / `Claude tab` / `Codex tab`); terminal-строка несёт иконку терминала (`SquareTerminal`) вместо «+», агентские — те же 11px квадратики бренд-цветов из `tabChrome.TAB_COLORS` (не хардкоженные hex). В sidebar-меню каждая строка разделена волосяной линией на две зоны: левая создаёт вкладку по умолчанию этого меню (в конец списка), правая узкая зона (28px, иконка окна) при наведении открывает тот же `WindowLayoutPicker`, что «Move to window», и клик по окну создаёт вкладку сразу в его полосу — `createTab({background: true})`, затем `addTabToSplitPaneStrip` (активирует размещение, как в `reopenLastClosedTab`; если выбранное окно исчезло за время создания — `activateCenterTab`, вкладка не теряется). Правая зона видна только когда есть настоящие окна (`splitPanes.length > 0`); в меню оконной полосы её нет вовсе — то меню уже принадлежит конкретному окну, и вопрос «в какое окно?» повторял бы ответ клика. Строка `New Group` переименована в `Group` и осталась только в sidebar-меню.

Четвёртый prod-шрам: Codex вкладка `019efa1f-1866-72c3-94a8-90d034d3e326` осталась `codex`, хотя первый `event_msg.user_message` уже был в rollout, `nameSetManually=0`, а ручное обновление названия могло бы сработать. Логи показали snapshot+intent, затем общий `terminal:mcp-ai-tab` первым записал тот же session id с `reason=unknown`; старый код армил pending только на `reason='detected'`, а последующий detector увидел уже записанный id и вышел как no-op. Защита: auto-title pending должен армиться по fresh snapshot/intent при первом materialized session id, а не по имени writer'а; явно ручные, restore/resume и edit-range записи session id по-прежнему не запускают автоназвание.

Fork — отдельный auto-title mode, не обычный resume. Новый fork-tab может сначала получить staging-name источника (`<name>_fork`), но первое **после-fork** user-сообщение заменяет его AI-названием. Общий headless selector для Claude выбирает первую eligible запись после fork-marker boundary; для Codex — после `session_meta`/`forked_from_id`, при известной границе по `sourceLine`. Visual Timeline использует тот же selector только для legacy recovery generic fork-name и передаёт найденный pending глобальному coordinator'у; второй генератор в UI не живёт. Скопированная родительская история не участвует. Повторное открытие существующего fork pending не армит.

Прод-шрам: Codex fork `019ec54c-6f18-78f0-8561-e90f3c7869ce` от `019ec218-e41c-7750-9ce1-536caf1b4e63` получил live prompt про «копирование id через контекстное меню», но имя не сменилось. Логи доказали, что boundary и candidate были найдены; сбой был дальше — Gemini ключ вернул leaked-key error, generator дал null, а старый lifecycle уже consume'ил pending. Вывод: при debug auto-title нельзя останавливаться на кодовом ощущении «boundary выглядит правильно»; нужно видеть всю цепочку arm/candidate/generator/consume. Local fallback из первого prompt'а допустим только как failure fallback для metadata, чтобы временная недоступность Gemini не превращала свежую вкладку в вечный generic title.

Второй prod-шрам: вкладка `019ebd84-a092-7f70-9dd9-be05e37b8a66` (`tab-1`, Codex, session id записался, первый prompt был отправлен) осталась с generic именем, хотя пользователь имя не менял; ПКМ `Обновить название` позже сработал. Трасса показала свежий tab в inline rename, затем клик запуска Codex: blur старого rename submit'ил unchanged `tab-1` как ручное имя, и auto-title skip'ался по manual guard. Защита двойная: TabBar сравнивает edit value с исходным и не вызывает rename на unchanged blur/Enter, а `renameTab` сам no-op'ит unchanged trim; auto-title arm логирует skip-reason (`manual-name`, `existing-session`, `no-snapshot` и т.п.), чтобы следующий такой случай не выглядел как «Gemini не вызвался без причины».

Третий prod-шрам: Codex вкладка `019ecf86-c525-7340-9012-bb8fef436701` получила имя `лаги навигации терминала`, хотя первый реальный prompt был про вход/пароль аккаунта. В rollout перед `event_msg.user_message` лежал bootstrap-блок `# AGENTS.md instructions for ...` как `response_item role=user`; старый/альтернативный parser мог протащить его в renderer как user-entry, и Gemini называл вкладку по проектным инструкциям, не по задаче пользователя. Защита должна жить на eligibility-слое auto-title: `AGENTS.md/GEMINI.md instructions for ...` никогда не считаются пользовательским prompt'ом, даже если upstream parser или legacy cache пометил их как `user`.

## User Flow: Жизненный цикл таба
1. **Создание в sidebar:** Пользователь нажимает `Cmd+T` при клавиатуре в sidebar или делает двойной клик на пустом месте TabBar. В оконной полосе тот же double-click и pane-owned `Cmd+T` сначала открывают место выбора без рабочей записи — см. `fact-рабочая-область.md::«Новая вкладка»`.
   - Система ищет первое свободное число для имени (`tab-1`, `tab-2`).
   - Новый таб наследует `cwd` текущего активного таба. См. `knowledge/fact-fact-terminal-core.md`.
   - **Сброс выделения:** При создании нового таба через `Cmd+T` или интерфейс, текущее множественное выделение вкладок автоматически сбрасывается.
   - **Switch to Terminal:** Если пользователь находится в Home View, нажатие `Cmd+T` или клик по любому табу в `TabBar` автоматически переключает вид на терминал.
   - **DnD & Focus Movement (Intelligent UX):** При перетаскивании активного таба на другой проект фокус приложения автоматически перемещается вместе с табом. Это предотвращает "состояние лимба", когда вкладка исчезает из `TabBar` в текущем проекте, но пользователь остается на пустом экране. **UX-психология:** Человеческий взгляд следует за объектом действия.
2. **Запуск процесса:** Пользователь вводит `npm run dev`.
   - Таб мгновенно переименовывается в `run-dev` (если не был переименован вручную — `nameSetManually`).
   - Цвет таба меняется на зеленый (если не был задан вручную — `colorSetManually`).
   - Появляется кнопка **Smart Restart (↻)** в левой части таба (Restart Zone).
3. **AI Сессия:** Пользователь вводит `claude`.
   - Таб становится оранжевым (`#DA7756`).
   - Кнопка Restart скрывается, так как для AI она не актуальна.
   - **Ручное имя сохраняется:** Если пользователь переименовал таб ДО запуска AI, имя НЕ перезаписывается на `claude`/`gemini`. Флаг `nameSetManually` (персистентный, хранится в БД) блокирует auto-rename в `setTabCommandType`.
   - **Откатывается только отклонённый запуск:** Пока main ещё не принял Claude/Codex launch, `AiLaunchSnapshot` позволяет вернуть прежние имя, цвет и роль. Если AI runtime был принят, но остановился до первой materialized записи, очищается только несуществующий session artifact; вкладка остаётся закреплена за выбранным AI. Stop, ошибка и restart не превращают её обратно в Blank/Terminal.

### Роль исполнения: Blank → Terminal либо AI

Эта машина описывает уже существующую рабочую вкладку. Оконная **«Новая вкладка»**
находится до неё: это сохраняемое место раскладки без tabId/PTY и строки sidebar.
Реальная вкладка появляется при выборе Terminal/агента; закрытие заготовки ничего
не архивирует. Старые Blank сохраняются вместе со своим shell и данными.

Обычный `tabType='terminal'` имеет три устойчивые роли без нового типа вкладки. **Blank** выводится из отсутствия AI-привязки, AI pending-action, `commandType` и terminal-автоматизации; разовая shell-команда временно занимает PTY, но роль не выбирает. **Terminal** закрепляется существующим `commandType='generic'`, `devServer` либо первой сохранённой Restart after-зависимостью. **AI** закрепляется принятой Claude/Codex/Gemini launch-меткой, session binding или `claude-sdk`; единственная session binding сильнее устаревшего `commandType`, конфликт нескольких binding закрывает и shell-, и model-actions до ремонта владельца.

Blank без foreground-команды показывает общий выбор Claude/Codex/Terminal. Явный Terminal сохраняет `generic` в той же вкладке; из оконной заготовки он создаёт такую вкладку. Оконные double-click/Cmd+T сами shell больше не создают. После Terminal исчезают AI-launch/model controls. После AI исчезают tab-context `Scripts` и command-history `Info`; обратно через `generic/devServer` AI-роль не понижается. Ручной запуск `claude`/`codex` в настоящем shell остаётся допустим: подтверждённый новый AI runtime повышает Terminal до AI, это не UI-откат.

## Шрам: вывод AI downgrade'ил commandType AI→devServer (2026-05)

**Симптом:** в зелёной (devServer) вкладке запустил `claude` или `codex` → Run-after оверлей не показывается, хотя AI активен; цвет/тип вкладки остался devServer. Для Claude после Stop+claude-c оверлей появлялся; для Codex симптом был тем же классом — старый зелёный контекст выигрывал у свежего AI запуска.

**Корень (прод-лог tab-700 15:23:26, детерминированно):** Claude, будучи живым, выполнял Bash-tool `npm run dev` и **рендерил в свой TUI** строку `⏺ Bash(NODE_ENV=development npm run dev > /tmp/dev8.log…)`. Enter-key handler в `Terminal.tsx` читает `getCurrentCommand(term)` и матчит `devServerMatch = /\b(npm|...)\s+(run\s+)?(dev|...)\b/i` — регекс попал на **вывод Claude**, не на shell-команду юзера → `setTabCommandType(claude→devServer)`. Оверлей Run-after гейтится `commandType==='claude'` (`isClaudeTab`) → стал false → оверлей пропал. `bufType=normal` потому что Claude Code работает в normal-буфере (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`), поэтому alt-buffer guard не ловил.

**Двойственность бага:** (1) тип вкладки **деградировал** от вывода живого агента; (2) при запуске AI в зелёной вкладке тип вообще **не менялся** на AI если детект не сработал или если старая строка `npm run dev` на экране матчилась раньше нового `codex`.

**Фикс (два слоя):**
1. **Guard против деградации.** Оба detection-блока (`initTerminal` + `reattach` в `Terminal.tsx`) проверяют синхронный `claudeProcessAliveRef.current` — пока AI-процесс жив, `getCurrentCommand` читает его **вывод**, не shell-команду, поэтому devServer/gemini/codex авто-детект **подавляется**. `claudeProcessAliveRef` — legacy-name, но теперь это общий alive gate для Claude/Codex overlay. Headless-проверка: вход `⏺ Bash(npm run dev…)` при claudeAlive=true → action=none ✓; `npm run dev` при shell → devServer ✓.
2. **AI-команды приоритетнее devServer-матча.** Если screen-line содержит и старый `npm run dev`, и новый `codex`, detector выбирает `codex` (`Codex → Gemini → devServer`), а не первый regex-match. Это закрывает зелёный-tab edge: запустить Codex после devServer должно превращать вкладку в Codex, даже если в xterm-буфере ещё виден предыдущий npm-текст.
3. **Promote зелёную вкладку → AI.** `handleSessionDetected` / fresh-PID paths зовут `setTabCommandType` на соответствующий AI runtime — когда bridge/PID/session watcher видит живого Claude/Codex, тип становится AI независимо от способа запуска (typed в зелёной вкладке, restore, claude-c/codex-c). **Guard от I/O-шторма:** `setTabCommandType` всегда делает `set(new Map)+saveTabs` (SQLite write); повторные sync-события вызывают промоут только если тип реально другой (иначе re-render+write storm, см. CLAUDE.md Zustand anti-pattern).

**Что НЕ откатывается:** после exit Claude/Codex с materialized session id вкладка остаётся AI-вкладкой (семантика «здесь была сессия», как `claudeSessionId` / `codexSessionId` persist'ит для resume). Цвет/имя зелёной вкладки при promote НЕ перезаписываются (`color='green'` уже set, `shouldAutoColor` false; auto-rename только на `isFirstRun`). Исключение — запуск, остановленный до записи transcript/session id: он откатывается по snapshot'у как несостоявшийся, иначе пользователь получает Continue на UUID, которого CLI потом не находит.

См. [`fact-prompt-queue.md`](fact-prompt-queue.md) (гейт оверлея), [`fact-claude-stop-hook.md`](fact-claude-stop-hook.md) (OSC/bridge alive-сигналы).
4. **Управление:** 
   - Пользователь делает правый клик (ПКМ). Открывается меню: **Close Tab** -> **Rename** -> **Color** (подменю).
   - Двойной click по обычной terminal/session-вкладке включает inline rename. Если вкладка до первого click была неактивна, первый click одновременно переключает её и остаётся первой половиной нативного `dblclick`; предварительный `isActive` не является условием. Linked file-tab исключён: его имя принадлежит файлу и меняется через file explorer.
   - **Multi-Select:** `Shift` использует активную вкладку как anchor. Пока клавиша удерживается, hover другой видимой строки мгновенно подсвечивает точный диапазон; `Shift+Click` фиксирует ровно этот block, а скрытые строки collapsed-групп не добавляются. `Cmd+Click` toggl'ит отдельные вкладки. Preview и commit используют один `resolveTabRangeSelection`; старое выделение заменяется, иначе последующий drag унёс бы невидимые остатки прошлого набора. Контекстное меню адаптируется, скрывая инструменты переименования. См. [`knowledge/fact-data-persistence.md`](knowledge/fact-data-persistence.md).
       - **Multi-Tab DnD:** Выделенные вкладки можно перетаскивать группой. При перетаскивании на другой проект в Title Bar появляется кастомный превью-индикатор с бейджем `+N`, показывающим количество переносимых вкладок.
       - **Group Close:** Если выбрано несколько вкладок:
           - Нажатие `Cmd+W` закрывает всю группу.
           - Клик колесиком мыши (middle click) по любой *выделенной* вкладке закрывает всю группу.
           - Клик колесиком по *невыделенной* вкладке закрывает только её, сохраняя остальное выделение.
       - **Favorites:** Пользователь может сохранить конфигурацию таба (путь, имя, цвет, AI-сессию) в «Избранное» через контекстное меню таба или терминала. Избранные табы отображаются в Home View.
       - **Сброс выделения:** Клик вне области `TabBar` (например, по терминалу или боковой панели) автоматически снимает множественное выделение.
       - Клик по обычной вкладке desktop reserve добавляет chip фокусного окна, сохраняя прежние; существующее место раскрывается без дубля. Средний клик остаётся явным add-here. Левый по linked-file row в sidebar/popup открывает reader у владельца, средний — файл сбоку. На чипе оконной полосы middle-click — `Убрать` только этот placement. Полное удаление остаётся явным `Close Tab`/`Full`; RestartZone по-прежнему перехватывает middle-click для остановки процесса.
   
   ## User Flow: Управление проектами
   
Вкладки проектов в шапке приложения ведут себя аналогично терминальным табам.
- **Drag-and-Drop:** Пользователь может перетаскивать проекты для изменения их порядка.
- **Empty Zone:** При наведении на пустое место справа от проектов, индикатор перемещения прилипает к последней вкладке.
- **Индикаторы:** project-row всегда показывает серый круг с общим числом вкладок project. Синий interrupted-счётчик (число приостановленных сессий на project-row), красный completion и purple awaiting остаются отдельными сигналами. На уровне самой вкладки interrupted больше не рисуется: синяя пунктирная рамка удалена 2026-09-11 вместе с плашкой `SESSION INTERRUPTED` (см. `fix-interrupted-session-lifecycle.md`). Runtime activity живёт уровнем выше.
- **Workflow activity:** зелёный круг = число канонически размещённых в этом workflow вкладок с живым PTY/SDK process; отдельный статичный оранжевый круг = число этих же вкладок с текущим turn/paste/orchestration loader. Directory-project не назначает адрес индикатора: чужая project-вкладка следует своему реальному окну, а unplaced tab остаётся busy только в sidebar. Один tab законно участвует в обоих числах — это независимые вопросы. См. [`fact-process-bar.md`](fact-process-bar.md).
- **Project/workflow icons:** workflow и project surfaces показывают свои исходные цветные PNG без display-desaturation. Проект без custom raster использует цветную папку, поэтому «Только значок» доступен всегда и не создаёт пустую карточку. ПКМ по project tab открывает общую Settings → Проекты surface. Детали — `fact-workspace.md::Project + Workflow Icons`.
- **ContextMenu:** `ID` копирует внутренний id вкладки (`tab.id`); `UUID/Path` — UUID сессии (`claudeSessionId`/`geminiSessionId`/`codexSessionId`) и прежний `cwd:`. Если UUID ещё нет, нельзя подставлять `tab.id`. Соседние кнопки вставляют ID в Voice Record; см. раздел «ID вкладки: копирование и вставка в Voice Record».
- **Контекст-меню single-tab:** явное открытие существующей вкладки доступно на трекпаде, без middle-button:
    - Sidebar row 1: `[Open beside]` + `[Close Tab]`, где Close полностью удаляет вкладку.
    - Pane-chip row 1: `[Open beside]` + единый split-control `[Убрать | Full]`. `Убрать` снимает только чип этого окна и сохраняет вкладку в sidebar; `Full` запускает тот же полный close, что sidebar. Это два соседних `<button>` в одной визуальной половине, не вложенная кнопка. `Full` — полноценная зона шириной 46px с собственным destructive hover, а не маленький декоративный бейдж.
    - Затем: `[Rename]` + `[■ Stop Claude/Gemini/Codex]` или `[● Stop <script>]`.
    Дальше — Color/Collapse/Scripts submenu и Copy/Favorites как раньше.
    `add new` удалён10.10 по выбору пользователя: создание уже доступно через +/пустую область; object-menu адресует существующую вкладку. `Open beside` также присутствует в отдельной file-tab ветке и файловом explorer. Новый provider/runtime не создаётся; команда идёт в прежний общий window writer через Root.
    **Цвет полного Close — только текст в покое.** `Close Tab`/`Full` используют `#f87171`; красный wash появляется только на hover компактного `Full`. Постоянный bg-fill сделал бы Close семантически однородным со Stop Script (`#dc2626`), хотя Stop оставляет таб живым, а Full уничтожает.

    **Stop pill всегда рендерится — disabled-серый когда нет процесса.** Раньше Stop был conditional (виден только при running CLI), grid визуально разваливался: первая строка превращалась в `[+ add new]` на всю ширину, divider съезжал относительно второй строки `[Rename | Close Tab]`. Сейчас вторая половина рендерит disabled-Stop (`#444` точка, текст `Stop` цветом `#555`, `cursor: not-allowed`, tooltip *«No active process to stop»*) — строка Rename/Run/Stop геометрически стабильна независимо от состояния процесса. Это переносимый принцип: см. `methodology/сценарии-багов-design.md::Чек-лист` про слот-стабильность контролов в grid.

    **Симметрия колонок через `flex-1 basis-0`.** Четыре внешние ячейки получают `flex-1 basis-0 min-w-0` — главный divider строго по центру меню независимо от длины лейбла. Внутри правой ячейки допустим собственный компактный divider `Убрать | Full`: фиксированная hit-area `Full` съедает место только у соседнего `Убрать` и не двигает центральную ось grid. До этого отдельные top-level rows получали свой `4:1` ratio и визуально уводили общую вертикальную черту; внутренний scope-split этого не делает.
- **Split Close+Stop (multi-select fallback):** При Shift-выделении нескольких табов меню вырождается обратно в одну строку `[Close N Tabs] [■ Stop N]` без Rename/+add new (они не имеют смысла для batch'а). Правая часть SIGTERM'ит CLI-процессы не закрывая табы; цвет фона подсказывает кому именно адресован сигнал (Claude `#DA7756`, Gemini `#4E86F8` — те же канонические цвета что в TAB_COLORS и Provider row InfoPanel). **Почему SIGTERM, не двойной Ctrl+C:** Ctrl+C в PTY зависит от состояния Ink TUI (dropdown, danger-zone «again to exit», picker model/effort, thinking spinner — каждое реагирует по-своему), и требует guessing prompt-текста для второго нажатия. SIGTERM по PID минует Ink целиком — kernel доставляет напрямую, Claude корректно сбрасывает JSONL и выходит за ~600ms; SIGKILL fallback через 800ms если процесс завис. PID находится BFS-ом один уровень вглубь от shell-PID (нескан вглубь намеренно — внутренние bash-tool/MCP-children не убиваем, они каскадно очистятся после exit парента). Для bash/dev-server scope не расширяем: у dev-server уже есть middle-click Stop в RestartZone (зелёная точка), у bash нет graceful stop hook.

- **Multi-select Stop с majority badge:** При Shift-выделении нескольких табов в той же split-кнопке показывается счётчик AI-табов, с разделением majority/minority. Подсчёт идёт **только по табам с running процессом** (`processStatus.get(id)`) и `commandType === 'claude' | 'gemini' | 'codex'` — bash/dev-server/idle AI-табы пропускаются. Цвет базы = majority-тип; badge `+N` рядом — minority в другом цвете. Примеры: 2 Claude + 1 Gemini → оранжевая кнопка `Stop 2` + синий `+1`; 1 Claude + 2 Codex → зелёная кнопка `Stop 2` + оранжевый `+1`; 1 Claude + 1 Gemini + 1 Codex → база по первому majority sort, tooltip обязан перечислить все типы. **Мотивация (Invisible Intent):** при batch-операции пользователь видит на одной кнопке (а) сколько процессов реально умрёт (`majorCount + minorCount` через сумму), (б) разнородность — что в выделении есть Claude/Gemini/Codex табы, не однотипный набор. Без такого визуального разделения пользователь может думать что Stop трогает только майоритарный тип, и удивиться когда minor-AI тоже умрёт. Сигналы посылаются параллельно (`Promise.all`), main обрабатывает grace+escalation per PID — итоговое время = max(per-process), не sum.

- **Split Close+Stop для script-табов** — расширение того же паттерна на devServer / bash с живым PID **не**-AI типа. Mutex с AI-веткой: если в target табах есть claude/gemini/codex → показывается AI-Stop (SIGTERM по PID); если только scripts → script-Stop. Tint **cherry-red `#dc2626`** — намеренно НЕ совпадает с зелёным running-dot слева от имени таба. Раньше тут был зелёный (`#4ade80`, тот же что у running-dot) с обоснованием «зрительная связь с дотом» — отвергнуто живым use-case'ом: пользователь читал зелёную Stop-кнопку как продолжение/подтверждение «процесс жив», а не как destructive action. Принцип: см. `methodology/дизайн-принципы.md::Destructive action ≠ цвет status-indicator`. Stop Claude / Stop Gemini / Stop Codex остаются на engine-tints (orange `#DA7756` / blue `#4E86F8` / green `#10A37F`) — там destructive-семантика передаётся через явный лейбл `Stop` + квадратную точку (квадратная = stop-button иконография, отделяет от круглой running-dot формы). Форма точки у script-Stop осталась **круглая с glow shadow** — невербально отделяет от AI-стопа. **Killing path — Ctrl+C через `terminal:input`**, не SIGTERM. Причина: zsh/bash forwards SIGINT в foreground process group → npm/vite/dev-server корректно ловят → graceful exit + cleanup. SIGTERM по PID лишний — у shell нет TUI state-чувствительности как у Claude. Дополнительно если **kill dev-ports** toggle включён (см. `fact-statusbar-toggles.md`), после Ctrl+C инжектится видимая shell-line `lsof -ti:PORTS | xargs kill -9` — Ctrl+C только foreground убивает, а leak'нутые children (vite preview server detached, electron-fork) могут продолжить держать порт. Старая "Stop: <name>" entry в Scripts submenu удалена — теперь единственная точка через split-pill в title row.

## Behavior Specs
- **Horizontal Scroll:** Таб-бар поддерживает прокрутку колесиком мыши без зажатого Shift. Используется `onWheel` с `{ passive: false }` для корректного предотвращения нативного скролла.
- **Auto-Scroll:** При переключении или создании вкладок система автоматически прокручивает `TabBar` так, чтобы активная вкладка всегда была видна. При перетаскивании таба к левому или правому краю также срабатывает автоматический скролл. Используется `@atlaskit/pragmatic-drag-and-drop-auto-scroll`.
- **Gap Separation:** Между вкладками используется физический разрыв `gap-[1px]`, что предотвращает слипание индикаторов активности и рамок при наведении.
- **Stable Resizing:** Размер терминала подстраивается под контейнер через `ResizeObserver`. Реализована защита от stale closure и **Idempotent Resize** (запрет отправки `SIGWINCH` в PTY, если размеры не изменились), что критично для стабильности AI-интерфейсов при переключении вкладок. См. [`knowledge/fact-fact-terminal-core.md`](../knowledge/fact-fact-terminal-core.md).
- **LRU Navigation:** Проект сохраняет последнюю живую вкладку как навигационный fallback, но это не владелец рамки окна. Если `Убрать` или full-close удалил показанный чип, pane остаётся пустой и сфокусированной даже при наличии других припаркованных чипов; ни история, ни сосед не включаются автоматически. Для `Ctrl+Tab` такой placeholder имеет `anchor=null`, поэтому первое нажатие выбирает свежую невидимую вкладку и заполняет именно этот слот, а не пропускает её из-за project-level `activeTabId`.
- **Unified Multi-Close:** При закрытии группы выделенных табов система собирает информацию обо всех активных процессах и показывает ОДНО окно подтверждения со списком, вместо серии отдельных алертов. Каждый `closeTab` в цикле вызывается с `forceCleanup: true`, чтобы safety guard не блокировал удаление при последовательном закрытии 3+ табов.
- **Full close и placement removal — разные операции.** Sidebar `Close Tab`, pane-menu `Full`, sidebar-owned `Cmd+W` и multi-select заходят в один durable `closeTab` с одинаковым live busy-снимком. Pane-owned `Cmd+W`, pane-menu `Убрать` и middle-click по чипу только меняют placement и не останавливают процесс. Оба scope оставляют показанное место vacant; разница только в том, продолжает ли сама вкладка жить в sidebar.
- **Подтверждение — нативный macOS sheet, не `window.confirm`.** `window.confirm` блокирует renderer-поток целиком: вывод терминала, лоадеры и заголовок вкладки замирают за диалогом, что читается как зависшее приложение именно в момент destructive-действия. Диалог показывается из main через `ui:confirm-destructive` как sheet у окна; `Enter` подтверждает, `Escape` отменяет. Fail-closed обязателен: недоставленный диалог возвращает «отмена» и НЕ авторизует закрытие.
- **Статичный pending-маркер на месте названия вкладки показывается для любого закрытия, которое кого-то останавливает** (`aiClosing`: оранжевый квадрат + `остановка сессии...`), а не только когда останавливается агент. Плавный Ctrl+C с flush занимает до ~1.2 с, и вкладка, которая после клика просто стоит на месте, читается как «закрытие не сработало» — именно так и был отрепорчен сломанный Codex-путь. Вращение не добавляет доказательства прогресса и при renderer stall само замирает; при недоказанной остановке marker снимается вместе с сохранением вкладки и PTY.
- **Плавное закрытие обязано покрывать Codex.** Ранее graceful-ветка в `terminal:kill` требовала Claude bridge-файл и искала процесс инлайновым `ps | grep -E " (claude|gemini)( |$)"`. Для Codex это было структурно недостижимо: у него нет bridge, его wrapper выглядит как `node …/codex` или содержит `@openai/codex`, и он часто сидит на уровень ниже shell — то есть busy-turn Codex уходил сразу в SIGHUP и терял незаписанный rollout. Признак живости Codex берётся из rollout-watcher (тот же источник, что у лоадера), а поиск процесса — из общего lookup AI-потомков, который уже знает и форму wrapper'а, и depth-fallback. Не заводить второй inline-скан: любой новый agent-runtime иначе снова окажется вне graceful-пути.
- **Close warnings для AI tabs:** наличие `claudeSessionId` / `geminiSessionId` / `codexSessionId` само по себе не причина для confirmation dialog. Idle Claude PTY, Claude SDK, Gemini и Codex закрываются сразу: session id означает историю/Continue, а не живой риск. Warning появляется только когда AI реально busy/streaming (`aiBusy`, `claudeBusy`, `sdkState`) или когда во вкладке запущен обычный foreground process не-AI типа (`npm run dev`, script, bash child). Native mobile Delete использует тот же `closeTab` bridge, но передаёт `aiBusyOverride` из своего runtime-снимка: телефон спрашивает confirmation на активном streaming/busy tab, затем сервер закрывает вкладку тем же desktop close-path. При закрытии живого AI foreground без warning всё равно выполняется graceful stop перед PTY kill, а title временно становится `остановка сессии...`, чтобы пользователь видел что close ждёт flush/teardown. Для Codex проверка foreground-AI обязана смотреть не только `comm`, но и full command-line из `terminal:hasRunningProcess`: wrapper часто выглядит как `node /opt/homebrew/bin/codex` или содержит `@openai/codex`, и без command-line idle/AI/script ветки перепутаются.
- **Silent Tab Closure (skipProcessCheck):** Программные инструменты автоматизации используют флаг `skipProcessCheck: true` в `closeTab()` для бесшовного полного закрытия с активными процессами без диалоговых окон. Обычный пользовательский full-close при доказанном риске спрашивает подтверждение; placement-only `Убрать` ничего не останавливает и подтверждения не требует. Принцип переносимый — см. `methodology/дизайн-принципы.md::Silent automation cleanup`.
- **Встроенная browser-вкладка удалена (2026-08-17).** Был тип вкладки `browser`: половина — обычный терминал, половина — встроенная страница в `webview`, с перехватом ссылок из логов dev-сервера и «умным» Refresh. Ею не пользовались, а живой браузер живёт снаружи и управляется через MCP. Удалены компонент, тип вкладки, действия в сторе, кнопка в тулбаре и право `webviewTag` у окна. Старые записи в базе (`tabs.tab_type='browser'`, история закрытых) при чтении приводятся к обычному терминалу — колонки `url`/`terminal_id`/`terminal_name`/`active_view` остаются в схеме пустыми, их просто перестали читать. Закреплено `components/Workspace/toolbarSurfaceRemovals.wiring.test.mjs`.
- **Persistent Naming:** Тип команды и уникальный `tab_id` сохраняются в БД, что предотвращает сброс кастомных имен и разрыв ссылок на вкладки при перезапуске. См. [`knowledge/fix-tab-persistence.md`](../knowledge/fix-tab-persistence.md).
- **Safe Persistence:** Метод `saveTabs` использует targeted DELETE по `tab_id` вместо `DELETE ALL`. Включён safety guard: если количество табов резко уменьшается (>2), удаление "лишних" записей из БД пропускается и логируется ошибка. Это защищает от потери табов при неполном in-memory Map. См. [`knowledge/fix-save-tabs-data-loss.md`](../knowledge/fix-save-tabs-data-loss.md).
- **Activity Throttling:** Терминал считается активным только в том случае, если текущий вид (`currentView`) установлен в `'terminal'`. Это предотвращает лишнюю нагрузку и конфликты, когда пользователь находится в Dashboard или полноэкранном редакторе заметок.
- **Tab History (закрытые табы на Dashboard):** При закрытии таба запись добавляется в `tab_history` через `archiveTab`. Каждое закрытие = новая запись. Restore из Dashboard идёт по `id` записи (юзер кликает конкретную карточку), не по имени. В split-mode **Shift+Cmd+T** выбирает более новое из локального «Убрать» и Full того же окна; проект sidebar и способ закрытия не задают приоритет. После исчерпания обоих источников окна остаётся прежний project-wide архивный fallback. Архивная запись удаляется только после создания и durable save восстановленной вкладки. Home и архивная половина хоткея используют общий flow; ошибка сохраняет history-row и показывает причину. Учитываются позиция вкладки, группа и `processWasRunning` для консервативного auto-Continue по хоткею. Close и reopen считаются structural layout change для native clients: после успешного `saveTabs` renderer шлёт `project:layout-changed`, а телефон перезагружает `/tabs` после quiet-window. См. [`fact-reopen-last-closed-tab.md`](fact-reopen-last-closed-tab.md).

    **Ловушка для пользователя — клон-таб с чужой сессией:** Карточки в Tab History показывают только имя + папку, не sessionId. Если у таба менялся `claudeSessionId` (форк создал новый sessionId, потом таб закрылся, потом снова открыли и закрыли) — в истории накапливается несколько записей под **тем же именем** с разными sessionId. Юзер кликает первую попавшуюся → восстанавливается старая сессия вместо актуальной форк-копии. Симптом: "у меня два таба-клона, у них одна история, хотя должна быть разная". Решение на уровне UX (показывать sessionId в карточке) пока не сделано.

    **Отброшенный подход:** дедупликация через `DELETE FROM tab_history WHERE project_id=? AND name=?` перед INSERT. Нельзя — имя таба не уникальный ключ. У юзера нормально иметь несколько табов с именем "claude", "bash", "gemini" в одном проекте. DELETE WHERE name= уничтожал бы валидную историю несвязанных табов.
- **Cross-Project Move (Multi-Tab):** Вкладки (одна или несколько) могут быть перетащены на любую вкладку проекта в Title Bar.
    - Логика: `moveTabsToProject` в `useWorkspaceStore`.
    - PTY процессы сохраняются, меняется только привязка к проекту в БД.
    - **forceCleanup:** При переносе 3+ табов `saveTabs` вызывается с `forceCleanup: true`, обходя safety guard (иначе guard блокировал бы удаление «перенесённых» записей из source project).
    - Визуальное затемнение: При перетаскивании все вкладки, входящие в группу переноса, получают `opacity: 0.5`.
- **Sync:** Порядок проектов сохраняется в `Map` внутри `useWorkspaceStore`.
- **Title Bar Integration:** Пустая зона для дропа (`ProjectEmptyDropZone`) поддерживает `WebkitAppRegion: drag`, когда не активен процесс перетаскивания, позволяя двигать окно приложения за шапку.


## Vertical mode (TabSidebar)

Полностью закрытой считается вкладка, отсутствующая во всех окнах и sidebar/
reserve всех workflow. `Убрать` из окна её не закрывает. Retention17.10 после
настроенного срока (default24h) потребляет её restorable History entry, включая
пустую/без JSONL: Shift+Cmd+T и explicit restore не возвращают истёкшую запись.
Минимальная FK source row нужна сохранённому RAG; это не рабочая вкладка и не
основание оставить строку в History. Actual conversation deletion по-прежнему
защищает нужные открытым веткам файлы. См. `fact-хранилище-сессий.md`.

Метка размещения справа от имени — общая карта окон TabPaneMap. Чужой workflow
узнаётся по его иконке9×9px из верхней полосы; без картинки — буквенная плитка
того же workflow, а не порядковый номер. Поэтому перестановка workflow не
меняет визуальное имя места. Фиксированный слот сохраняется и у локальной
вкладки. Полный контракт — `fact-рабочая-область.md::Карта окон отвечает ещё и «в каком пространстве»`.

Permanent left sidebar шириной 140-400px (drag-resize handle на правом краю, default 200, `tabSidebarWidth` в профиле текущего дисплея; старый localStorage остаётся источником миграции). Все вкладки одинаково растягиваются на 100% ширины колонки. Тот же TabBar.tsx-компонент через `layout='vertical'` prop.

Drag ширины двигает только DOM внешней колонки, показанного списка и его
верхней строки инструментов. Store/профиль дисплея получают один итог на
pointerup. Общий с перегородками freeze удерживает размеры тяжёлого содержимого
всех затронутых retained окон, включая скрытые, и одиночного центра; release
после синхронного commit запускает настоящий reflow и прежний History anchor.
Resize не выбирает sidebar владельцем клавиатуры. Escape, blur, cancel/lost
capture, unmount, смена workflow/структуры окон/проекта или профиля дисплея
отменяют preview без сохранения промежуточной ширины. Подробности общей
геометрии — `fact-рабочая-область.md::Перегородки панелей перетаскиваются`.

### Keyboard focus — отдельный owner, не activeTabId

Левый sidebar и конкретная pane — два явных владельца tab-команд. Последний
left-click задаёт transient `activeArea` (`sidebar | workspace`); верхняя полоса
проектов остаётся третьим scope `projects`. Один чистый
`resolveKeyboardFocusTarget` используют и `Cmd+T`, и `Cmd+W`:

- sidebar `Cmd+T` создаёт обычную durable строку после visual subtree, с inline
  rename, но без pane placement;
- pane `Cmd+T` добавляет в названное окно заготовку без рабочей записи/PTY;
- pane `Cmd+W` убирает показанный чип: для заготовки это удаление места без архива,
  для настоящей вкладки — прежнее снятие размещения; если pane опустела, она сохраняет
  keyboard focus и следующий `Cmd+W` ничего не делает;
- sidebar `Cmd+W` закрывает sidebar target/selection;
- commit Ctrl+Tab/Cmd+P переводит owner в `workspace`, потому что результатом
  жеста является показанная pane.

Focus обязан быть видимым: sidebar получает правую focus-линию, pane-frame и
shown chip приглушаются. Git+split нефокусной pane скрыты в обоих режимах:
горизонтальный strip хранит их ширину внутренним reserve, а wrap оставляет
невидимый блок в потоке, поэтому число строк не меняется. `⋮` остаётся видимым.
Geometry resize не запускает auto-reveal: иначе
ручной `scrollLeft` сбрасывался при одном только переходе фокуса. Chip/overflow
badge рядом с меняющейся границей откладывает pane-focus до завершённого click,
чтобы target не уехал между pointerdown и mouseup.

### Подсветка активной вкладки требует, чтобы центр был в ЭТОМ проекте

Список показывает вкладки проекта бокового меню, а центр может показывать вкладку другого проекта (`fact-рабочая-область.md::Центр и проект — две независимые оси`). Поэтому «активная» строка подсвечивается только когда проект центра совпадает с проектом списка; иначе в чужом списке светилась бы вкладка, которой на экране нет. То же условие действует для visual-parent связей и для пункта «Добавить в рабочую область» (он сравнивает клик именно с вкладкой центра, а не с последней активной вкладкой этого проекта).

Клик по вкладке идёт через единую точку активации центра (`activateCenterTab`), а не через связку «переключить вкладку + переключить вид». Через ту же точку проходят переключатель `Ctrl+Tab`, фокус панели сплита и возврат после закрытия вкладки — иначе каждый вход получил бы свою версию правил про сплит, показ строки в списке и смену вида.

Единственное исключение — чип вкладки в шапке панели: он вызывает «перейти на вкладку И в её проект» (`activateTabAndProject`), потому что панели межпроектные и это единственная поверхность, называющая вкладку чужого проекта. Отдельный путь, а не флаг у общей активации. Подробнее: `fact-рабочая-область.md::Клик по вкладке в шапке ведёт и в её проект`.

### Scroll списка вкладок принадлежит проекту и переживает перезапуск

Вертикальный scroll списка вкладок хранится per-project в SQLite (`projects.tab_list_scroll_top`), тем же контрактом, что и scroll файлового sidebar: mutate workspace in place без `set()` (scroll не должен ре-рендерить подписчиков), throttled запись через общий `scheduleScrollSave`, чтение при открытии проекта. Две поверхности используют одну throttle-машину, но разные ключи (`sidebar:` / `tabList:`), иначе scroll дерева и scroll вкладок схлопывались бы в одну запись.

Колонка TabSidebar **не** размонтируется при переключении проектов — тот же scroller переиспользуется, поэтому restore нельзя вешать на mount: arm живёт на смене `projectId` и обязан идти перед apply-эффектом (эффекты выполняются в порядке объявления).

Присвоение `scrollTop` одноразовым эффектом не работает: в момент, когда React уже отдал строки, список ещё не имеет высоты (`scrollHeight === clientHeight`), и браузер clamp'ит значение обратно в 0 — прод-шрам, где сохранённые 640 превращались в 0 при каждом возврате в проект. Apply повторяется по `ResizeObserver` (event-driven сигнал «layout реально изменился», не polling и не таймаут) и снимает arm только когда список стал достаточно высоким, чтобы вместить сохранённое смещение.

Персистится только scroll, который сделал пользователь: capture-хендлеры (`wheel`/`pointerdown`/`touchstart`/`keydown`) передают ownership человеку, layout-driven scroll во время монтирования игнорируется. Без этого разделения каждое переключение проекта сдвигало сохранённое значение на 1-2px, и позиция медленно уползала (замерено: 727 → 725 → 723 → 720). Пользовательский scroll всегда сильнее ожидающего restore: касание списка сразу отменяет pending-восстановление.

### Активность через bg-saturation, не top-border

В горизонтальном TabBar активность кодировалась `border-top: 2px solid ${borderColor}` сверху таба. В vertical mode это плохо: занимает 2px из дефицитной вертикали в плотной колонке, и читается как самостоятельный визуальный язык (selected=dashed-white всё ещё использует border — путаница; interrupted=dashed-blue удалён 2026-09-11 целиком).

Решение — активность через alpha-step фонового цвета самой вкладки. PTY claude (saffron orange):
- inactive 0.20 alpha → `#49352F` на `#252526` panel
- hover    0.28 alpha → `#5C3F35`
- active   0.45 alpha → `#764A3C`

SDK claude (terracotta):
- inactive 0.30 alpha → `#664F42`
- hover    0.38 alpha → `#76594A`
- active   0.55 alpha → `#9D7359`

Hover-step для SDK выше чем для PTY (`+0.08` vs `+0.08`, но от более высокой базы) — SDK не имеет PTY-bar в качестве дополнительного активности-сигнала, поэтому весь акцент состояния идёт через alpha. Не путать с inactive-step: раньше неактивные coloured tabs дополнительно дамперились (`base - 0.10`) чтобы активная вкладка доминировала; юзер три итерации репортил *«не яркость, а прозрачность — даже когда вкладка неактивна, цвет должен быть более яркий»* — дампер убран, inactive теперь равен **прошлому hover'у**, hover поднят отдельным `+0.08` step'ом.

Для uncoloured (browser tabs, новые fresh tabs) — белая подложка 4% inactive → 12% hover → 20% active. **Полностью transparent inactive запрещён**: вкладка сливается с панелью, граница теряется. Минимальный alpha-floor 4% обязателен. См. `methodology/дизайн-принципы.md::Активность через насыщенность фона`.

### SDK claude — distinct hue от PTY claude

PTY claude tabs используют saffron `#DA7756` (brand-tint Claude). SDK tabs тоже `color: 'claude'` в данных, но отдельный override в TabItem chrome: `bgColor: rgba(210, 140, 90, 0.30)`, `borderColor: '#D28C5A'` — терракотовый, явно жёлтее/светлее saffron. Юзер: *«вкладки SDK я вообще не могу различать с PTY, они слишком тусклые»*.

**Что пробовали и почему не сработало:**
- Peach `rgba(255, 178, 130, 0.14)` (изначальный SDK override) — слишком светлый, при active 0.39 alpha белый текст сливался с фоном. Контраст ≈ 4.0, на границе читаемости.
- Peach `rgba(255, 178, 130, 0.30)` — alpha подняли, контраст inactive стал ок, но юзер: *«белый цвет сливается с ним даже когда вкладка активная»*. Корень: подняли только alpha, RGB остался `(255,178,130)` — слишком близкий к белому (`#FFB382` light salmon). При наложении на panel с alpha 0.55 итог уходит в светлую область где белый text contrast падает.
- Финал terracotta `rgba(210, 140, 90, 0.30)` — изменили RGB, не alpha. `(210,140,90)` = `#D28C5A` (тёплый коричнево-янтарный), контраст с белым текстом ≈ 5.7 на любом alpha-step. PTY (более красно-рыжий saffron `#DA7756`) vs SDK (более жёлто-коричневый terracotta `#D28C5A`) отличаются **тоном**, не только насыщенностью — на одном `#252526` фоне глаз ловит «два разных runtime'а» без необходимости запоминать какой ярче.

### Два независимых индикатора активности

PTY-процесс жив (claude CLI запущен, npm run dev, bash, gemini/codex CLI) или SDK runtime жив → 3px `tab-process-bar-static` у края вкладки. AI «думает»/стримит (`claude:busy-state` / `gemini:busy-state` / `codex:busy-state` / `claude-sdk:busy-state`) → `tab-process-bar-ai-shimmer-overlay` внутри этой же полоски. Сосуществуют независимо:

- PTY claude в думанье → оба активны (base strip + shimmer)
- SDK claude в думанье → SDK process-alive strip + shimmer
- npm run dev → только bar
- idle taб → ни одного

См. `methodology/дизайн-принципы.md::Два независимых сигнала на одной зоне` (почему нельзя через OR) и `knowledge/fact-process-bar.md` (полная конфигурация bar).

### Configurable session statuses

Status marker 8px (dot или square, sizePx 4..16) рисуется absolute на `left: 5px`, `top: calc(50% + 1px)` слева от текста. `+1px` к геометрическому центру — оптическая компенсация baseline-шифта строчных букв в названиях табов (`claude-03`, `tab-1`, `bash` — все без descender'ов, текст «садится» чуть ниже геометрического центра контейнера). Без сдвига маркер кажется немного выше текста. См. `methodology/дизайн-принципы.md::Baseline-шифт оптической центровки`.

Назначается через ПКМ → Status submenu. Список статусов полностью кастомизируется юзером в Settings → Системные (label, hex, добавление, удаление). Tab.sessionStatus хранит **id** статуса, не label — переименование сохраняет ассоциацию. Удаление статуса не чистит Tab.sessionStatus (graceful degrade: возврат статуса с тем же id оживляет все вкладки). Подробности — `knowledge/fact-session-status.md`.

ПКМ Status submenu имеет preview трёх первых статусов inline справа от лейбла `Status ›` — юзер видит «вот эти точки это про статусы» без открытия submenu. См. `methodology/дизайн-принципы.md::Submenu trigger показывает preview содержимого`. Toggle-семантика: повторный клик по активному статусу снимает его. Color submenu из ПКМ удалён — юзер не использовал.

**Сторона раскрытия вложенных списков считается, а не записана.** Меню открывается у курсора и вжимается в окно, но вложенные списки живут правее строки, которая их открыла: у правого края «Move to window», история команд и Scripts уезжали за границу приложения. Сторона решается один раз на всё меню — после вжатия root'а, по уже вычисленным координатам, и по самому широкому из вложенных списков (280px — история команд). Один предмет = один ответ: соседние строки, раскрывающиеся в разные стороны, заставляли бы искать список заново на каждой. Стрелка строки следует за решением (`›` / `‹`) — она обещает направление, и обещание обязано совпасть. Правило и расчёт — `utils/submenuSide.mjs`, общий принцип — `methodology/сценарии-багов-design.md::1.5`.

### Revert Session submenu

ПКМ → «↶ Revert Session ›» появляется только на claude-табах, у которых непустой `tab.claudeSessionHistory` (последние до 5 предыдущих значений sessionId с reason и timestamp). Submenu отрисовывает каждую запись короткой строкой: `<8-char sessionId monospace> · <relative time>` и под ней `<reason>` мелким текстом. Клик возвращает значение — записывается обратно через `setClaudeSessionId(tabId, sid, 'userRevert')` (значит сам revert тоже попадает в историю; можно отменить отмену).

Назначение — last line of defense когда автоматический writer всё-таки перетёр sessionId таба не на тот: stale bridge file проскочил защиты, AutoResume отработал на испорченный state из SQLite, Timeline chain resolver нашёл мёртвую ссылку. Без UI revert юзер должен grep'ать `~/Library/Logs/noted-terminal/production.log` по `[Store:setTabCommandType] tab=...claude=...` чтобы вспомнить какие sessionId раньше сидели на вкладке. См. полный контракт `SessionWriteReason` и список 9 источников записи — `knowledge/fact-session-capture.md::SessionWriteReason contract` и `knowledge/fact-session-detection.md::Stale bridge files + pendingResume guard`.

### Уведомление о завершении вкладки

Отдельный Terminal MCP `notify_user` отправляет запрошенный текст только в
Telegram, без взведения колокольчика, unread/красного workflow-alert, звука или
APNs. Это не третий режим ПКМ-меню и не завершение работы вкладки; существующие
one-shot/persistent настройки остаются как были. Пауза перед уже разрешённым
перехватом курсора начинается после подтверждённой отправки. Контракт и пределы
квитанции — `fact-terminal-mcp.md::Уведомление пользователя в Telegram`.

ПКМ по одиночной вкладке содержит icon-only split-row: слева контурный `Bell`
включает/выключает одноразовое ожидание завершения, справа тот же `Bell` с полной
заливкой включает persistent-режим. Прежний `BellRing` заменён29.09: маленькие
штрихи вокруг него были недостаточным различием. Заливка обозначает режим
независимо от активности: выключенные обе иконки серые, включённые красные;
контурная не получает заливку, постоянная не становится полупрозрачной.
Текст «Активировать уведомления»/«Уведомления» намеренно не рендерится в строке:
длинный label раздувал меню и создавал пустое поле до divider'а. Подсказки
остаются в tooltip/aria-label, но не участвуют в layout. Обе половины используют
тот же `flex-1 basis-0 min-w-0`, что верхние split-строки, чтобы divider всегда
стоял на той же X-координате.

Обе половины колокольчиков дают мгновенную подсветку всей кнопки при наведении, включая уже красное active/fired состояние; уход снимает только hover. Семантический фон и форма иконки остаются прежними. Старый `hover:bg-white/10` не работал из-за inline `backgroundColor` с более высоким приоритетом; общий `TabNotificationControls` рисует независимый background-image overlay, не перезаписывает state-color. Это presentation-only: one-shot/persistent toggles, закрытие ПКМ-меню и lifecycle уведомления сохраняют прежних владельцев.

На карточке sidebar и pane один такой же красный колокольчик расположен сверху
справа, отдельно от процентов/Fast слева и обновлений контекста снизу. При
включённом persistent показана заполненная форма, иначе armed/fired показывают
контурную. Полное выключение убирает маркер; acknowledgement сработавшего
одноразового убирает его, но не стирает маркер сохраняемого persistent-режима.
Значок расположен absolute на правом верхнем углу: его центр **над центром
правой3px process-bar**, а не слева перед полоской. При выборе левой полоски
колокольчик всё равно остаётся справа. Высота прежняя; с04.10 под него не
добавляется padding/spacer, в том числе постоянный. Переходы
off/armed/persistent/fired и dismiss не двигают имя, карточку или её соседей.
Уточнение05.10 исправило прежний внутренний right4px, из-за которого центр
колокольчика отставал от правой полоски на8px. Просто вынести11px HTML-box
наружу нельзя: у плотно упакованного picker появлялся horizontal scrollbar,
менявший высоту окна. Anchor и SVG viewport теперь шириной полоски, а
`xMidYMid slice`/visible overflow сохраняют полный11px рисунок как SVG ink,
не расширяя scrollable area. Это один badge для sidebar/TabCard/Run After.
Сам значок статичный: он сообщает режим и fired-state. Уточнение15.10 пересмотрело
решение06.10 оставить вкладке только колокольчик: по агрегирующей рамке workflow
непонятно, какая именно нейронка закончила. Поэтому сработавший unread-сигнал
дополнительно показывает ту же бегущую красную рамку на самой карточке sidebar
и общего TabCard (pane, switcher/pickers, Run After). Один лишь armed/persistent
рамку не включает. Цвет/форма колокольчика прежние; рамки ошибок, выбора и drag
сохраняются под отдельным декоративным overlay.
У обоих вариантов SVG прозрачная обёртка: цвет заливает только силуэт
постоянного колокольчика, квадратной подложки вокруг значка нет.

One-shot (`completionNotificationArmed`) и fired-state (`completionNotificationFired`/`FiredAt`) живут только в renderer store; в SQLite сохраняется только `completionNotificationPersistent`, потому что это пользовательская настройка «включать уведомление для каждого нового запроса». Если persistent включён, каждый новый busy-edge снова армит уведомление. Если persistent выключен, one-shot снимается на первом авторитетном завершении: при штатном результате он звонит, при ненормальном исходе гасится без звонка.

Выключение правого заполненного колокольчика отменяет также уже взведённый одноразовый сигнал и
очищает сработавшую непрочитанную пометку через существующий `cleared`-канал.
Иначе после «выключить уведомления для каждого ответа» левая иконка оставалась
красной и следующий ответ всё ещё звонил один раз. Левая `Bell` сохраняет
отдельное действие для текущего ожидания: при включённом persistent его
следующий busy-edge снова вооружает, поэтому полное выключение делается справа.

Для native клиентов main держит только volatile mirror **сработавших** уведомлений: renderer посылает `tab-notification:fired` при semantic fired-edge и `tab-notification:cleared` при acknowledgement. Не переносить ownership armed/persistent в main: armed/persistent — состояние настройки и текущей вкладки в renderer/SQLite, а main mirror нужен только чтобы `/api/project-activity`, `/api/projects` и `/api/projects/:id/tabs` могли показать уже готовый unread-сигнал iOS без доступа к Zustand.

04.10 native long-press получает те же два действия через отдельный capability-
gated GET/POST `completion-notification`, не через перегруженный clear. Явный
enabled не инвертирует режим при повторе. Persistent setter теперь возвращает
promise прежней общей save-очереди: public success требует её строгого ACK и
SQLite-проверки, не факта изменения Zustand. Ошибка записи не объявляет новый
volatile intent долговечным и не откатывает более поздний desktop выбор.
Read возвращает все четыре флага с capture-order версии renderer и отдельно
storedPersistent/persistentDurable. Событие settings-changed только будит GET
на tab/project-activity topics; оно не звонит и не создаёт второй mirror.
При неизвестном POST исходе читается состояние, повтор настройки не планируется.
GET — текущие флаги, не квитанция, доказывающая отмену старого запроса.
Wire/границы — `fact-mobile-web.md::Удалённые настройки уведомления вкладки`.

Natural completion определяется тем же outcome-языком, что Run-after: `busy:false` без reason (Claude/Gemini/SDK natural end) или `reason:'task_complete'` для Codex, когда есть непустой `last_agent_message` либо корневая assistant-запись `phase:'final_answer'` с явным `turn_id`, совпадающим с завершившимся turn. `codex-no-final-result`, `manual-stop`, `interrupt`, `turn_aborted`, `close`, `watchdog`, `local-command` и error-like reasons — только cleanup/liveness edges, они не должны звонить и не должны зажигать completed-сигнал. Это закрывает пользовательские симптомы «нажал Escape/ручную остановку, а уведомление всё равно пришло» и «Codex показал ошибку без ответа, но вкладка позвонила как готовая»: окончание работы ещё не доказывает результат.

У прошедшего этот guard завершения есть независимый Telegram-канал: renderer
посылает `tab-notification:completed` даже когда вкладка видима и
`completionNotificationFired=false`; видимость управляет unread/APNs-проекцией, но
не отменяет явно включённый внешний сигнал. Main формирует canonical
`eventId=tabId:firedAt`, сначала сохраняет его в durable FIFO и затем доставляет в
SC Desktop. `400/401/403` считаются постоянной ошибкой контракта; `404/429/5xx`,
timeout и network failure остаются в очереди с backoff. Поэтому удалённый или
остановленный получатель не «теряет» уведомления, а накапливает backlog, который
после восстановления может отправиться сразу.

SC Desktop обязан дедуплицировать тот же `eventId`: Telegram мог принять сообщение
до потери HTTP-ответа, после чего sender закономерно повторит запрос. Этот канал не
заменяет `tab-notification:fired` → project-activity/APNs, а работает параллельно.
Владелец receiver-контракта:
`/Users/fedor/Desktop/sc-desktop/docs/knowledge/fact-sc-desk.md::Custom Terminal:
исходящие Telegram-уведомления`.

Звук и unread-визуал намеренно разделены. Если пользователь явно включил уведомление, completion event dispatch'ится даже когда target-tab сейчас активен и видим: системный звук должен сработать один раз независимо от foreground visibility. Но красный unread-state (`completionNotificationFired`) ставится только если цель не видна (`activeProjectId/workspace.activeTabId/currentView` не указывают на этот terminal tab), иначе пользователю нечего «догонять взглядом» — он уже на месте. Native Notification создаётся silent, а звук отдельно гейтится Settings → Системные → «Уведомления вкладки / Системный звук».

Рамка конкретной вкладки и агрегирующая рамка workflow используют один `tab-completion-notification-alert`: это unread-сигнал, а колокольчик сверху справа сохраняет отдельное обозначение режима. Overlay не меняет размеры карточки, её обычный border/shadow или hit targets. При acknowledgement notification state очищается сразу в store; только видимая рамка вкладки и workflow затухает за420ms. Скрытые retained-поверхности приостанавливают бесконечное движение, но конечное затухание завершается. Если fired-state уже оказался на текущей активной вкладке (race/restore/старое состояние), первый `pointermove` в любом месте окна тоже считается acknowledgement и очищает state тем же путём: пользователь уже смотрит на эту вкладку, клика по ней может не быть. Automation, sound и persistent-arming читают semantic state, не визуальную задержку. Звук, доставка и настройки этой presentation-only правкой не менялись.

### Wheel handler gotcha

`handleWheel` в TabBar.tsx ранее форсировал `scrollLeft += deltaY` на overflowX:hidden контейнере для горизонтального wheel-скролла без Shift. В vertical mode этот же useEffect блокирует нативный вертикальный скролл колесом — деление `scrollLeft` ничего не делает (overflowX:hidden), но `e.preventDefault()` глотает событие до того как браузер обработает scrollTop. Симптом: «вкладки не скроллятся колесом в sidebar».

Фикс — `if (isVerticalLayout) return;` early-return в useEffect перед `addEventListener`. Сам guard нельзя убирать, пока компонент сохраняет горизонтальную render-ветку; это не означает существование отдельной пользовательской Utils-зоны.

### CMD+hover preview справа

В vertical layout TabPreviewPopover открывается справа от таба (`placement='right'`) вертикально центрированным. Детали — `knowledge/fact-tab-preview-popover.md::Layout & позиционирование`.

### Tab-группы и visual-child вкладки

В `TabSidebar` есть две независимые иерархии. `groupId` + `tabGroups` — реальные группы сайдбара: group-row существует как отдельная строка, хранит имя, переименовывается только через ПКМ → Rename, закрывается middle-click'ом или через ПКМ → Close Group, либо удаляется как контейнер через ПКМ → Delete Group. `Rename` с иконкой карандаша стоит первой командой group-context menu: это частое и недеструктивное действие не должно прятаться после статусов или управления контейнером. Close Group закрывает вкладки группы и потом удаляет контейнер; Delete Group сохраняет вкладки, только очищает у них `groupId`. Group-row намеренно использует те же `tabsFontSize`, `tabGeometry`, padding/minHeight/radius и click-target, что и обычная вкладка: группа отличается цветом, иконкой и стилем, но не плотностью строки.

Создание group-row через EmptyDropZone → `New Group` сразу открывает inline rename, как `Cmd+T`/double-click для новой вкладки. Дефолтное имя группы — только временный draft, пользовательский следующий жест почти всегда «назвать контейнер», поэтому cursor/focus должен оказаться в названии без отдельного double-click.

Group-row — самостоятельная кликабельная строка: обычный click фокусирует группу и сворачивает/разворачивает body; переименование не конкурирует с этим жестом и живёт только в context menu. Drag включается на удержании/движении, не на hover. Folder SVG — affordance общего действия строки, а не единственная hit-area: hover/focus/collapsed state подсвечивает всю group-row и folder-accent. Press-state стартует уже на `mousedown` по header (кроме collapse-button), до библиотечного `dragstart`: иначе при зажатии до первого движения macOS показывает обычный курсор, хотя пользователь уже начал drag-жест.

Фокус группы — это durable UI-state проекта (`activeGroupId`), а не только highlight. После клика по group-row следующий `Cmd+T` создаёт вкладку внутри этой группы: для непустой группы — после последнего member-tab, для пустой — в её anchor-позиции. Клик по обычной вкладке сбрасывает active group, чтобы `Cmd+T` снова следовал за активной вкладкой.

Group-row поддерживает те же пользовательские visual metadata, что и обычная вкладка: `sessionStatus` рисуется тем же marker shape/size слева, `color` выбирает background/folder accent из `TAB_COLORS`. ПКМ по группе зеркалит tab-context menu для Status и Background: повторный клик по выбранному статусу снимает его, а пустой список статусов показывает тот же hint про Settings → Системные. Статусы групп живут в `tabGroups` JSON, а не в `tabs`/`tab_history`.

Mobile/native клиенты не хранят свои группы. После workflow cutover native читает
global groups и меняет их через отдельный canonical HTTP adapter; полный active
drag использует общий capture/compiler/commit, включая placed/hidden участников.
Legacy Project-клиенты до cutover: `/api/projects/:id/tabs` отдаёт тот же `tabGroups`
JSON вместе со статусами и marker config, а `/api/projects/:id/tab-layout` принимает layout
payload с `orderedIds`, `groupAssignments`, `groupAnchorAssignments`. Это защищает от двух
разных sidebar-истин: desktop DnD, mobile reorder и project-activity layout reload должны
сойтись на одном `tabGroups`/`tabs` состоянии. Delete Group в mobile-контракте соответствует
desktop `Delete Group`: удаляет контейнер и очищает `groupId` у вкладок, но не закрывает tabs.

`visualParentTabId` — только визуальная связь вкладка→вкладка для thread/fork-структуры. Visual-child остаётся обычной видимой вкладкой со своим session id (это отдельное поле, не путать с `parentTabId`). Старые split-стрелки вверх/вниз из tab context menu удалены: ручное переподчинение выполняет DnD, а `setTabVisualParent` защищает от циклов и нормализует `groupId` ребёнка под группу родителя. Если пользователь тащит обычную вкладку рядом с уже существующим visual-child, drop в sibling-slot делает её ещё одним visual-child того же parent.

Для сохранённой Claude/Codex-сессии на месте стрелок находится split-строка `Fork`: основная левая зона шириной около 70% создаёт fork от последнего реального compact, правая зона около 30% — обычный fork всей истории. Обе операции создают соседнюю visual-child вкладку исходника. После ремонта12.10 PTY-путь сначала создаёт durable контейнер: отсутствие compact оставляет этот child с явной ошибкой, без готовой копии и без автоматического повторного запуска. Старое утверждение «нет compact — нет вкладки» к нему больше не относится; реальный refusal/rename проверен17.10. Compact-fork не мутирует source: Claude переносит последний `compact_boundary` + summary + хвост, Codex — последний top-level `compacted` + `context_compacted` + хвост. После успешного copy commit точный child SID разрешает показать перенесённую историю до первого сообщения. Runtime writer подтверждается отдельно; SID родителя ребёнку не одалживается.

Drag-семантика разделена по осям. Горизонтальный шаг вправо привязывает source только к ближайшему предыдущему peer той же глубины, группы и текущего parent-контекста; удалённый peer из другой ветки не является кандидатом. Шаг влево поднимает ровно на один уровень, а отсутствие кандидата, root-level слева и max-depth дают disabled/no-op. После каждого принятого шага X-anchor переносится в текущую точку. Пока horizontal intent владеет кадром, соседние vertical targets не подсвечиваются; первое осознанное движение по Y после indent/outdent использует уже новый parent/container, а не pickup-time контекст.

Parent-вкладка переносит всё visual-subtree атомарным блоком, а перенос отдельного child сохраняет его descendants. Это исключает промежуточный порядок `parent, чужая строка, child` и не разрушает ветку после обычного reorder. Тот же контракт действует для terminal- и linked Markdown-вкладок: тип содержимого не меняет механику hierarchy. Несколько consecutive visual-children рисуют непрерывные ancestor-connectors; линия не должна обрываться между sibling-ветками или смещаться из центра parent glyph. Fork из текущей Claude/Codex/Gemini/SDK-вкладки создаётся visual-child исходной вкладки, а clipboard-fork по произвольному UUID остаётся плоским, потому что известного source-tab нет.

Раскрытая группа является одной crossing-зоной: header и все участники получают общий target-block и одну сторону boundary с hysteresis. Фон блока означает перенос до/после всей группы, а не скрытый вход. Если курсор уже находится над раскрытым body, первый принятый шаг вправо сохраняет эту Y-координату, сразу показывает стрелку и ставит source в точный start/middle/end slot без дополнительного движения по Y; стрелка остаётся до осознанной смены оси. Закрытая группа внутренних slots не предоставляет и отвечает `closed-group-needs-navigation` до навигационного раскрытия. Пустая группа принимает вкладку через собственную body-зону `Пусто`. Connector от group header продолжается через прямых и вложенных потомков как одна иерархия.

После валидного drop список раскрывает место результата только до полезного контекста: корень перенесённого блока и до трёх первых помещающихся descendants с небольшим отступом от края viewport. Попытка показать весь длинный раскрытый контейнер уводила viewport к хвосту, а один заголовок не подтверждал сохранённое раскрытие. Новый drag отменяет незавершённую reveal-анимацию; cancel/outside её не запускают.

Legacy native transport не считается завершённым по первому `dragend`: valid `drop` может прийти позже и отменяет delayed cleanup. Обратный Chromium-case — release правее списка без `drop` и `dragend`; следующий capture `mouseover` с `buttons=0` очищает preview и press после короткой задержки, но не применяет last target. Поэтому outside даёт ноль store writes, а valid drop — ровно один.

Задержка sidebar pickup/release могла пережить ремонт resize/workflow: `TabBar`
держал собственный универсальный cursor stylesheet поверх shared outline.
Именно host добавлял `html * {cursor:grabbing!important}` на начало жеста;
общая outline-библиотека этого не делает. Удаление правила снова затрагивало
все retained History, поэтому даже отмена без изменения порядка могла зависать.
Теперь host использует cursor уже захваченной source-row после movement threshold;
при переносе между проектами владельцем становится projected source-row.
Cmd меняет назначение переноса, сохраняя этот cursor-owner. Физический release
снимает курсор сразу, даже если сохранение ещё ждёт ACK. Блокировка hover-анимаций
остаётся статическим правилом только для tab/group chips; legacy native HTML drag
сохраняет собственный transport без добавочного pointer capture. Оконная шапка
05.10 перешла на непрерывный pointer-жест, чтобы reorder не ждал редких `dragover`;
её active source переживает замену DOM и передаётся тому же sidebar-outline.
Логи `[TabDnd:cursor]` показывают acquisition/cleanup без geometry-read.
Контроль с actual outline и host hooks — `scripts/tab-gesture-cursor-regression.mjs`;
это изолированный Electron, installed acceptance отмечается отдельно в рабочем tmp.

Pane-chip и sidebar-outline теперь могут передавать друг другу **тот же pointer-сеанс**. Pane source, войдя в sidebar, временно проецируется корневой строкой и передаётся общему `useOutlineDnd`; обычный Y выбирает позицию, а Cmd включает лишь X-вложенность; `sidebar-end` по модификатору удалён10.10. При переходе в другой проект controlled outline не merge'ится со старым: новый проект полностью заменяет набор строк, а source-node является единственным мостом. Иначе commit видел бы одновременно строки обоих проектов и справедливо отклонял `tab-set-mismatch`.

Обычное наведение на workflow/project — navigation target, не drop target: круг у курсора завершается через 500мс, выполняется обычный переход, но project owner и pane placement не меняются до release. Cross-workflow pane identity всегда включает `spaceId`; одинаковый `pane:0` в двух workflow не является одним окном. Project transfer после main ACK переписывает projectId во всех pane chips, center strips, `activeSpaceTab` и скрытых workflow snapshots; sidebar-drop затем удаляет placement из каждого snapshot, чтобы следующий switch/restart не воскресил старый чип.

Конкретные причины прежнего расщепления parent-блоков, отмены drop при размонтировании source и stale commit после `Escape`/outside сохранены в `knowledge/fix-иерархия-перетаскивания.md`.

### Чипы связанных сессий в файловом дереве

Файл, к которому прикреплены AI-сессии, показывает их именами-чипами **отдельной строкой под собой**, а не в правом конце своей строки: длинное имя файла выталкивало прежние чипы за край панели, и они читались как отдельная правая колонка, а не как свойство файла. Чип выровнен по началу ИМЕНИ файла, а не по иконке: строка сама несёт `padding-left: 12 + depth*16`, поэтому внутренний отступ чипов равен `12 (chevron) + 6 + 16 (icon) + 6 = 40px` и работает на любой глубине.

Чип обязан выглядеть тем же объектом, что открываемая им вкладка: скруглённый блок, тонированный фон цвета сессии, цветная рамка, белый текст, подсветка заливки на hover. Бесфоновая цветная надпись выглядит как обычный текст и не читается как «файл принадлежит этой сессии»; hover, меняющий только цвет уже белого текста, визуально не срабатывает вовсе.

**Общий пакет пиннит каждую DnD-строку в `height: 28px`.** Это и есть причина, по которой перенесённая вторая строка накладывалась на соседний файл: расти было некуда, и чип рисовался поверх строки ниже. Высоту нужно отпускать на ОБОИХ селекторах (`.arborist-node` задаёт `min-height`, `.outline-dnd-row` — фиксированный `height`) и только для строк, реально несущих чипы, чтобы остальной список сохранил постоянный шаг. Для drag это безопасно: outline снимает границы по фактическим `top` строк, а не по константному шагу (см. «Structured outline DnD»). Замер на живом DOM: строка 28 → 43px, `overflowsRow=false`, `overlapsNext=false`.

Несколько сессий на одном файле остаются в ОДНУ строку с горизонтальной прокруткой полосы (`flex-wrap: nowrap` + `overflow-x: auto`), а не переносятся вниз: перенос растил бы строку неограниченно и снова ломал ритм списка. Скроллбар скрыт — в узком сайдбаре он съедает текст.

**Счётчик закреплён справа, ВНЕ скроллера.** Прокрученная полоса сама по себе не отвечает на вопрос «спрятана там ещё одна сессия или десять», поэтому строка чипов состоит из двух частей: скроллируемая полоса + неподвижная плашка справа. Показывается ПОЛНОЕ число сессий, а не остаток «+N»: полное число верно при любом положении прокрутки, а остаток пришлось бы пересчитывать на каждый кадр скролла. Плашка нейтрально-серая: она считает сессии разных цветов, и accent любой из них читался бы как «эта сессия». Появляется только при 2+ сессиях; одна сессия в счётчике не нуждается. Полный список имён — в tooltip.

Правый край: строка резервирует себе `padding-right: 8px`, на линии чипов это мёртвое место. Обёртка вытягивается в него отрицательным `margin-right`, но **одного `flex-basis: 100%` для этого мало** — он ломает строку и одновременно фиксирует ширину по content-box родителя, поэтому нужен ещё `width: auto` + `flex-grow: 1`. Замер до/после: правый край 260 → 267px.

Проверено клонированием чипов на живом DOM: 7 чипов, `scrollWidth=800` при `clientWidth=156`, счётчик остаётся видимым после прокрутки в конец, высота строки прежние 43px, `overflowsRow=false`.

Правки этих стилей делать только в локальном `styles/sidebar.css` проекта, а не в общем `@noted/file-explorer`: пакет используют другие приложения. Локальный файл импортируется в `main.tsx` РАНЬШЕ пакетного, поэтому все переопределения обязаны быть scoped под `.arborist-node` — на равной специфичности выиграет пакет.

### Файловые вкладки как visual-child

Файл, прикреплённый из file explorer через `Link File`, становится обычной видимой вкладкой `tabType='file'`, но не AI/terminal-сессией. Он создаётся рядом с выбранной Claude/Codex/SDK-вкладкой, наследует её `groupId` и получает `visualParentTabId=<targetTabId>`, чтобы читаться как рабочий артефакт этой сессии. Мотивация UX: пользователь хочет открыть нужный файл прямо из области вкладок и не возвращаться в дерево через `Cmd+B` только ради просмотра.

Полное закрытие владельца через общий `closeTab` закрывает его файловые вкладки
вместе с ним. Обход идёт только через `tabType='file'`: самостоятельная дочерняя
AI/terminal-вкладка остаётся доступной, и её собственные файлы не агрегируются.
Это также сохраняет согласованность вложенного файлового поддерева. Удаляются
только вкладки/связи и их размещения, не файлы на диске. Корневые непривязанные
документы и одноимённые файлы другого владельца не затрагиваются. «Убрать из окна»
не является полным Close и не меняет срок жизни владельца или его документов.

Каскад сохраняется до публикации в renderer; если linked files лежат в нескольких
каталогах, их снимки резервируют соответствующие save-lanes и commit'ятся одной
SQLite-транзакцией через `project:save-tabs {tabSnapshots}`. Отказ сохраняет
исходные Map/preview. После ACK каждый закрытый ID убирается из strips, MRU,
visit/detached history и всех workflow snapshots; показанное окно остаётся vacant.
Owned `FilePreview` закрывается по owner/file ID, а не по совпадению пути.

Его компактная шапка показывает имя файла, чтобы длинный путь не вытеснял
название. Полный путь доступен в title. GT Editor и Sublime представлены иконками,
Copy All и закрытие остаются явными действиями; локальный font stepper убран.
GT Editor получает тот же дисковый путь через native open-file, не копию текста
в untitled. Эти изменения шапки не означают ускорения чтения/рендера большого файла.

Запоздавший `Link File` не может публиковать документ после закрытия владельца:
`linkFileTab` передаёт существующей фабрике `canPublish` с проверкой exact tab ID,
исходного workspace и `aiClosing`. Общий creation-commit повторяет её непосредственно
перед publish; отменённая неопубликованная запись проходит прежний rollback, а
caller получает явный отказ вместо выдуманного успешного прикрепления.

Тот же сценарий доступен внешним callers через `POST /api/terminal-tabs/:tabId/link-file` и `Terminal MCP::link_file`; отдельной MCP-модели вложений нет. Сервер принимает только существующий абсолютный файл и canonicalize'ит путь, renderer ищет target по всем открытым project workspace. Пара canonical path + `visualParentTabId` идемпотентна: повтор возвращает прежний file-tab. Внутри полноценной AI-сессии отсутствующий `tabId` берётся из `NOTED_PARENT_TAB_ID`, поэтому scratchpad может прикрепить себя без угадывания собственного ID; явный `tabId` адресует другую сессию.

File-tab участвует в тех же механиках порядка, группировки, DnD и visual-child стрелок, что и обычные вкладки. Его меню содержит `Copy Path`, `Open in Finder`, `Copy Content`, `Status`, `Unlink File` и отдельный `Delete File`; `Обновить название`, Favorites, Stop/Restart и rename не показываются. `Open in Finder` раскрывает тот же `filePath`, без возвращения в `Cmd+B`. `Unlink File` закрывает вкладку/связь и сохраняет байты. `Delete File` использует прежний file-tree ingress в системную корзину и закрывает связь только после строгого disk ACK; ошибка диска сохраняет связь. Если диск подтвердил удаление, но Close отвергнут, UI сообщает частичный результат, не объявляет связь удалённой. Меню фиксирует exact ID/path/parent/subject: устаревший или переподчинённый файл не наследует полномочия старого пункта; Escape отменяет меню до действия. Фиолетовый фон остаётся маркером файла, редактирование Background/color отключено. Длинное имя в header меню ограничено шириной, с ellipsis и полным `title`.

Клик по прикреплённому file-tab в reserve раскрывает его AI/terminal-владельца через общий async `openTabById`, затем открывает тот же `FilePreview` в его окне. Сам файл не добавляется в terminal strip; явный DnD placement остаётся отдельным действием. Поиск владельца проходит через файловых родителей и останавливается на первой самостоятельной AI/terminal-вкладке. Непривязанный файл сохраняет обычный preview flow. Повторный клик по тому же exact файлу закрывает reader, другой файл заменяет содержимое. Home, уход/возврат и закрытие во время async read отменяют поздний результат. `Workspace` sync-effects не должны переписать этот owned preview из sidebar-state.

Файловое меню карточки — ограниченная проекция того же дерева, не отдельный порядок.
Presentation `useTabLinkedFiles` делит индекс файлов между владельцами в пределах
одного опубликованного объекта Zustand state. Ключом нельзя делать только
`openProjects`: nested tab может измениться in-place перед `set()`. Следующая
публикация строит новый индекс; старые weak entries не удерживают state. Прямые
collect/read и проверки drag/close продолжают читать текущие связи без этого memo.

Файловое меню включает вложенные файлы, но не документы самостоятельного AI-child. Y/X меняют
общие `reserveOrder`/visual relations одним canonical `commitDrag`; mixed roots,
глобальные группы файлов и соседние AI-вкладки сохраняются. Группы в file-only
проекции не показаны и этим жестом не переназначаются. Корень меню означает существующего
владельца: top-level outdent не отсоединяет файл, выход указателя за меню отменяет
жест. Frozen scope проверяет также полный состав файлов владельца, включая появление
нового sibling после pickup. Временный `contextParent` при pane adoption не является
запретом явной visual-перестановки файла; physical `parentTabId` остаётся защищённым.
«Убрать из окна» возвращает владельца и это дерево в reserve с тем же порядком.

Примитивный sidebar fingerprint также делится между подписчиками одного project
в пределах опубликованного STATE; прямой helper остаётся свежим. Отдельный memo
линий вертикальной иерархии хранит лишь результат по упорядоченным ID/parent-парам:
изменение имени/статуса не требует заново обходить ancestors всех строк, изменение
связей/порядка требует. Неизвестная форма данных не переиспользуется. Menu-only
экземпляры TabBar не рисуют эти линии и не вычисляют их; меню и действия остаются.

С17.10 точное кодирование sidebar metadata может переиспользоваться между
публикациями только после свежего чтения ВСЕХ нормализованных scalar values в
прежнем порядке и полного сравнения векторов. Identity workspace лишь находит
кандидата; in-place Tab mutation и cloned outer Map не дают stale hit. Это
сокращение encoding/join, не O(1)-проекция и не кэш тела истории. Reentrancy
использует локальный вектор; исключение не сохраняет частичный результат.

Чип называет открытый файл, после закрытия reader — последний открытый у этого
владельца, до первого открытия — первый в сохранённом порядке. Выбор проверяется
по текущему дереву; удалённая/переподчинённая связь и известный missing path не
подставляются из старой памяти. Имя открывает/закрывает reader, `+N` управляет меню.
Левый клик по строке popup выполняет тот же `onOpen` preview-action имени.
Sidebar linked-file row разрешает exact владельца и использует общий reader;
самостоятельное размещение file-tab не участвует в навигации просмотра. Прежняя
подмена11.10 открывала лишний chip и могла увести в Inbox по membership файла.
Hover открывает список и для единственного файла: иначе недоступно открытие
его самостоятельной вкладки средним кликом. Число файлов определяет наличие `+N`, а не доступность меню;
при переходе с двух файлов на один список остаётся, после последнего unlink исчезает.
Повторный click закрытия не отменяется hover до нового входа. Passive chooser
может включить `linkedFilesMode='navigate'`: левый клик в обоих сегментах вызывает exact
file callback, без nested hover/menu/context-menu. Геометрия общего TabCard прежняя.

Средний клик различает поверхность: по нижнему чипу закрывает owned reader и
возвращает его вкладку через Root navigator, сохраняя файловую связь. По строке
popup или file-tab в workflow sidebar открывает самостоятельное окно справа.
Существующее место файла раскрывается через Root без копии; свободное окно,
оставшееся после закрытия chip, переиспользуется. В оконной полосе middle снимает
только placement. Unlink остаётся явным пунктом ПКМ, средний клик его не вызывает.
В popup голубая inset-линия отмечает отдельное окно; показанный файл дополнительно
подсвечен, parked/hidden/profile placement имеет приглушённую линию.
Жест не всплывает в родительскую карточку и не закрывает её. Pending read того же
владельца отменяется до await, чтобы старый reader не вернулся после открытия сбоку;
очистка старого read не снимает guard нового. Popup проверяет exact path/parent/owner
и не открывает окно внутри active drag. File с physical parent показывается как
свой reader, не как AI subagent родителя; physical relationship не переписывается.

У обычного file chip scale1.04 сохраняется при переходе по bridge внутрь popup;
нижний край остаётся на месте благодаря origin:left bottom. Уход из всей зоны
снимает scale, даже если меню закреплено. Popup имеет по1px внешнего/внутреннего
отступа и зазор между строками1px. Сами строки переиспользуют целый TabCard:
шрифт, высота и padding совпадают с sidebar при любых настройках. Ширина остаётся
по содержимому, окружающий padding не суммируется в широкую пустую рамку. DnD feedback располагается внутри
строки, без постоянной пустой колонки справа. Navigate-режим остаётся без scale.

File-tab не архивируется в `tab_history` при закрытии и не участвует в Home, Shift+Cmd+T, title-search и iteration-search индексах. Фиолетовая linked-file строка в History выглядит как восстановимая сессия, хотя restore вернул бы только документ-превью без терминального состояния; поэтому фильтр должен идти по `tabType='file'`, а не по цвету `purple`, чтобы не заблокировать будущие обычные вкладки с пользовательским фиолетовым фоном. Старые polluted history-строки с `tab_type='file'` игнорируются на чтении/индексации.

На mobile/native тот же принцип: file-tab остаётся row в списке групп/DnD/status, но tap по нему
открывает read-only preview sheet через `/api/file-preview`, а не активирует chat route и не
запускает tab SSE. Если клиент начинает трактовать file-tab как session tab, пользователь видит
пустой чат вместо документа, а runtime/status state получает ложного владельца.

Закрытая вкладка помнит `groupId` в `tab_history` и при Restore/Home/Shift+Cmd+T возвращается в группу только если group-row ещё существует. Если контейнер удалён через Delete/Close Group, restore деградирует в плоскую вкладку: история восстанавливает саму рабочую сессию, но не воскресает удалённую папку.

С24.09 сохраняются также visual-parent, дети и соседи строки. Дети закрытого
родителя временно показаны выше, а undo восстанавливает связь, если её не
заменили новым ручным переподчинением. Layout identity переживает новый runtime
tabId и restart; это не попытка оживить старый PTY. Архив без новых метаданных
сохраняет прежний fallback. Механика — `fact-reopen-last-closed-tab.md`.

### Structured outline DnD во вкладках

10.10 пользователь разделил обычный перенос и изменение вложенности: Y/reorder,
оконные цели и hover-переход workflow не требуют Cmd; только намеренный X-indent/
outdent требует удерживаемого Cmd. Папки/группы раскрываются обычным hover с
прежним dwell-progress. Конец — обычная нижняя позиция, а не Cmd из любой точки.
Так одна клавиша больше не означает одновременно вложенность, паузу и append.
Hover+Cmd показывает отдельный маленький знак рядом с курсором, не перекрашивая
status/selection; физический сигнал не публикуется в React всех retained rows.
Раскрытие группы и его отмена используют одну очередь `workflowGroupExpansion`:
новая Main publication сначала проверяется по неизменности exact group definition,
а неизвестный ACK восстанавливается тем же mutation ID до отмены. Общая ревизия
групп меняется и от создания участника; детали — `fact-workspace.md::Резерв, окна и переходы`.
Этот знак режима не является копией переносимой вкладки. Внутри outline видны
сама строка и стрелка вложенности; отдельный payload-chip нужен только над
внешним оконным/navigation receiver и работает без Cmd. Старое условие
«Cmd → фиолетовая копия» конфликтовало с новым смыслом клавиши и давало двойной
preview при обычном X-движении. Выбор изображения не меняет frozen набор или commit.

В текущем workflow reserve pickup фиксирует нормализованные выбранные корни,
полные поддеревья и исходные membership/relation/placement guards. Для каждой
цели preview и сохранение используют одну проекцию этого snapshot: sidebar
переносит forest, окно получает явно выбранные корни, сохраняя physical/file
ownership. Изменение selection позже не расширяет набор. Несмежные корни
сохраняют порядок и якорь зажатой строки.

При неизменном semantic slot прежние source-rows продолжают следовать pointer Y.
FLIP перестановки сам по себе этого не даёт: same-slot движение раньше оставляло
строку на месте при исправных pointer/rAF событиях. В Noted отдельный Y-follow
сохраняет исходную точку захвата и компактные offsets frozen forest. Его visual
смещение вычитается из следующего layout measurement, иначе собственный сдвиг
возвращается в resolver как новая геометрия. Source сохраняет horizontal FLIP,
соседи — прежний FLIP; source vertical FLIP уступает непрерывному Y-writer.
При adoption original grab — UI-связь того же жеста, вне durable admission.
Это opt-in Noted sidebar; pane preview и defaults других shared-host не менялись.
Multi-X остаётся запрещённым с явной стрелкой-запретом, single-X сохраняет прежнюю
иерархию. Physical AI children не меняют execution-parent от изменения отступа.
Файл с parentTabId=null имеет обычную редактируемую visual-связь: X-outdent/indent
и Y-перенос сохраняются через тот же canonical transaction. Прежний blanket
file-lock в host/model/Main был регрессией, а не ограничением старого sidebar.
Проверки subject/PK, исходной relation/revision, циклов и существования parent
сохраняются. Это не отменяет file-family при переносе владельца и не превращает
временное извлечение файла из pane-проекции в неявный unlink.

Вход из pane и смена workflow продолжают один gesture с одним final-release
owner. Cmd-end сначала рисуется и только затем сохраняется; Escape/blur/outside
не оставляют временные строки для следующего жеста. Main атомарно применяет
показанные membership/group/parent/order/layout изменения. Его scoped проверка
может принять несвязанную новую publication, но исходный request/hash и все
guards сохраняются; общий commitWorkspace по-прежнему требует свой exact CAS.
Пустой group-root при смене workflow также меняет reserveWorkflowId в этой
транзакции с exact definition/composition guards. Один rootOrder назначения не
переносит пустую группу: без anchor-изменения readback снова показывал её в source.
Обычные metadata saves не заменяют legacy row, а собственный relation ACK
применяется только к старым queued snapshots. Поздний ACK не возвращает фокус
после Home или away/back. Whole-app физическая проверка отделена от проверки
общего hook, компонентного стенда и SQLite.

Frozen выбор имеет разные заранее определённые проекции назначения. Резерв
получает полный visual forest; окно показывает выбранные корни и переносит
membership их physical/file family. Самостоятельные визуальные AI-потомки
сохраняют прежний workflow и parent-связь: после cutover она может вести через
границу workflow и не является orphan. При извлечении отдельного file/physical
child из полного дерева admission сохраняет его exact parent как context,
иначе корневая временная строка ошибочно выглядела бы командой unlink.
Пустые группы участвуют в порядке корневых строк отдельно от порядка tabIds,
поэтому release не возвращает такую группу в конец только из-за отсутствия детей.

Window placement не переставляет оставшиеся containers по первому оставшемуся
member. Старый sidebar показывал и размещённые вкладки, поэтому такое смещение
появилось именно после reserve-фильтра. Pickup отдельно сохраняет видимый mixed
root order (группы, одиночные вкладки, пустые группы). Оконный drop записывает
этот порядок исходного workflow, сохраняя невидимые persisted ranks; destination
не получает чужой порядок. `expectedReserveRootOrder` остаётся сырым baseline,
включая `[]`, и чужое изменение после pickup даёт conflict. Явный внутренний
Y/group reorder продолжает сохранять свой painted order.

Post-drag click suppression относится только к click завершённого жеста.
Следующий pointerdown снимает её, в том числе capture над metadata controls;
keyboard click ей не блокируется. Иначе после pane→reserve первый быстрый
Cmd-click selection пропадал из-за оставшегося500ms suppression, и следующий
перенос неожиданно захватывал одну вкладку вместо двух.

Обычный hook pointerup уступает bridge только при явном `releaseOwner:'bridge'`.
Это сохраняет single-source/default поведение остальных consumers shared package;
Noted reserve использует одного receiver, в том числе до первого painted frame.

Single-source drag вкладки или group-row использует общий `@noted/structured-dnd/react`: host переводит `tabs + tabGroups + visualParentTabId` в outline, а пакет ведёт единственный in-tree source, переносит его транзитивное поддерево и отдаёт последний нарисованный semantic result. Группы остаются только root-контейнерами, вкладки допускают visual-depth до четырёх уровней. Вертикаль следует за курсором через безопасные границы и автоматически выбирает минимально совместимую глубину; только отдельный X-шаг меняет preferred parent. Закрытая группа не предоставляет скрытых child-slots, а обычное наведение циклически переключает только допустимые group headers; Cmd включает X без общей паузы Y. Собственная группа или ancestor source показывают blocked disclosure, а не зелёный loader.

Шапка и тело окна — явные внешние цели обычного sidebar-drag; resolver обрабатывает их раньше folder-dwell. Возврат в outline продолжает тот же frozen source. Terminal включает optional `hierarchyModifier=meta` во вкладках, файловом меню, Settings-промптах и файловом sidebar. Default shared package сохраняет прежнюю Cmd-navigation для GT/других клиентов; это не разрешение менять их жесты.

Чип, взятый из шапки окна, модификатора не требует. Drop на соседний чип даёт точную горизонтальную позицию; drop на большое пунктирное поле тела добавляет в конец. Во время удержания target-strip уже показывает будущий порядок и FLIP соседей; release принимает **последний нарисованный target**, а не пересчитывает позицию по DOM, который сам успел сдвинуться от preview. Между окнами чип переезжает, не копируется; отдавшее последний чип окно остаётся пустым placeholder. Один model-commit одновременно снимает source, собирает target strip, выбирает показанную вкладку и сохраняет pane-history — промежуточного кадра «оба окна владеют tab» или «source уже пуст, target ещё пуст» нет.

Перетаскивание tab может пережить навигацию в другой workflow/project: hover меняет только видимое пространство, а owner вкладки не переписывается до конечного drop. Поэтому исходный drag остаётся тем же жестом и может закончиться в sidebar или окне уже открытого пространства.

Описания project-destination ниже относятся к legacy host до workflow cutover;
новый reserve меняет canonical workflow membership без смены execution owner.

В legacy Project UI верхние project tabs являются внешними целями того же pointer-жеста, а не отдельным `Cmd`-режимом. Вкладка переносится на другой открытый проект вместе со своим visual-subtree; group-row переносит сам контейнер, все его вкладки, metadata и внутренние parent-связи. Наведение на текущий проект показывает нейтральный blocked-state и не коммитит последний внутренний preview. ПКМ группы → `Move to Project` вызывает тот же transaction-path и служит точным fallback, а `Rename` остаётся первой командой меню. Из меню одиночной вкладки, включая file-tab, `Move to Project` убран26.09 по запросу пользователя: здесь достаточно внешнего DnD на project tab. Групповое меню сохраняет свой fallback. `Move to Group` намеренно отсутствует — внутри текущего проекта группировкой уже управляет прямой DnD. Submenu показывает только открытые проекты, которые всё ещё существуют в project catalog; stale workspace после удаления проекта не является допустимой целью атомарного переноса.

Payload определяет **цель**, а не клавиша. Project/sidebar destination получает каждый явно выбранный visual-root вместе со всеми descendants. Если одновременно выбраны parent и его child, child второй раз не считается и не переносится: корень раскрывается в один pre-order блок, внутренние `visualParentTabId` сохраняются. Pane header/body получает только явно выбранные корни — descendants остаются обычными строками sidebar и не превращаются в оконные chips. При cross-project pane-drop оставшийся без перенесённого parent child становится самостоятельным root в исходном проекте, а не исчезает. Модификатор не определяет состав payload; оконные/navigation targets доступны обычному drag. Preview использует тот же resolver: project chip и native multi-preview показывают `×N` полного project payload, target strip заранее показывает только pane-roots.

Cross-project commit меняет три представления одной сущности в строгом порядке: SQLite переносит строки и group JSON, main обновляет владельца живых PTY, затем renderer меняет Zustand и переключает workspace. Для группы это одна sync-транзакция с проверкой полного ожидаемого набора вкладок; перенос через обычный batch запрещён, потому что тот намеренно очищает `groupId`. Destination получает новый group id, но имя, цвет, статус, collapsed-state и внутреннее visual-subtree сохраняются. Ошибка любого preflight оставляет исходный проект источником правды без частичного UI-переноса.

`pointerdown` создаёт только pending-жест: pointer capture начинается после movement-threshold, когда клик уже доказанно стал drag. Ранний capture на внешней outline-row оказался не безобидной оптимизацией: Chromium перенаправлял завершившийся trusted click с внутренней вкладки на захвативший wrapper. В production-логах click присутствовал, но host-handler переключения вкладки не вызывался и active tab не менялся. DnD-wrapper и владелец primary click могут быть разными DOM-узлами, поэтому pending-фаза обязана сохранять нативный click pipeline.

Геометрия границ снимается по фактическим `top` всех rendered rows, включая CSS `gap` и строки переменной высоты. `row.height` нельзя использовать как общий pitch: при 27px строке и 3px gap первое движение вверх раньше вычисляло следующую границу ниже исходной и визуально толкало вкладку вниз. Если DOM ещё показывает прежний порядок после controlled preview, такая stale geometry не принимается до следующей layout revision. Когда root-only group пересекает nested boundary, host может отклонить raw-slot и выбрать соседний допустимый: источником правды после этого является boundary принятого slot, а raw pointer-boundary остаётся только диагностикой. Иначе preview и следующий geometry resolve расходятся и группа замирает на вложенных строках.

FLIP остаётся только presentation-layer: same-slot pointer updates не отменяют переход, большой source и edge-scroll получают прямой layout без очереди анимаций. Вертикальная перестановка анимирует Y, а принятой смене depth принадлежит X-анимация; scroll-anchor продолжает единолично компенсировать Y, поэтому horizontal FLIP не должен повторно сдвигать строку по вертикали.

При нажатии/отпускании Cmd X-origin берётся из последней физической координаты, включая ещё не показанный pointer-frame: накопленное до Cmd движение не становится командой. Для plain folder hover одного снятия Cmd-gate недостаточно. Reorder считает позицию от точки захвата карточки и может сдвинуть header ещё в зазоре перед ним; partial interior hold тоже проигрывал плавному OS-подходу. Пока pointer подходит к непустому header, Y не перескакивает через него; сам header владеет локальным dwell, проход за него возвращает обычные допустимые slots. X, guards, один painted release и cancel остаются общими.

X-outdent может переместить строку ниже большого бывшего parent-subtree без движения pointer. Пакет сохраняет исходный `grabOffsetY` и лениво создаёт ровно тот scroll-range, который нужен для прежнего screen-Y. Для короткого списка естественный максимум бывает отрицательным (`contentEnd - clientHeight`); браузерный `scrollHeight` скрывает этот underfill, поэтому одного clamped `physicalMax=0` недостаточно. Host ставит zero-height spacer последним элементом main-scroller, после EmptyDropZone: только так пакет измеряет реальный конец контента. После drop использованная часть reserve остаётся однонаправленным lease и уменьшается лишь когда пользователь прокручивает к естественному диапазону; немедленное удаление spacer снова оторвало бы строку от курсора и прыгнуло бы viewport.

TabSidebar имеет одну host-поверхность и один outline. Старое `isUtility` остаётся только полем совместимости при чтении прежних записей: такие вкладки включаются в основной outline до нормализации, а следующее сохранение пишет `false`. Фильтровать legacy-строки до миграции нельзя — это снова сделает существующие вкладки невидимыми. Старые main и Utils использовали независимые position-пространства, поэтому при одинаковых значениях loader обязан стабильно ставить main перед utility, а уже затем разрешать равенство по id; сортировка только по `position` могла перемешать две бывшие поверхности ещё до первого нормализующего сохранения. Нижний spacer теперь обслуживает только cursor-anchor, post-drop lease, append и edge-scroll; он не обозначает вторую категорию вкладок.

Узкий TabSidebar использует асимметричную границу жеста: пока pointer остаётся между `top/bottom` scroller, он может уйти левее или правее панели, продолжать X-команды и завершить drop последним нарисованным preview. Выход выше или ниже вертикального диапазона, `Escape` и `pointercancel` возвращают baseline. Это явный host opt-in, а не новый default всех списков; коридор действует только внутри renderer-окна Electron.

Multi-select пока сохраняет отдельный атомарный visual-block path для внутреннего reorder, но внешний payload больше не вычисляет самостоятельно. Один resolver нормализует выбранные visual-roots, исключает выбранного child под выбранным parent и раскрывает descendants только для project/sidebar destination. Это осознанная host-граница рендера, а не вторая семантика переноса; общий outline обслуживает обычный source, группы, visual-subtree, Y/X и Cmd.

Preview обновляет только renderer-state; persistence выполняется один раз на release. Host-приёмка 2026-07-16 подтвердила adjacent Y вверх/назад, parent-subtree, group click без cooldown, Cmd protected target, multi-select и точное восстановление order/parent/depth после `Cmd+Shift+R`; проверка Main→Utils из того прогона теперь является только историческим доказательством удалённой модели. 2026-07-17 пользователь отдельно подтвердил обычное переключение вкладки и продолжение/отпускание drag за боковой границей TabSidebar; подтверждение не распространяется на Settings или GT Editor. Причины прежних oscillation, accepted-slot freeze и stale commit сохранены в `knowledge/fix-иерархия-перетаскивания.md`, канон — в `docs-global/ux-паттерны/drag-and-drop/`.

После правки accepted boundary и удаления Utils 2026-07-29 shared, model, helper и SQLite-migration suites прошли `150/150`, production renderer/main build — PASS. Trusted Electron pointer-flow перенёс root-группу с тремя descendants через соседнюю строку и обратно без потери участников; X-outdent/indent отдельной вкладки дал FLIP только по X (`maxDeltaX≈16`, `maxDeltaY=0`) и сохранил layout после release. Две попытки native OS helper по-прежнему не дошли до `StructuredTabDnd:start`: это отдельный harness BLOCKED для физического системного курсора и edge-scroll, а не отмена подтверждённого renderer host-PASS.

### EmptyDropZone в vertical

Пустая область ниже последнего row — техническая зона для append/drop и быстрых жестов, но не отдельная визуальная команда. Double-click по ней создаёт новую terminal-вкладку в конце списка; ПКМ открывает контекст с create-строками и `Group`. Отдельный dashed `+ New tab` placeholder и нижний hover-background убраны: пользователь воспринимал подсвеченную нижнюю область как специальную drop-цель, хотя действие там означает только «нести ниже, в конец».

Пустая group-row — structural row со своим местом, а не правило «вкладка под группой обязана быть в ней». Bottom-drop ниже списка append'ит вкладку вне группы; чтобы положить вкладку внутрь пустой группы, нужен её body/placeholder `Пусто`, а не фон header. Это защищает от vacuous-check бага: `[].every(...) === true` заставлял последнюю пустую группу автоматически забирать любую вкладку, которую пользователь положил ниже неё.

Когда из группы уносят последнюю вкладку, группа сохраняет позицию через `anchorTabId` — id вкладки, которая визуально шла сразу после group-row. Перетаскивание пустой группы двигает anchor, а не несуществующие member-tab ids. Поэтому раскрытая пустая группа может свободно стоять в середине списка с chip'ом `Пусто`, а collapsed пустая группа свободно перемещается как обычная строка-контейнер.

## ID вкладки: копирование и вставка в Voice Record

Строка идентификаторов с26.09 разделяет четыре действия: Voice Record,
`+ часы`, `Copy / ID`, `UUID/Path`. Все берут вкладку под RMB либо выбранный
набор, а не активную вкладку. Voice Record получает ID в текущую основную запись
через main/HTTP с подтверждением от редактора. Если приложение открыто, но
живой записи нет, кнопка начинает новую; прежний отказ в idle отменён пользователем.
Вариант с часами добавляет UTC-дату/время до минуты на момент клика: пользователь
замечает баг и только потом нажимает кнопку, поэтому секунды создавали бы ложную
точность поиска. Обычный Copy ID и содержимое UUID/Path не изменились.
Закрытый VR и технический отказ дают toast, без молчаливого fallback в clipboard.
«Копировать сессию» и «Move to Project» из меню вкладки удалены по запросу26.09;
перенос вкладки через DnD сохранён. Меню группы — отдельная поверхность.

ID — непрозрачный адрес выбранной вкладки. С07.10 Voice-транспорт проверяет
только непустую строку до1024chars без whitespace/control/format-символов,
сохраняя весь адрес; форма не даёт оснований отказать. Ранее numeric-only,
затем `-tab-` whitelist последовательно ломали реальные orchestration/restored
вкладки, хотя Copy ID работал. Количество100 и exact recording ACK сохранены.

| Источник | Форма/контракт |
|---|---|
| Legacy creator и миграция коллизий | `<project>-tab-<counter>`; project может быть base64 либо new_project |
| Organization creator | `tab-<UUID>` |
| Restore старого архива | `restored-<UUID>`; V2/exact restore может сохранять прежний ID |
| Orchestration reservation | `<project>-tab-orchestration-<runId>`; runId непрозрачен |
| Inbox reservation | `<inbox-project>-tab-external-<hash>` |
| Fork/file/явный restoreId | Общий creator либо сохранённый адрес, без собственной гарантии префикса |

Проверено по creator/archive/orchestration/Inbox коду и живому каталогу135вкладок.
Это примеры существующих форм, не исчерпывающий whitelist транспорта. Фиолетовая
подсветка известной формы также не доказывает наличие вкладки.
См. [диктовку](fact-dictation.md#id-вкладки-в-живую-запись-voice-record).

## Правый слот контекстного меню: «Стоп» или «Запустить»

В контекстном меню вкладки правый слот всегда занят одной кнопкой. Пока на вкладке живой процесс — «Стоп» (со своими ветками: SIGTERM агенту, Ctrl+C скрипту). Пока не запущено ничего — «Запустить»/«Продолжить».

**Раньше второго состояния не было.** На незапущенной вкладке слот показывал серую надпись «Stop», которую нельзя нажать. Это худший из возможных ответов: место занято сообщением о том, что сделать нельзя ничего, ровно в тот момент, когда сделать нужно ровно одно — запустить. Юзер: *«если сессия не запущена, то отображать „Run“, чтобы её запустить»*.

**Живое действие вытесняет запуск**, в том числе на смешанном наборе выделенных вкладок: остановить лишнюю вкладку — потеря секунды, запустить агента там, где уже кто-то работает, — потеря контекста. Правило то же, что у кнопки состояния в переписке (`historyTerminalActivityAction.mjs`), только применяется к набору; отдельная чистая функция — `utils/tabMenuRunAction.mjs`.

**Запуск не дублируется.** Меню вызывает тот же общий слой запуска агентов (`historyAgentRuntimes::resume` / `startFresh`), которым пользуется кнопка состояния в переписке. Второй код запуска разошёлся бы с первым на первой же особенности — пометке «resume в пути» (`pendingResume`), авто-имени вкладки, снятии пометки «прервана».

**Подпись говорит, что именно произойдёт:** есть сохранённая сессия — «Продолжить», нет — «Запустить». Для набора это уже не одно утверждение, поэтому остаётся только число («Запустить 3»). Вкладке без агента (обычный терминал, файл, SDK-вкладка со своей кнопкой внутри) запускать нечего — слот остаётся, но пустым, иначе строка кнопок меняла бы ширину от вкладки к вкладке.

## Маркер статуса кликабелен: смена статуса на месте, без активации

Цветной маркер статуса сессии (слева от имени) — кнопка на всех поверхностях вкладки: карточка бокового списка, чип в шапке окна. Наведение — `cursor: pointer`; клик открывает список статусов у курсора; выбор меняет статус; повторный клик по активному снимает его. **Ни клик, ни выбор не активируют вкладку и не двигают фокус окна** (юзер: *«при этом фокус не меняется вообще никак»*).

Три слоя изоляции, и каждый обязателен:
- `stopPropagation` на `pointerdown` И на `click` самой кнопки — активация карточки живёт на click, а фокус берётся раньше;
- фокус окон в split-режиме стоит на window-**capture**-pointerdown (`TerminalArea`) и срабатывает раньше любой цели — поэтому там исключение по data-атрибутам (`data-tab-status-marker-button/-menu`, `data-task-plan-status-trigger/-menu`);
- меню закрывается по window-`mousedown` с `stopPropagation` внутри самого меню.

Квадратики ЗАДАЧ на нижнем шве карточки не кликабельны — они принадлежат заметкам и меняются там. Пикер задачных статусов в плане задач — другой словарь (`taskStatuses` vs `sessionStatuses`), но его триггер получил ту же изоляцию pointerdown.

Один компонент `TabStatusMarkerButton` (TabSignals) на обе вкладочные поверхности; список строк — те же `sessionStatuses`, что в контекстном меню вкладки.

## Multi-select persistence через `data-keep-selection`

Document-level `mousedown` handler в `TabBar.tsx` сбрасывал multi-select при любом клике вне `TabBar`. Это убивало основной use case — Shift'ом выделил несколько табов, ушёл в боковую панель редактировать кастомный промпт для batch-операции, выделение пропало на первом же клике в поле ввода. Юзер вынужден был помнить «не кликать в боковые панели, пока не отправил действие» — невидимое ограничение, читалось как баг.

Решение — exclusion-атрибут: handler проверяет `e.target` и всех родителей через `closest('[data-keep-selection]')` перед вызовом `clearSelection`. На обёртку любой панели, где multi-select должен выживать клики, навешивается этот атрибут. Атрибут вместо `useUIStore.preserveSelection` boolean'а сознательно: state приходилось бы синхронизировать на mount/unmount компонентов, легко desync'нуть. Атрибут на DOM-узле живёт ровно столько, сколько компонент в DOM, и checkable in-place без подписки.

Уход курсора в терминал, в Timeline, в любую другую панель **без** атрибута — `clearSelection` срабатывает как раньше: multi-select имеет смысл только пока юзер работает с инструментами над табами. Сценарий целиком — `methodology/сценарии-использования.md::Multi-select Persistence`.

## Code Map
- **UI:** `src/renderer/components/Workspace/TabBar.tsx` — логика меню, `RestartZone`, `onGenerateDragPreview` для multi-drag и `useEffect` для авто-скролла.
- **Logic:** `src/renderer/store/useWorkspaceStore.ts` — функции `getNextAvailableName`, `setTabCommandType`, `moveTabsToProject` (batch move).
- **IPC:** `main.js` — хендлеры `project:add-favorite`, `project:get-favorites`, `project:delete-favorite`.
- **Terminal:** `src/renderer/components/Workspace/Terminal.tsx` — перехват ввода для детекции типа процесса и блокировки дублирующих AI сессий.
- **InfoPanel:** `src/renderer/components/Workspace/panels/InfoPanel.tsx` — кнопки claude/claude-c/claude-f также вызывают `setTabCommandType`.
- **Knowledge:** [`knowledge/fact-data-persistence.md`](../knowledge/fact-data-persistence.md) — детали реализации массового переноса.

## Долгая операция над вкладкой называет себя вместо названия

Для Delete и Rewind пользователь отдельно запросил такой же фоновый индикатор,
как у микрофона: в общем правом верхнем углу status + имя вкладки, клик возвращает
к ней. Это именованный указатель на фоновую работу, не перенос tab-scoped error
в чужое окно. Видимость определяется показанными pane tabs: unfocused, но ещё
видимая вкладка не является фоновой. JSONL-результат остаётся до возврата к
владельцу или закрытия chip; закрытие результата не отменяет удаление и не Undo.
Один visual component используется для mic и history; native Rewind сохраняет
свой existing result lifecycle. Renderer reload/app restart этим transient
presentation store не объявляются восстановленными операциями.

### Мгновенная отметка закрытия

По прямому уточнению17.10 длительность cleanup допустима, молчаливый onset — нет.
Общий closeTab публикует «Закрытие…» до первого await для AI и обычных вкладок;
это принятый UI intent, не archive/Stop success. Ref-count exact Tab отделяет
пересекающиеся closes, отказ снимает свою отметку, late cleanup не откатывает
свежий Map/нового владельца. Confirmation, archive-before-Stop, каскад файлов и
вердикт Close сохраняются. Реальный private Close показал метку до удаления;
поздний launch после Close отдельно проверен с явно задержанным IPC и настоящим
Main fence. Управляемая задержка не объявляется natural provider race.

### Ранняя вкладка Fork и ручное имя

По решению12.10 обычный PTY Fork и Compact Fork из ПКМ сначала создают durable
целевую вкладку прежней фабрикой, затем проверяют источник и копируют историю.
Раньше Compact Fork ждал копии до создания вкладки: пользователь не мог задать
имя во время долгой работы. С17.10 общий синхронный claim exact live Tab защищает
allocation от дубля без ложного source-loader; настоящая работа source остаётся
видимой по её lifecycle. Новая карточка показывает «Создание форка…». Двойной клик сразу открывает
обычный rename; сохранённое имя заменяет эту подпись, не отменяя саму подготовку.
SDK-вариант и clipboard reuse-in-place этим порядком не изменены.

В оконном Fork новая строка, её catalog/membership и место сразу после source
публикуются одной существующей factory onPublish после durable allocation,
PTY fence и save ACK. Нет промежуточного reserve-only render и append→reorder
полосы. Та же узкая публикация применяется оконным New/chooser; остальные
background/foreground callers сохраняют прежний порядок metadata. Main revision
продвигается сразу, более новая membership/closed catalog не затирается поздним
publisher. Активация всё ещё идёт общим navigation/readiness путём; уход
пользователя не разрешает позднему allocation забрать фокус. Это сокращение
работы до кадра, не обещание нулевой задержки или native pixel acceptance.

Второй plain click двойного клика не повторяет activation перед rename; первый
клик, modifier/file paths сохраняются. В реальном built-renderer17.10 ручное имя
проверено ещё при pending child, в том числе при четырёх Luna-turns в двух
workflow. Это не native OS first-click/hover proof.

Durable создание нового v2 ребёнка сохраняет только его строку, не metadata всего
окружения. Иначе правильный CAS чужой соседней вкладки с устаревшей renderer
ревизией срывал Fork ещё до copy/launch. Placement всё ещё строится из полного
актуального Map; собственные CAS/rollback и early rename не ослабляются. Legacy/
cold restore сохраняют прежний путь; общий механизм — `fact-data-persistence.md`.

Новая вкладка не получает SID/rows родителя. До собственного read identity
History показывает подготовку, Timeline — лёгкую адресную заглушку без reader.
Codex Fork уже в этой первой публикации получает выбранную пару источника из
актуального exact Tab, а не global defaults до конца копирования. Это начальный
выбор для отображения, не перенесённый parent/launch proof. Ultra остаётся
временной presentation-подсказкой, не persistent default. Новый выбор ребёнка
идёт прежним revisioned intent; поздний carried/source refresh не отменяет его,
включая SAME-SID и ожидание binding CAS. Ready/первый Send по-прежнему принадлежат
Main; initial label не разрешает ввод раньше готовности.
Проверка source и Compact-copy принадлежат Main launch transaction с прежними
PTY/lifecycle/Stop fences; fence берётся уже при создании shell, поэтому Stop
до OSC-ready тоже отзывает поздний запуск. Materialized compact child получает
точный empty-target CAS отдельно от live writer proof и сохраняется при отказе
последующего Resume. Ordinary Fork сохраняет прежний provider fork path.

Название и признак ручного редактирования сохраняются; pending label, context
fork action и launch fence — нет, включая первый v2 allocation record. Restart
не повторяет неизвестную незавершённую копию. Отказ оставляет уже созданную
вкладку с её именем и ошибкой, не удаляет историю и не объявляется готовым Fork.
Снятие подготовки покрывает success/refusal; native startup и загрузка готовой
истории затем используют свои прежние lifecycle/readiness состояния. Ошибка
запуска имеет Copy с адресом source/target; явный Stop не создаёт error-toast.

Первый Send в уже показанную, но ещё unbound Fork-вкладку не считается fresh
launch: общий send scenario видит pending Fork intent и ждёт прежнюю readiness
ветку. Иначе до первого OSC-ready он мог материализовать пустую беседу вместо
заказанной копии. Intent не объявляет процесс busy/ready и не заменяет конечные
target/receipt guards; FIFO, bounded wait и отказ неизвестного owner сохраняются.

Куда встаёт результат зависит от ФИЗИЧЕСКОГО места ПКМ, а не только от tab id.
Общее меню одно, поэтому раньше после создания оно звало global activation:
форк из pane заменял source chip, а форк из sidebar самовольно приезжал в окно.
Теперь opener передаёт exact surface host. ПКМ по pane/center создаёт fork
непосредственно справа от source в той же strip и сохраняет source chip; ПКМ в
левом списке создаёт только sidebar row. Если за время долгой операции source
ушёл из исходной pane, готовый durable fork остаётся в sidebar и не переписывает
новую пользовательскую раскладку.

Во всех вариантах project order остаётся `source → весь его visual subtree →
fork`, а fork получает `visualParentTabId=source`. Fresh fork не открывает
боковой terminal сам: per-tab `sideTerminalOpenTabs` не наследуется, primary
surface берётся из настройки новых вкладок, чей default — History/AI Chat.
Явно сохранённая пользовательская настройка terminal-primary может этот default
переопределить; скрыто форсировать terminal из fork-path нельзя. Тем же правилом
живёт SDK-форк.
