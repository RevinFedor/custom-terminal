# Возможности и границы

Noted Terminal — desktop workspace поверх локальных CLI. Поведение ниже относится
к source snapshot; фактическая проверка выпуска указана в [verification](verification.md).

## Работа с сессиями

Workflow организует окна и вкладки независимо от cwd. У вкладки сохраняются имя,
тип, разговор, рабочая папка, ответственность, план и связанные Markdown-файлы.
Несколько колонок/окон показывают разные сессии; многострочная полоса даёт видеть
соседние вкладки. Резерв/скрытые окна, sidebar, поиск/переключатель и пользовательские
категории помогают найти работу. Перенос вкладки не является новым agent launch.

History — основная читаемая поверхность Claude/Codex PTY: Markdown, thinking,
инструменты, diff, изображения и выбранные диапазоны. Тот же живой xterm остаётся
доступен сбоку/поверх workspace. Скрытие UI не останавливает процесс. Timeline
даёт точки сообщений, compact и переходы; история строится из native transcript.

## История и провайдеры

| Операция | Claude Code | Codex |
|---|---|---|
| Read/search/Timeline/Continue | Есть, branch-aware JSONL | Есть, rollout и native lineage |
| Desktop fork | Есть | Есть, provider-specific fork/resume |
| Desktop Rewind | Native flow | Native backtrack/rewind с proof binding |
| Desktop range edit/delete | Проверенные границы active branch | Отдельная copy-on-write child branch; исходный rollout сохраняется |
| Cross-session MCP fork/edit | Claude history tools, propose/apply и auto-fork protection | Mutation tools не поддерживаются; чтение доступно |

История разговора и изменённые агентом файлы — разные объекты. Rewind/edit не
означают автоматический Git rollback. Codex encrypted compact не является
доступным текстовым пересказом. Операции должны иметь точную identity источника;
совпадение текста или пустой старый экран этого не заменяют.

## Ввод, файлы и повторяемая работа

Общий composer сохраняет draft и поддерживает text/file/image/context chips.
Сохранённые промпты и группы, вложенные инструкции, заметки, timeline anchors и
связанные Markdown дают повторно использовать подготовленный контекст. Attachments
проверяются по выбранному action contract; local file link не равен загруженному
image asset. Ручной ввод в TUI остаётся доступным.

Обычные принятые Send исполняются Main FIFO с отдельными delivery receipts.
Provider queue и application queue могут отличаться; queued не означает completed.
Run After хранит отдельные карточки/условия продолжения: окончание выбранной
вкладки или группы, таймер, Loop, настройка модели и другие поддержанные действия.
Есть разные границы Claude/Codex. Ручной process Stop не равен Pause очереди.
Restart after запускает выбранную команду/dev-server после нужного AI completion.
Он не является второй системой исполнения agent prompt.

## Сотрудничество агентов

У долгоживущей AI-вкладки есть ответственность, план и файловый контекст. Built-in
subagents служат временной проверке; Terminal MCP создаёт/управляет отдельными
полноценными сессиями. Адресный вопрос владельцу и tracked поручение — разные
операции. Ответ на вопрос не запускает новую задачу.

Делегация хранит run, связь с источником и дочерние зависимости. Completion обычно
возвращает проверенный текст inline; result reader используется при явной ссылке,
старом уведомлении или восстановлении. Exact delivery не доказывает завершение
всей работы. Изменение рабочего Markdown может прийти владельцу отложенным
контекстом на следующем настоящем сообщении, без нового запуска его сессии.

## Внешние поверхности

- Terminal MCP: workspace actions, адресная переписка, делегация, планы/контекст,
  granular history search/read и provider-specific history tools.
- Project/tab REST+SSE: другой клиент управляет конкретными сессиями этого Mac.
- Inbox provider API: **Codex-only** run для внешнего приложения, которое владеет
  своим чатом; Noted владеет terminal execution и его результатом.
- Native iPhone и companion chat: отдельные приложения; не включены в этот checkout
  и требуют совместимой сборки/своих настроек. Доступность их публичных сборок
  нельзя выводить из наличия API Noted.
- Knowledge/browser/Electron/iOS/SC adapters: optional отдельные пакеты/процессы.
  Внешний native MCP CLI не обязан быть ребёнком хаба Noted. Новый процесс CLI
  читает свою регистрацию; hub restart не обновляет native inventory старого CLI.

## Диагностика

Context показывает заполнение разговора; usage — quota/account провайдера;
ресурсы — CPU/RAM/процессы/кэши компьютера. Они измеряют разные вещи. Есть activity,
process view, cache/storage сведения и локальный TXT export с выбранным периодом.
Полный transcript не прикладывается автоматически. [Troubleshooting](troubleshooting.md)
объясняет, какие данные собирать и какие сведения могут остаться в файле.

Отдельная Claude Agent SDK surface и legacy Gemini/mobile-web имеют свои runtime
и ограничения. Они не превращают основной PTY-путь в standalone daemon. Будущие
Gemini observer, quick-chat и automatic question→Telegram не входят в обещания
этой публикации.
