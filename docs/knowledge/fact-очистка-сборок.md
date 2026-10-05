# Очистка сборочных копий без удаления рабочих данных

Симптом: после освобождения места диск снова заполняется, хотя приложения,
словарь и фотографии сами по себе не объясняют десятки гигабайт. В октябре2026
значительную часть занимали сохранённые тестовые `.app`/распаковки и сотни
поколений WebODM bundles. Каталог `sc-desktop` содержал также копии Voice Record;
место хранения не является доказательством владельца или необходимости файла.

## Граница с Storage и историями

Это developer housekeeping, отдельный от Home Storage session retention.
Он не вызывает provider delete и не обходит защиту открытых/родительских сессий.
Cargo targets, transcript, library.db, media, Docker volumes, установленные apps,
профили и источник проекта не входят в кандидаты.

Сборочные scripts читаются из checkout, поэтому этим хукам не нужен reinstall
Noted Terminal. Общая реализация находится в custom-terminal, wrappers — в SC,
Voice и Habit. Отсутствующий соседний checkout оставляет artifacts и предупреждение,
но не превращает уже выполненную установку в failed.

## Подготовленный пакет не равен мусору

Маленькая module-only правка раньше сохраняла candidate, распакованный ASAR,
backup и retired целиком; повторение фаз давало несколько сотен MB на каждую.
После точного SHA-256 proof установленного ASAR удаляются candidate/contents/
retired, остаются rollback и receipts. Это structural install proof, не UX acceptance:
backup нужен и при renderer-crash нового пакета.

`prepared` отмечается до тяжёлого копирования, `verified` — после install proof;
маркер публикуется атомарно. Старое имя каталога не разрешает удалить новый stage
внутри него. Без installed receipt/verified marker возраст не доказывает завершение:
автоматический проход оставляет такой пакет пригодным для продолжения.
Разовая legacy-очистка по явному `--before` — отдельное разрешение, не default timer.

Обычный sweep выбирает завершённые artifacts старше48часов и оставляет два
новейших rollback bundles каждого продукта по CFBundleIdentifier через все roots,
а не один backup в каждой исторической фазе. `.app` mtime наследуется при копировании;
свежесть определяется generation marker/именем группы, не старой датой бинарника.

## Когда срабатывает

- SC/Voice `npm run build:install`: post-hook после основной команды;
- Habit `deploy.sh`: в конце успешного deploy, не в `--check` или error-path;
- точечные SC vocabulary/practice install scripts: после package proof;
- private translator E2E: после закрытия test app снимается только зарегистрированный
  `dist`; screenshots/profile/logs/source остаются.

Сам Habit уже очищает один фиксированный DerivedData перед новым build; его
последний результат не уничтожается этой уборкой. Системные simulator/device
support данные и чужие произвольные `/tmp` folders не являются доказанными leftovers.

## WebODM: два независимых host-каталога

Webpack `[name]-[hash].js` раньше оставлял старые names в app/static/app/bundles,
collectstatic — вторую копию в build/static/app/bundles. Docker pre-clean не
очищает host; `.dockerignore` также исключает эти каталоги из нового runtime.

Post-success plugin запускается после BundleTracker done publication. Сохраняются
manifest-current, три новейших поколения каждого root и48часов свежих assets.
При failed/compiling manifest, отсутствующем current asset, смене manifest или
непроверенном symlink удаления нет. Неизвестные/non-hashed файлы не удаляются.
Нельзя заменить это `output.clean=true` до успешной публикации: это теряет прошлую
работающую сборку при error и не учитывает второй каталог collectstatic.

## Proof и аудит

Exact realpath/dev/inode, payload stat и revision маркера повторно проверяются
после awaited audit перед deletion. `ps/lsof` не заменяются предположением «нет
процесса» при ошибке канала; обращения пересматриваются между groups/пакетами.
Открытый/работающий generation пропускается. Удаляются конкретные leaves, не
весь userData, workspace или test root.

App cleanup пишет attempt/removed + summary в штатный Noted deletion audit;
Webpack — в build/bundle-cleanup-audit.jsonl своего checkout. Exact paths/time/
operation ID сохраняются. CLI stdout ограничен summary/sample: полный inventory
из тысяч paths сам раздувал бы Codex transcript и его будущие forks.

Fixtures покрывают смену proof, symlinks, prepared/recent roots, open-file/probe/
audit failure и сохранение rollback/evidence. Маленький настоящий Webpack compile
проверяет hook order; он не заменяет полный app build или UI acceptance.
