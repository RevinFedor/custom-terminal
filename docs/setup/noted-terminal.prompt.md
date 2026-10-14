# Установи Noted Terminal на этом Mac

Этот файл можно целиком передать **локальному AI с shell-доступом**. Исходники: https://github.com/RevinFedor/custom-terminal. Нужна source-сборка desktop-приложения для локальных Claude Code/Codex CLI, читаемой истории и управления рабочими сессиями. Обычный браузерный чат без доступа к компьютеру не может выполнить эти шаги.

## Поручение AI и границы

Проверь текущий Mac, скачай публичный checkout, установи отсутствующие общедоступные build dependencies, собери Noted и выполни локальные бесплатные проверки. Используй реальные пути этого компьютера. Сохрани существующие CLI-конфиги, аккаунты, проекты, рабочие процессы и установленное приложение. Не применяй reset, не удаляй userData, не запускай `build:install`/`build:i` и не копируй `.app` в `/Applications` в рамках этих шагов.

Пользователь сам выполняет login/2FA/OS permissions. Не проси credentials в AI-чате и не читай их ради диагностики. Установка **не разрешает model prompt или платный API-вызов**; первый inference-тест согласуй отдельно. Если ручной шаг недоступен, назови его и продолжай независимую подготовку. Не устанавливай companion-приложения и дополнительные MCP без выбранного пользователем сценария.

## 1. Проверить окружение

Поддерживаемый scope — macOS. Публикация проверяется на arm64; Intel/Windows/Linux не получали такую же приёмку. Проверь:

```bash
uname -m
sw_vers
node --version
npm --version
python3 --version
xcode-select -p
command -v git
command -v claude
command -v codex
```

Нужен Node22.12+ из ветки22, Git, Python3, Xcode Command Line Tools. Если зависимости отсутствуют, поставь их штатным package manager; системный диалог `xcode-select --install` завершает человек. При неверном Python задаётся свой `NODE_GYP_FORCE_PYTHON`, не путь из чужой машины.

CLI устанавливаются отдельно из [официальной документации Claude Code](https://code.claude.com/docs/en/setup) или [официальной документации Codex CLI](https://developers.openai.com/codex/cli/). Не угадывай package/version и не обновляй уже используемый CLI без решения пользователя. Claude login/подписка и Codex login/подписка либо API auth принадлежат провайдеру; отдельный API key не нужен для одной только сборки Noted.

## 2. Скачать и собрать

```bash
git clone https://github.com/RevinFedor/custom-terminal.git
cd custom-terminal
npm ci
npm run rebuild:native
npm run build:renderer
npm run test:setup
```

Применяй команды последовательно и проверяй exit/result каждого шага. `npm ci` устанавливает зависимости в checkout. Native rebuild готовит только его better-sqlite3/node-pty под pinned Electron. Markdown Editor и noted-shared source уже есть в `vendor`; внешние gt-editor/noted-shared checkout или непубличные npm-пакеты не требуются.

## 3. Подготовить local helpers

```bash
node scripts/install-terminal-mcp.mjs --dry-run
node scripts/install-claude-turn-hook.mjs --dry-run
```

Покажи человеку, какие управляемые файлы/записи будут изменены. Для работы lifecycle/редактора и MCP установи их с сохранением backup и чужих записей:

```bash
npm run install:terminal-mcp
npm run install:claude-hook
```

MCP: три runtime-файла в `~/.claude/mcp`, одна managed registration `terminal` в Claude/Codex. Hook: managed events/statusline в Claude settings, editor/helper files в `~/.claude/hooks`. Installer сохраняет остальные настройки и существующую HTTP registration. Не собирай эти JSON/TOML самостоятельно и не передавай credentials через аргументы.

## 4. Запуск

Сначала прочитай режим прав: managed launches используют Claude `--dangerously-skip-permissions` и Codex `--dangerously-bypass-approvals-and-sandbox`. Это отключает обычные per-action подтверждения/песочницу данного CLI launch. До первого managed launch явно согласуй этот режим, если он ещё не принят в поручении. Без такого выбора заверши сборку/проверки и оставь агента незапущенным.

```bash
npm run dev
```

Открой только свой экземпляр. GUI-действия выполняй доступными разрешёнными инструментами; если такого доступа нет, дай точный ручной шаг. Создай вкладку с существующим cwd; в native terminal человек завершает login. Проверь отдельно: процесс жив, неизвестный диалог отсутствует, settings применены и ввод готов. Не исправляй такой экран произвольным Enter/повторным Send.

Для локальной `.app` можно выполнить `npm run build:app`: результат остаётся в `release/`, подписывается ad-hoc, не устанавливается/не запускается. Это не notarized release и не доказательство успешного запуска на этом Mac. После user-approved открытия macOS может запросить permissions; dictation Mic/Accessibility optional.

## 5. Проверяемый результат

Бесплатный результат подготовки: dependencies установлены, build/test:setup прошли, local helpers проверены и свой GUI открылся. Статус app/HTTP не подтверждает CLI login или ответ модели.

Только после отдельного согласия на расход квоты отправь один короткий prompt без инструментов: «Ответь одной строкой: NOTED_READY; не вызывай инструменты». Сохрани ID вкладки/операции и проверь точный ответ в History. При потерянном HTTP ACK сначала читай ту же receipt/result, не создавай новую отправку. Реальное возвращение ответа — отдельный этап приёмки.

## 6. Optional integration и восстановление

Terminal MCP — локальный AI-клиент, workspace actions/history/delegation. REST/SSE — project/tab клиент. Inbox API — внешний чат с **Codex**, своим transcript и durable run. Knowledge MCP — отдельный сервер проектных docs; не обязательный компонент ordinary session. Native iPhone и SC/Voice Record устанавливаются отдельно.

Dev REST обычно7979, packaged7878; проверь actual port. Token подключения хранится локально в `~/.noted-terminal/web-token.txt` и не является ключом Claude/OpenAI или MCP identity. Не печатай его в итоговый отчёт. Адрес берётся из local connection info приложения; человек может скопировать его прямо в настройки своего клиента, без AI-чата. Для read-only `/api/me` локальный script читает token-файл в память и передаёт bearer-header без печати значения. Если адрес/listener недоступен, проверь startup/listen ошибку и actual port своего экземпляра; не меняй чужой runtime и не проси прислать token в переписку. Проверь authenticated `/api/me` и capabilities до действий; никогда не используй личный remote URL автора. Нужны работающие Mac и desktop runtime.

При ошибке сообщи не пройденный шаг, полную безопасную причину и точное действие. В работающем приложении используй экспорт TXT, выбирая период инцидента. Текст сообщений обычно не нужен для build/login/connectivity; raw logs/снимки терминала могут содержать личные данные. Не обещай универсальную очистку секретов. Не удаляй auth/history/DB для снятия ошибки.

В итоговом ответе назови checkout/commit, architecture/версии, какие команды прошли, какие configs изменены, открылся ли реальный GUI, выполнялся ли inference и получен ли точный ответ. Подменённый provider/temporary config/build не объявляй полноценной установкой или реальной работой модели.

Обновление: только своего экземпляра и чистого checkout, `git pull --ff-only`, затем `npm ci`, `rebuild:native`, `build:renderer`, `test:setup`, актуальные managed helper updates. CLI обновляется отдельно. Подробные страницы README/docs улучшают ориентирование, но этот файл содержит все обязательные шаги установки самостоятельно.

На Mac с уже работающим Noted обычный dev использует тот же userData. Для отдельной проверочной копии можно задать новую `NOTED_USER_DATA_DIR` и проверить startup path/отдельный REST port. Home CLI/helpers/MCP при этом остаются общими; такой запуск не разрешает их переустановку, restart общего хаба или чужих сессий.

Настройка optional API-ключей и пути ENV: [keys.md](keys.md).
