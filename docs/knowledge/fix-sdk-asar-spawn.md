# Fix: Claude SDK `spawn ENOTDIR` в packaged-сборке

## Симптом
В upgraded production-сборке любой клик «Send» в SDK-табе ронял IPC `claude-sdk:send-message`:
```
[ERROR] [ClaudeSDK] send-message failed: spawn ENOTDIR
[ERROR] [SlashProbe] probe-commands fatal: spawn ENOTDIR
[ClaudeSDK] failed to read model capabilities: spawn ENOTDIR
```
В dev (`npm run dev`) — всё работало. После провала в UI оставалось «висячее» юзер-сообщение без hover-кнопок Repeat/Edit, и единственным способом переотправить промпт было перепечатать его руками — see `fact-claude-sdk-tab.md::Repeat/Edit на непрошедших user-bubble'ах`.

## Причина

`@anthropic-ai/claude-agent-sdk` под капотом spawn'ит **нативный 207MB ARM64 Mach-O бинарь** (`claude-agent-sdk-<plat>-<arch>/claude`). SDK резолвит путь к нему через `createRequire(import.meta.url).resolve(<platformPkg>/claude)` из своего `sdk.mjs`. В упакованном Electron-приложении `sdk.mjs` живёт **внутри** `app.asar` — resolver отдаёт путь вида `.../app.asar/node_modules/.../claude`.

Electron-builder патчит `fs` и `require` так, что чтение по такому пути прозрачно идёт в asar-архив. Но `child_process.spawn(<asar-path>)` **не патчится** — POSIX'у asar — это файл, не директория, и не исполняемый файл. POSIX возвращает `ENOTDIR`, потому что бинарь хочет лежать **внутри** этой «директории», а директорией оказался asar-архив.

`build.asarUnpack` в package.json физически кладёт бинарь в `app.asar.unpacked/`, но **не меняет** что вернёт `require.resolve` — путь по-прежнему указывает в `app.asar`.

## Решение

Резолвим путь к бинарю один раз при первом обращении, переписываем `app.asar/` → `app.asar.unpacked/`, передаём результат в каждый `query()` как `options.pathToClaudeCodeExecutable` — SDK тогда не дёргает свой внутренний resolver и `child_process.spawn` получает реальный путь на диск.

Resolver (`src/main/main.js::resolveClaudeBinaryPath`) пробует три кандидата подряд:
1. `require.resolve('@anthropic-ai/claude-agent-sdk-<plat>-<arch>/claude')` — direct.
2. `<sdkDir>/../<platformPkg-без-scope>/claude` — top-level sibling (если npm дедуплицировал).
3. `<sdkDir>/node_modules/<platformPkg>/claude` — nested (если не дедуплицировал).

Каждый кандидат после получения переписывается на `app.asar.unpacked/` и проверяется `fs.existsSync`. Первый существующий — победитель, результат кэшируется. Передаётся в три точки входа SDK: `loadSdkModelCapabilities`, `sdkStartQuery`, `claude-sdk:probe-commands`.

В package.json `build.asarUnpack` остаётся обязательным — он создаёт физический файл, которым resolver и пользуется:
```json
"asarUnpack": [
  "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/**",
  "node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/**",
  "node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/**"
]
```
Третий путь покрывает реальный кейс этого билда: npm не дедуплицировал optional-dep, бинарь оказался по `@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, а не на top-level.

## Что пробовали и почему не сработало

1. **Только `asarUnpack` без явного `pathToClaudeCodeExecutable`** — бинарь физически распакован, но SDK всё ещё резолвит к asar-пути. `ENOTDIR` остаётся.

2. **`createRequire(path.join(sdkDir, 'sdk.mjs'))` + `sdkRequire.resolve(<platformPkg>/claude)`** — первый помощник для `sdkDir` был `require.resolve('@anthropic-ai/claude-agent-sdk/package.json')`. В Node 22 это падает с `ERR_PACKAGE_PATH_NOT_EXPORTED`: у SDK в package.json `exports`-поле не выставляет `./package.json` наружу. В логах: `[ClaudeSDK] cannot resolve SDK package dir — falling back to default executable lookup`. Переделали — резолв через main entry `require.resolve('@anthropic-ai/claude-agent-sdk')` отдаёт прямой путь к `sdk.mjs`, оттуда `path.dirname()` достаём SDK-папку. Это сработало.

3. **`path.join(sdkDir, 'node_modules', '@anthropic-ai', platformPkg, 'claude')`** — двойная склейка скоупа. `platformPkg` уже содержит `@anthropic-ai/`, на выходе получалось `.../node_modules/@anthropic-ai/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`. В логах: `claude binary not found on disk. Candidates tried: nested: .../@anthropic-ai/@anthropic-ai/...`. Поправили на split: `platformPkgName = platformPkg.replace(/^@anthropic-ai\//, '')` для sibling-кандидата (где сам scope-сегмент строится), и оставили `platformPkg` без склейки для nested.

## См. также
- `fix-packaged-app-logs.md` — другая asar-ловушка (запись через `fs.createWriteStream` в asar читается без ошибки, но молча игнорится).
- `fact-claude-sdk-tab.md::Repeat/Edit на непрошедших user-bubble'ах` — UI-recovery для случая, когда `send-message` отвалился по этой ошибке.
