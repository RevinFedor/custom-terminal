# Feature: проектные промпты из файлов

## Независимые roots после workflow cutover

Каталог остаётся производным от дисковых `.prompt.md`; пользовательские Projects
больше не задают доступность. Реестр roots независим от живых вкладок/архива,
а effective bindings принадлежат exact tabId. Миграция сохраняет порядок,
provenance и прежнюю область, а не объединяет roots всех cwd внутри workflow.
Source-child наследует точный набор; explicit empty binding остаётся пустым.
Удалённый/отсутствующий root не исчезает после неудачного scan. Future opaque
scope копируется с исходной version, без молчаливого downgrade.

Workflow settings → Sources заменяет прежний редактор источников в prompt picker.
Внутри явно выбирается target-вкладка; Save меняет только её bindings по прежним
revision/CAS. Manage folders открывает тот же независимый registry, Add folder
не связывает root автоматически со всеми вкладками workflow. Неизвестный ACK
повторяется с тем же request, поздний read после смены target не перетирает выбор.
Opt+V
фиксирует исходную вкладку до await, использует тот же каталог и watchers;
обычная Insert Prompt library остаётся отдельной. Legacy project endpoints и
project usage labels в GT Editor сохраняют wire compatibility как provenance,
а не новую organizational authority. Legacy описание ниже не означает возвращение
обязательного Project для создания вкладки.

## Legacy модель данных и совместимость

Проект хранит не копии промптов, а упорядоченный список корневых директорий в
SQLite-таблице `project_prompt_sources`. Каталог всегда производный от диска:
для каждого root Custom Terminal рекурсивно читает только
`<root>/docs/**/*.prompt.md`. Содержимое файлов не записывается в таблицу
`prompts` и читается только в момент вставки.

Это разделяет два вида библиотеки:

- обычные prompts/groups принадлежат Custom Terminal и управляются в Settings;
- project prompts принадлежат рабочим репозиториям и следуют за файлами на диске.

## Прежние настройки проекта

Один `EditProjectModal` используется независимо от точки входа в настройки
проекта. В секции «Промпты» root можно вставить абсолютным путём и подтвердить
Enter либо выбрать через нативный directory picker. Для основного пути проекта
есть короткое действие «Использовать папку проекта».

При сохранении:

- `~` разворачивается, пути нормализуются до абсолютных;
- symlink и его real path считаются одним источником;
- одинаковые, вложенные и перекрывающиеся roots отвергаются как
  `overlapping_prompt_sources`, иначе один файл мог бы появиться несколько раз;
- написание выбранного пользователем пути сохраняется для ключа общей раскладки
  sidebar, даже если canonical identity вычислен через `realpath`;
- отсутствующий root или `docs` не удаляется молча: UI сохраняет источник и
  показывает его состояние. Если root существует, но `docs` ещё нет, watcher
  стоит на самом root; полностью отсутствующий root повторно проверяется при
  следующем чтении/открытии настроек, а не через несуществующий filesystem watch.

## Сканирование и порядок

Сканер игнорирует dot-entries и symlink-ветки, чтобы не уходить за root и не
зациклиться. Суффикс `.prompt.md` проверяется без учёта регистра. Заголовок
промпта — имя файла без этого суффикса.

Sources показываются по естественной алфавитной сортировке display-name. Если у
двух roots одинаковый basename, к имени добавляется parent path. Внутри source
порядок совпадает с общим file explorer:

- сначала применяется persisted layout из
  `~/.noted-terminal/shared/file-layout.db` для точного root;
- учитываются ручной sibling order и visual file-parent связи;
- для ещё не разложенных элементов fallback — директории перед файлами и
  natural filename order.

Чтение usage для GT Editor проходит все открытые и архивные tab bindings.
Одна общая source-папка у сотен bindings не означает сотни отдельных обходов:
внутри ОДНОГО синхронного запроса переиспользуются scan/exists/realpath/project
metadata. Ключ scan включает исходный namespace, точное написание пути,
display-name и manual layout; symlink alias не теряет свои ID/порядок. Каждая
привязка всё равно проходит sourcesForTab и signature guard, tab catalog
получает отдельные records/file_paths. После возврата request maps исчезают;
это не новый долговечный кэш и не увеличение TTL. Natural sort использует один
Collator с прежними locale/numeric/base rules, включая стабильные равные имена.
Причина: GT poll2500ms превышал TTL1500ms, поэтому повторные scans и создание
Collator на каждое сравнение синхронно тормозили общий Main даже при пустом
ответе usage. Изменение свежести или удаление архивных bindings для ускорения
не требуется. Точные измерения и границы — performance-карта07.10 lag754.

В usage повторно используется подготовка четырёх source SELECT, но не их ответы:
namespace, exact scope/version и bindings/root rows читаются заново для каждой
привязки. Reader живёт только в текущем usage; самостоятельный watcher-pass
создаёт свой reader. Между catalog-pass и последующим watcher-pass разделяется
только подготовка SQL: второй проход получает новую карту stat(root/docs), а
также свежие scopes и registrations. Нельзя переносить в него файловый proof
первого прохода или превращать reader в общий row-cache: это скроет внешний commit
и explicit empty/future-version exact-tab scope.

Один watcher-pass наблюдает каждый точный root один раз. Это не атомарный снимок
FS: создание/удаление между прежними повторными stat может быть замечено только
следующим чтением. Существующий missing-root recovery сохраняется; проверка
inode существующего watcher по тому же pathname этим не вводится.

Каталог кэшируется максимум на 1,5 секунды. `fs.watch` на `docs` (либо на root,
пока `docs` не создана) инвалидирует его с debounce 180 мс и рассылает
`project-prompts:changed` во все окна. Настройки, sidebar и picker не должны
создавать собственную долговечную копию каталога.
Снятие watcher отменяет его pending debounce. И callback, и timer проверяют
точного владельца записи до invalidation, чтобы позднее событие старого watcher
не стерло timer нового владельца того же пути. `close()` очищает текущих владельцев;
явное последующее использование сервиса допустимо, старые callbacks — нет.

## Opt+V и контекстная вставка

Если у активной вкладки есть project prompts, первой строкой левой колонки
picker идёт проект: его изображение либо фиолетовая `MessageSquareQuote`, затем
имя проекта. Обычные groups/ungrouped prompts остаются ниже в прежнем порядке.
Справа project prompts разделены компактными заголовками source-директорий.
Пустой проект не создаёт декоративную строку.

Тот же каталог используется в Opt+V и в prompt-ветке контекстного меню. Target
фиксируется при открытии picker: последующее переключение вкладки не должно
перенаправить вставку. Обычный выбор читает актуальный `.prompt.md` с диска и
вставляет содержимое через существующий безопасный prompt pipeline. Cmd-клик
вставляет только голый абсолютный путь как обычный редактируемый текст: без
prompt-чипа и без Claude-специфичного `@"…"`. Несколько путей разделяются
переносами строк. Сам catalog row хранит `file_paths`, а не дублированный текст.

## Чипы в файловом дереве

Для каждого видимого root `usageForRoot` строит компактное соответствие
`файл → проекты`. У project prompt под именем файла показывается фиолетовый
read-only chip с `MessageSquareQuote` и именем проекта. Он не участвует в DnD и
не заменяет существующие кликабельные chips, которыми файл привязан к AI-tab.

Тот же usage доступен GT Editor через авторизованный HTTP endpoint
`GET /api/project-prompt-usage?root=...`, поэтому обозначение одинаково в обоих
приложениях без чтения чужой SQLite.

## Основные точки и тесты

- catalog: `src/main/project-prompt-catalog.js`;
- persistence: `src/main/database.js::project_prompt_sources`;
- IPC: `src/main/ipc/project-prompts.js`;
- settings: `src/renderer/components/UI/EditProjectModal.tsx`;
- picker: `src/renderer/components/Workspace/PromptPickerOverlay.tsx`;
- chips: `src/renderer/components/Workspace/Sidebar.jsx`;
- unit: `project-prompt-catalog.test.js`, `prompt-menu-template.test.js`.
