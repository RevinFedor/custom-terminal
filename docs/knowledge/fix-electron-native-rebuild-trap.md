# Fix: `electron-rebuild` падает на чужих native-модулях, восстановление из prod-сборки

## Симптомы
После `npm install <native-module>` (например, `node-pty@1.2.0-beta.13`) запуск `npx electron-rebuild -f -w node-pty` валится **не на node-pty**, а на `better-sqlite3`:

```
Expected in: /usr/lib/libexpat.1.dylib
make: *** [Release/sqlite3.a] Error 1
node-gyp failed to rebuild 'better-sqlite3'
```

После этого приложение не стартует — `Error: Could not locate the bindings file. Tried: better_sqlite3.node`. `npm install` вытер старый `.node`, а компиляция нового падает на отсутствии `libexpat` (Xcode 26 на macOS Sequoia не поставляет dylib, который ожидал SQLite source).

## Root cause
`electron-rebuild` без `--only` пытается пересобрать **все** native-модули в `node_modules`. Если хотя бы один не компилируется на текущем Xcode SDK — упадёт весь процесс. Целевой модуль (node-pty) может уже быть собран успешно, но другой (better-sqlite3) ломает rebuild на полпути.

Помимо этого `npm install <X>` иногда удаляет существующие `.node` файлы других модулей (вычищая `build/Release/`), даже если они в зависимостях не менялись — npm перестраивает `node_modules` целиком и удаляет artefacts.

## Фикс

### 1. Всегда `electron-rebuild --only <name>` после `npm install`

```bash
npm install node-pty@1.2.0-beta.13 --save
npx electron-rebuild -f -w node-pty --only node-pty
```

Опция `--only` ограничивает rebuild конкретным модулем — даже если better-sqlite3 рядом сломан, node-pty соберётся успешно.

### 2. Restore `.node` из установленной prod-копии

Если `.node` всё-таки был удалён `npm install`'ом — **не пытайся компилить** (Xcode не соберёт). Восстанови из последней успешной prod-сборки:

```bash
cp "/Applications/Noted Terminal.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
   ./node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

Работает если:
- Версия модуля в `package.json` не менялась с последнего `build:install` (проверь `cat /Applications/Noted\ Terminal.app/.../package.json | grep version`).
- Electron major version не менялась.
- Архитектура совпадает (`file` должен показать `Mach-O 64-bit bundle arm64`).

### 3. Локальный backup готового `.node` (рекомендуется)

После каждого успешного `build:install` копировать критичные `.node` в `tmp/native-cache/`:

```bash
cp ./node_modules/better-sqlite3/build/Release/better_sqlite3.node tmp/native-cache/
cp ./node_modules/node-pty/build/Release/pty.node tmp/native-cache/
```

При следующем падении restore-rebuild — копировать обратно. Это надёжнее чем `/Applications/...`, если юзер удалил prod-копию или не build'ил давно.

## Что не сработало
- **`npm install` без аргументов после поломки** — npm не перестраивает существующие native, только что-нибудь обновляет в lock. `.node` остаётся отсутствующим.
- **`npx electron-rebuild` без `--only`** — падает на better-sqlite3 (Xcode 26 missing libexpat) даже когда целевой модуль ОК.
- **`brew install expat` + retry** — не помогает, SQLite source искал именно `/usr/lib/libexpat.1.dylib` (system) а не brew prefix.

## Code map
- `package.json::scripts.build:install` — kill prod + `npx electron-builder` собирает свежие native под Electron 28 ABI; копия в `release/mac-arm64/`.
- `node_modules/<X>/build/Release/<X>.node` — artefact, теряется при `npm install`.
- `/Applications/Noted Terminal.app/Contents/Resources/app.asar.unpacked/node_modules/<X>/build/Release/` — последний рабочий artefact.
