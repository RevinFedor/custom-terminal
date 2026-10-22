# Установка Noted Terminal на Mac

Эта инструкция устанавливает локальную source-сборку из [публичного репозитория](https://github.com/RevinFedor/custom-terminal). Готового notarized installer здесь нет. Ни один шаг сборки не должен заменять уже установленный Noted Terminal или запускать AI-запрос.

## Требования

- macOS; проверка этой публикации проводится на Apple Silicon. Intel не проходил тот же сценарий.
- Git, Node.js 22.12+ из ветки22 с npm, Python3 и Xcode Command Line Tools. Последние нужны для native-модулей Electron. `xcode-select -p` должен возвращать установленный toolchain; при его отсутствии используйте штатный `xcode-select --install` и завершите системный диалог.
- Для работы с агентом — отдельно установленный Claude Code и/или Codex CLI, доступ к выбранному аккаунту/модели и native login.

При необходимости Node22/Python/Git можно установить своим package manager. Это общедоступные зависимости, а не личный Python-путь или сертификат автора. `NODE_GYP_FORCE_PYTHON` можно задать своим абсолютным путём, если node-gyp выбирает неправильный Python.

## Скачать и собрать

```bash
git clone https://github.com/RevinFedor/custom-terminal.git
cd custom-terminal
node --version
python3 --version
xcode-select -p
npm ci
npm run rebuild:native
npm run build:renderer
npm run test:setup
```

`npm ci` ставит зависимости в этот checkout. `rebuild:native` подготавливает better-sqlite3 и pinned node-pty под Electron28.3.3; изменение native-модуля происходит только здесь. `build:renderer` сначала собирает bundled Markdown Editor, затем frontend/main. Noted shared source и редактор включены в `vendor/`; клонировать приложения автора не нужно.

Для диагностики задержек коротких команд `npm run dev` также атомарно готовит
pinned JS observer очереди node-pty, без пересборки native binary. Pack hooks
включают тот же observer; ASAR validation отказывает при его несовпадении.
Уже запущенный процесс эту JS-правку автоматически не подхватывает.

Установочные проверки используют временные конфиги и подменённые процессы. Они не проверяют вход в провайдера и не отправляют prompt.

## Helpers и Terminal MCP

Сначала посмотрите изменения:

```bash
node scripts/install-terminal-mcp.mjs --dry-run
node scripts/install-claude-turn-hook.mjs --dry-run
```

Для полноценного Claude lifecycle/external-editor нужны hooks и statusline. Terminal MCP нужен для управления вкладками и чтения истории из локального AI. После просмотра:

```bash
npm run install:terminal-mcp
npm run install:claude-hook
```

Установщик MCP копирует три файла в `~/.claude/mcp/` и добавляет только запись `terminal` в `~/.claude.json`/`~/.codex/config.toml`. Существующая HTTP-регистрация сохраняется. Hook installer записывает managed hooks/statusline в `~/.claude/settings.json` и helpers в `~/.claude/hooks/`; посторонние hooks сохраняются. При изменении существующих конфигов создаются backup-файлы. Не подставляйте конфиги автора и не перезаписывайте файлы целиком.

Постоянные привязки и сохранение существующих MCP при обновлении описаны в [профиле хаба](mcp-hub.md). Установка приложения сама по себе не доставляет профиль уже запущенному detached-хабу.

Свежий CLI-процесс читает новый MCP-конфиг; уже работающий процесс может требовать штатного нового запуска. MCP hub управляет только установленными/явно настроенными адаптерами. Browser/electron/iOS/SC/knowledge не являются обязательными зависимостями первой сессии.

## Первый запуск и первый ответ

```bash
npm run dev
```

Откройте рабочую область, создайте AI-вкладку, выберите существующую папку и установленный CLI. Ручной login выполняйте в его живом терминале. Учётные данные и2FA вводит человек; не передавайте их агенту в переписке.

Managed launch в этом снимке включает bypass confirmations/sandbox: Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`. До первого agent launch проверьте, подходит ли это для выбранного доверенного проекта.

```text
CLI найден → процесс запущен → login/подготовка завершены
  → ввод готов → согласованный prompt принят → ответ появился в History
```

Последний шаг расходует квоту подписки или деньги выбранного API. Только после согласия на такой тест отправьте, например, «Ответь одной строкой: NOTED_READY; не вызывай инструменты». Проверьте ответ в History и сохранённый transcript. Не считайте PID, spinner или успешный POST готовым ответом.

Noted использует ваш способ авторизации CLI. `.env` и отдельные API-ключи не обязательны для установки; optional providers/диктовка требуют собственных ключей только при их использовании. Не включайте их в сборку/коммит.

## Локальная .app

```bash
npm run build:app
```

Сборка остаётся в `release/`, использует локальную ad-hoc подпись, не копируется в `/Applications` и не запускается автоматически. Она не notarized и не является готовой публичной binary distribution. macOS может повторно запросить permissions после её пересборки. В этом выпуске проверяется arm64; путь для Intel отличается.

После отдельного решения о запуске откройте локальную `.app` обычным способом. Для packaged runtime нужны уже установленные helpers и Node в доступном PATH. Mic/Accessibility давайте при использовании соответствующей диктовки; обычная AI-сессия не требует этих дополнительных возможностей.

**Не используйте `build:install`, `build:i`, `build:i-obs`, `build:i-cont` или `build:i-c` для первого знакомства.** Это maintainer paths: они могут остановить и заменить установленное приложение и зависят от локального certificate-backed install flow. Они не входят в этот public quickstart.

## Обновление

Остановите только свой экземпляр, сохраните draft/работу и прочитайте изменения совместимости. В чистом source checkout:

```bash
git pull --ff-only
npm ci
npm run rebuild:native
npm run build:renderer
npm run test:setup
```

Если обновлены helpers, повторно посмотрите dry-run и примените managed updates. CLI обновляется отдельно своим официальным способом, не автоматически вместе с Noted. При локальных изменениях не делайте reset: сохраните их или создайте новый checkout. Не удаляйте пользовательскую БД, transcript или auth для обновления.

## Подключения и ошибки

[API/MCP](../api.md) описывает разные адреса и ownership. Dev REST обычно7979, packaged —7878, но actual port может измениться при конфликте. Пользователь копирует адрес/token своего Mac; домен автора не требуется. Для внешнего клиента Mac и desktop runtime должны работать.

[Диагностика](../troubleshooting.md) помогает отличить отсутствие CLI, login, settings error, port/token, неготовый ввод и неизвестную доставку. [Verification](../verification.md) сообщает, какие шаги этой версии исходников реально проверены.

На Mac с уже работающим Noted обычный dev использует тот же userData. Для отдельной проверочной копии можно задать новую `NOTED_USER_DATA_DIR` и проверить startup path/отдельный REST port. Home CLI/helpers/MCP при этом остаются общими; такой запуск не разрешает их переустановку, restart общего хаба или чужих сессий.


Installer backup создаётся рядом с изменённым JSON/TOML как `.bak-<timestamp>`.
Для rollback после закрытия своего CLI восстановите только прежнюю managed
registration/managed hooks/statusline из backup, сохранив более новые чужие
записи. Не перезаписывайте весь конфиг старой копией при параллельных изменениях.
Copied helpers можно оставить, пока на них ссылается другой runtime.

Настройка optional API-ключей и пути ENV: [keys.md](keys.md).
