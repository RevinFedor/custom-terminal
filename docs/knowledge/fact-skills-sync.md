# Fact: Claude → Codex skills sync

Settings → «Системные» содержит ручную и фоновую синхронизацию пользовательских skills из `~/.claude/skills` в `~/.codex/skills`. Источник истины — Claude skills; Codex skills считаются derived-копией для одноимённых пользовательских skill-директорий. Это отдельная подсистема от зеркал `CLAUDE.md`, но живёт рядом с ними в Settings и в main IPC-модуле, потому что обе задачи — host-local file sync, а не project-specific state.

## Симптомы для роутера

- Codex при запуске пишет `Skipped loading N skill(s) due to invalid SKILL.md files`
- Codex skill устарел относительно Claude skill после правки `~/.claude/skills/<name>/SKILL.md`
- В `~/.codex/skills` есть локальный skill, которого нет в Claude, и пользователь боится что sync его удалит
- После ручного sync кнопка показывает успех, но при следующей правке Claude skill Codex опять расходится
- Изменение `~/.claude/skills` не подхватывается пока приложение запущено

## Copy contract

Синхронизация копирует только top-level директории из `~/.claude/skills`, исключая скрытые/system entries (`.`-prefix) и не-директории. Для каждого одноимённого skill в `~/.codex/skills` target сначала удаляется, потом копируется заново из Claude. Это намеренный overwrite: пользователь попросил «все скиллы, которые есть у Claude, копируются в skills кодекса с заменой», потому что Codex-версии могут устаревать.

Codex-only директории **не удаляются**. Это единственный предупреждаемый edge-case: если `~/.codex/skills/foo` есть, а `~/.claude/skills/foo` нет, UI показывает `Codex-only`, но sync оставляет директорию на месте. Иначе одна кнопка «синхронизировать» стала бы destructive для локально добавленных Codex skills, а пользователь прямо выделил этот пограничный кейс.

`~/.codex/skills/.system` не трогается автоматически за счёт общего hidden/system фильтра. System skills Codex принадлежат Codex installation, не Claude sync.

## Codex YAML frontmatter

Claude и Codex читают один и тот же `SKILL.md` format, но Codex parser строже к YAML frontmatter. Реальный пользовательский симптом после первого sync: Codex пропустил `browser-mcp-debug`, `external-research`, `electron-e2e-testing`, `web-app-e2e-testing` с ошибкой `invalid YAML: mapping values are not allowed in this context`. Причина была не в теле markdown, а в незакавыченном `description:`: внутри длинного описания есть фрагменты вроде ``Error: no result`` / `Covers: ...` / `{model: ..., effort: ...}`. Для YAML это выглядит как nested mapping внутри inline scalar.

Поэтому после копирования Codex-copy нормализует только frontmatter-поля `name` и `description`: разворачивает существующий inline scalar и записывает его как double-quoted YAML string с escaping `\`, `"`, CR/LF/TAB. Тело skill и остальные frontmatter-поля (`version`, `metadata`, если есть) не переписываются. Это важная граница: sync не должен «форматировать» чужой skill целиком, только обеспечить загрузку Codex.

Что пробовали и почему не оставили: прямой `fs.cpSync` без адаптации кажется правильным, потому что «skills одинаковые», но ломает запуск Codex на валидных для Claude skills. Исправлять сами Claude source-файлы тоже неверно: source может быть внешним/обновляемым под Claude, а требование строгого YAML возникло на стороне Codex derived-copy.

## Background watcher

Watcher стартует в main process при регистрации IPC, а не при открытии Settings. Пока приложение запущено, пользователь может редактировать `~/.claude/skills` в редакторе или через другой инструмент, и Codex-copy должна догонять автоматически без ручного нажатия.

Наблюдаются обе стороны:

- `source` = `~/.claude/skills`: любое изменение source debounced 300ms → sync Claude → Codex.
- `target` = `~/.codex/skills`: drift-событие debounced 300ms → тот же sync, чтобы ручная правка derived-copy одноимённого skill не стала permanent. Codex-only директории всё равно сохраняются по copy contract.

Сначала пробуется `fs.watch(root, { recursive: true })`. Если платформа/Node не поддерживает recursive watcher для этой папки, включается fallback: walk по дереву skills и `fs.watch` на каждую директорию. Если root skills ещё нет, watcher вешается на parent directory и ждёт появления `skills`. После каждого sync watcher пересобирается, чтобы новые подпапки попали в fallback-набор.

Как и в `CLAUDE.md` mirror, собственные записи в target игнорируются через in-memory TTL (`ignoreTargetUntil`, 1.5s). Без этого `fs.rmSync + fs.cpSync` сам провоцирует target event → новый sync → loop. Таймер здесь не решает «успех» операции; он только hysteresis для шумного `fs.watch`, а фактический success берётся из результата copy/normalize.

## Status surface

Settings получает push `skills:sync-status` от main process. Если модалка открыта, строка статуса обновляется без ручного pull: счётчики Claude/Codex, `Codex-only`, watcher state (`авто вкл` или время последней auto-sync), ошибка авто-синхронизации.

Ручная кнопка `Синхронизировать` после успешного IPC на 1 секунду меняется на оранжевое `✓ синхронизирована`. Это не источник истины для sync-state, а локальный acknowledgement клика: пользователь видит что именно его действие завершилось. Постоянная truth всё равно в строке статуса и push-событиях watcher'а.

## IPC contract

| Channel | Direction | Назначение |
|---|---|---|
| `skills:sync-claude-to-codex` | renderer → main | Ручной sync, возвращает copied/normalized/errors/status |
| `skills:get-sync-status` | renderer → main | Pull статуса при mount Settings |
| `skills:sync-status` | main → renderer | Push после watcher start, manual/auto sync или ошибки |

`status` включает `{ sourceDir, targetDir, sourceExists, targetExists, claudeSkills, codexSkills, missingInCodex, codexOnly, watcher }`.

