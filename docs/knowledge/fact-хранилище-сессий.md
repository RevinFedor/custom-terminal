# Хранилище AI-сессий и очистка диска

## Почему сессии занимали десятки гигабайт

Проблема состоит из двух множителей. В длинном Codex rollout каждый top-level
`compacted` хранит `replacement_history` — новый снимок накопленного контекста.
В измеренной сессии размером 1,40 ГБ 64 compact-записи занимали 1,32 ГБ, то
есть 94,1% файла. Затем обычный Fork, Resume-child, Edit Range, Delete Range и
Rewind создают следующий rollout и снова переносят уже накопленные snapshots.

Снимок 23 августа после первой ручной очистки: 2 134 Codex-файла занимали
63,2 ГБ; 899 файлов с `forked_from_id` содержали 57,6 ГБ. 180 файлов крупнее
100 МБ занимали 44,7 ГБ. Prompt images занимали только 122 МБ и не были
причиной переполнения.

Claude хранит transcript в `~/.claude/projects`: primary JSONL, sidechain
subagents, `tool-results` и многочисленные `.bak`/`autorepair`/manual recovery
копии. В том же снимке 484 primary/subagent JSONL плюс recovery/sidecar data
занимали около 2,4 ГБ. Поэтому Storage является provider-neutral поверхностью,
хотя удаление у Claude и Codex физически различается.

## Принятый продуктовый контракт

- Все сессии открытых вкладок сохраняются без таймера.
- Физические source-файлы, необходимые открытой thin-fork сессии, считаются
  частью открытой сессии и тоже защищены.
- Claude subagent открытой родительской сессии защищён для инспекции.
- Все остальные session-файлы по умолчанию удаляются через один день после
  закрытия/последнего изменения. Home History row может остаться metadata-only:
  название, проект и дата видны, но Preview/Resume после удаления невозможны.
- Таймер можно переопределить по группе: 1/3/7/30 дней либо Never.
- Renderer не решает, что безопасно удалить. Main отдаёт `deletable`,
  `protectedReason`, closure и opaque item ID, затем повторно проверяет тот же
  scan generation перед записью.

Отсутствие сессии в текущей prod DB само по себе не является доказательством
«мусор»: dev/prod имеют разные SQLite, standalone CLI/worktree/subagent могут
использовать общий `CODEX_HOME`. Это не блокирует принятую политику удаления
закрытых данных, но требует provider-side deletion и проверки живых writer
locks вместо raw `unlink`.

## Home UI

Storage живёт на глобальном Home между `MCP servers` и `AI processes`.
Порядок секций отражает причинность: сначала внешние servers, затем их данные
на диске, затем живые процессы. Все три секции используют фон самого Home,
тонкие горизонтальные границы и одинаковые заголовки; отдельной внешней
«window/card» вокруг Storage нет.

Это только визуальный порядок, не общая загрузочная транзакция. Storage
монтируется независимо от process discovery и начинает filesystem scan только
после раскрытия; зависший поиск MCP/AI-процессов не имеет права скрыть disk UI.

Storage имеет три вкладки с английскими названиями:

1. `Sessions` — provider switch `All / Codex / Claude`, поиск и сортировка по
   size/date/iterations.
2. `Codex builds` — Cargo debug/release targets, worktree builds, packaged app
   и защищённый installed runtime.
3. `Noted Terminal data` — DB backups, active databases, Chromium caches и
   prompt images.

Session groups также пользовательские, а не внутренние:

- `Open now`;
- `Regular sessions`;
- `Forks`;
- `Rewinds & edits`;
- `Subagents`;
- `Outside Noted Terminal`;
- `Recovery copies`.

`Home History` не является группой: это значение `Source = Noted Terminal` на
карточке. V2 lineage также не отдельная группа; source получает понятное
`Required by an open session`. При Cmd-hover общий `ControlHint/Tooltip`
объясняет определение группы и текущий timer.

Строка показывает title/UUID, source, date и size. Правая область лениво
дочитывает iteration count только после явного выбора сессии: раскрытие Storage,
смена provider или сортировки не выбирают самый большой файл автоматически и
общий scan не парсит гигабайтные transcript. Там же видны полный path, parent,
retention, protection reason и размер provider deletion closure.

## Main-owned inventory

Один bounded scan использует только:

- async directory traversal и `stat`;
- первые 512 КБ session-файла для session meta/первого prompt;
- `tabs`, `tab_history`, `favorites` и `session_history_events` текущей DB;
- main-owned runtime session IDs;
- `du -sk` только для агрегированных build/app directories.

Scan single-flight/cache имеет immutable generation fingerprint по item ID,
size, mtime, protection и settings. Действие удаления передаёт opaque IDs и
generation; main заново сканирует и отказывает при изменении. Непосредственно
перед каждой session deletion он ещё раз проверяет runtime и `tabs`, чтобы
вкладка, открытая после confirmation, не была удалена.

Claude tool-results учитываются в размере primary session и удаляются вместе с
ней. Recovery JSONL с тем же session ID остаётся отдельным item и не становится
защищённым только из-за открытого primary файла.

## Удаление и retention

- Claude primary/recovery JSONL удаляется exact unlink после main preflight;
  owned `tool-results` directory удаляется вместе с primary.
- Codex canonical session удаляется только через installed
  `codex delete --force <uuid>`. Это обновляет upstream thread metadata,
  проверяет writer locks и fork/history references. Raw unlink запрещён.
- Codex parent с descendants не участвует в автоматическом sweep, пока leaves
  не удалены отдельно. Так один timer item не удаляет скрыто целое дерево.
- Build directories удаляются только явным Dashboard confirmation. Automatic
  sweep пока не трогает их, потому что другой worktree может компилироваться без
  main-owned build lease.
- DB recovery backup можно удалить exact unlink; active DB/Chromium/prompt
  assets защищены своими владельцами.

Automatic sweep стартует через 90 секунд после app-ready, кроме E2E. Один
проход ограничен 25 items либо примерно 2 ГБ и повторяется через 15 минут, пока
есть eligible leaves; спокойный интервал — шесть часов. Изменение settings
перевзводит sweep. `Clean ready` и `Delete now` используют inline two-step
confirmation и показывают точный count/bytes.

## Шрам первой ручной очистки

До появления этого сервиса четыре явно разрешённые пользователем неоткрытые V1
full-copy были удалены raw unlink (5,65 ГБ). Они self-contained и не затронули
96 открытых Codex rows, но upstream thread metadata/session_history_events могли
сохранить missing parent. Автоматически «чинить» эти записи прямой DB-правкой
нельзя; reader должен fail-visible, а будущая deletion идёт только через
provider API.

Параллельно `cargo clean --profile dev` удалил 46 261 generated files / 15 GiB
из root Codex target. Installed runtime оставался в
`~/.noted-terminal/bin/codex`; source checkout не удалялся.

## Неочевидная карта реализации

- Global Dashboard → `StorageBrowser` → `storage:*` IPC; renderer получает
  готовую классификацию и не передаёт filesystem path для удаления.
- `storage-inventory.js` соединяет filesystem meta с Noted DB и строит open
  dependency closure.
- `storage-cleanup-service.js` владеет generation check, retention и
  provider-specific deletion.
- MCP/AI process blocks и Storage используют один Home visual grammar и общий
  Cmd-tooltip, но process Stop и file Delete остаются разными контрактами.
