# Fact: Codesign + TCC — почему Accessibility ломается после rebuild

Каждый `npm run build:install` без правильной подписи **аннулирует Accessibility-разрешение** для приложения, хотя в System Settings → Privacy &amp; Security → Accessibility галочка остаётся включённой. Симптом: `systemPreferences.isTrustedAccessibilityClient(false)` возвращает `false`, `osascript ... keystroke "v"` тихо падает (или возвращает exit≠0), Global Dictation paste не работает.

Решение — **self-signed cert «Noted Terminal Dev» в login keychain** плюс быстрый локальный post-sign готового `.app`. Стандартный signer `electron-builder` намеренно отключён: он добавлял к частым dev-сборкам минуты. После однократного setup'а сертификата `npm run sign:local-fast` даёт приложению стабильную identity примерно за 2 секунды, и TCC grant переживает rebuild'ы.

## Симптомы для роутера

- В System Settings → Privacy → Accessibility у Noted Terminal стоит галочка, но `isTrustedAccessibilityClient(false)` → false
- Global Dictation чип появляется, recording-окно работает, но после STOP текст не вставляется в чужое приложение
- `osascript -e 'tell application "System Events" to keystroke "v"...'` отрабатывает с exit 1, stderr содержит `(-1719)` или `(-25211)`
- После `npm run build:install` permission «слетает» сам собой, нужно тыкать toggle в Privacy panel — но и это не помогает
- `codesign -dv /Applications/Noted\ Terminal.app` показывает `Identifier=Electron`, не `com.noted.terminal`
- `codesign -d -r-` показывает `designated => cdhash H"..."` (cdhash-pinned DR)
- TCC.db не возвращает строк по `client='com.noted.terminal'` или возвращает по `client='Electron'`

## Root cause: TCC хранит csreq, не путь

`/Library/Application Support/com.apple.TCC/TCC.db::access` для каждого grant'а хранит **`csreq` BLOB** — скомпилированное code-signing requirement-выражение, которое `tccd` evaluate'ит против code-signature **запущенного процесса**. Не путь, не bundle id — именно csreq. Путь (`client` column) — только для UI-отображения.

Для каждого типа подписи macOS генерирует разный designated requirement (то что попадает в csreq):

| Тип подписи | Designated requirement | TCC grant переживёт rebuild? |
|---|---|---|
| Apple Developer ID | `identifier "com.x" and anchor apple generic and certificate leaf[...]` | ✅ да |
| Self-signed keychain cert (`security import`) | `identifier "com.x" and anchor trusted` | ✅ да |
| Adhoc (`codesign -s -`) | `cdhash H"<sha256>"` | ❌ нет |
| Unsigned | (no DR — каждый запуск проверяется как новый) | ❌ нет |

**CDHash = SHA256 от CodeDirectory.** У полностью переподписанного adhoc-bundle он меняется вместе с содержимым сборки. У вообще не переподписанного Electron bundle основной бинарник может случайно оставаться байт-в-байт тем же между JS-only rebuild, поэтому на старом Mac grant иногда долго «работает без подписи». Это не стабильный контракт: смена Electron/macOS, перенос на новый Mac или переоценка невалидного bundle ломает такое совпадение. **UI toggle при этом может показывать «включено»**, хотя сохранённое требование уже не соответствует запущенному процессу.

## Почему `Identifier=Electron`, а не `com.noted.terminal`

Когда electron-builder запускается с `CSC_IDENTITY_AUTO_DISCOVERY=false` или `mac.identity: null`, он **полностью пропускает code signing**. В результате:
- `Contents/Info.plist` — наш правильный `CFBundleIdentifier=com.noted.terminal`
- Code signature на `Contents/MacOS/Noted Terminal` (главный бинарь Electron) — **оригинальная adhoc-подпись от команды Electron**, со встроенным `Identifier=Electron`
- `Contents/Frameworks/Electron Framework.framework/...` — также со старыми Electron-identifiers
- Helper apps (`Noted Terminal Helper (Renderer).app` etc.) — `Identifier=com.github.Electron.helper`

`codesign -dv` показывает **тот** identifier который встроен в CodeDirectory подписи — не то что в Info.plist. Чтобы исправить, надо переподписать с явным `--identifier com.noted.terminal` ИЛИ дать electron-builder подписать с корректной identity.

## Решение: cert + быстрый локальный post-sign

1. Один раз создаём cert через `scripts/codesign/setup-dev-cert.sh`:
   ```bash
   bash scripts/codesign/setup-dev-cert.sh
   ```
   Скрипт делает `openssl req -x509 ... -addext "extendedKeyUsage=codeSigning"` + `security import` в login keychain.
2. **Вручную** в Keychain Access: Login → «Noted Terminal Dev» → Trust → Code Signing = Always Trust → закрыть, ввести пароль.
3. Оставляем `CSC_IDENTITY_AUTO_DISCOVERY=false` и `build.mac.identity = null`, чтобы медленный стандартный signer `electron-builder` не запускался.
4. Сразу после `electron-builder` оба package-script'а (`build`, `build:install`) вызывают `npm run sign:local-fast`. `scripts/codesign/sign-local-fast.sh` делает один локальный `codesign --deep --timestamp=none`, затем обязательный `codesign --verify --deep --strict` и проверяет identifier/authority.
5. `npm run build:install` → `codesign -dv` должен показать `Identifier=com.noted.terminal`, `Authority=Noted Terminal Dev`. Сетевого timestamp, notarization и hardened runtime в локальном пути нет.
6. Один раз в System Settings → Privacy добавить установленное приложение в нужные разделы. **Дальше permission переживает rebuild'ы.**

### Почему не стандартная подпись electron-builder

На реальной 677-МБ сборке `@electron/osx-sign` обнаружил 247 «binary» paths: кроме Mach-O туда попали locale `.pak`, `app.asar`, data-файлы и даже Linux/Windows prebuilds. По умолчанию каждый путь подписывался отдельным `codesign --timestamp` с обращением к Apple. Это и было многоминутным замедлением, ради которого подпись отключили 2026-05-26.

Замеры на том же `.app`:

| Путь | Результат |
|---|---|
| Стандартный `@electron/osx-sign` + timestamp | многоминутный; остановлен после 13.9 с далеко до конца списка |
| Тот же walker без timestamp | 15.95 с |
| `sign-local-fast` (один local codesign) | 2.09 с, strict verify прошёл |

`codesign --deep` deprecated для production signing, но здесь используется сознательно только для локальной self-signed dev-сборки. Production distribution остаётся отдельным Developer ID + notarization pipeline.

## Diagnostic команды

```bash
# Что встроено в подпись сейчас:
codesign -dv --verbose=4 "/Applications/Noted Terminal.app" 2>&1 | grep -E 'Identifier|TeamIdentifier|Signature|Authority|CDHash'

# Каков designated requirement (это и хранится в TCC csreq):
codesign -d -r- "/Applications/Noted Terminal.app" 2>&1
# Self-signed cert → "designated => identifier \"com.noted.terminal\" and anchor trusted" ✅
# Adhoc          → "designated => cdhash H\"...\""                                      ❌ меняется на rebuild

# Что лежит в TCC.db (нужен Full Disk Access у Terminal):
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "SELECT service, client, auth_value FROM access WHERE service='kTCCServiceAccessibility';"
# Должно быть: 'kTCCServiceAccessibility|com.noted.terminal|2'
# Если client='Electron' или 'com.github.Electron.helper' — TCC привязал grant к неправильному identity.

# Reset TCC если что-то застряло:
tccutil reset Accessibility com.noted.terminal
tccutil reset Accessibility Electron        # на всякий случай, если был старый grant под этим id
```

## Что НЕ делаем (graveyard)

- **`CSC_IDENTITY_AUTO_DISCOVERY=false` без следующего `sign:local-fast`** — оставляет исходную подпись `Electron` и ломает persistent TCC. В текущем быстром pipeline env нужен, но только в паре с обязательным post-sign.
- **Обычный `electron-builder` signer для частых локальных rebuild** — корректно подписывает, но текущий walker подписывает сотни data-файлов по одному и с timestamp-сетью; это тот самый медленный путь, который не возвращаем.
- **`mac.identity: "-"`** (adhoc через electron-builder API) — лучше чем `null` (хоть переподписывает Electron framework), но всё равно adhoc → cdhash-pinned DR → grant не переживёт rebuild. Не путь.
- **`codesign --deep --force --sign -`** — всё ещё adhoc (cdhash-pinned) и не решает root cause. Текущий fast path принципиально использует постоянный keychain cert и `--timestamp=none`, затем strict-verify. Для production `--deep` не используется.
- **Удалять и заново добавлять в Privacy panel** — не помогает. UI обновляет `auth_value`, но **не csreq**, csreq остаётся пинить старый cdhash. Нужен `tccutil reset` + новое добавление.
- **Toggle off/on в Privacy panel** — тот же сценарий, помогает только сменить auth_value, csreq не обновляется.
- **Перенос .app в другую папку** — `client_type=1` (path-based) grants pinят к абсолютному пути, но всё равно csreq важнее пути. Не workaround.

## Production-distribution

Self-signed cert работает **только локально на нашей машине** — это не Apple-trusted chain. Для раздачи `.app` коллегам / в App Store нужен Apple Developer ID ($99/год) и notarization. Тогда:
1. `CSC_LINK` + `CSC_KEY_PASSWORD` env переменные (или import cert в keychain).
2. `mac.identity = "Developer ID Application: <Name> (<TEAMID>)"`.
3. `electron-builder --mac` подпишет всё корректно + сделает notarization-call к Apple.
4. Получившиеся `.app` будут работать у любого пользователя, TCC grant у каждого тоже будет персистент (потому что DR содержит TeamID + identifier, стабильный для всех билдов с одного cert'а).

Это отдельный production pipeline: для него нужно отключить local post-sign и вернуть штатную подпись `electron-builder` с Developer ID.

## Path-зависимости

| Файл | Что делает |
|---|---|
| `scripts/codesign/setup-dev-cert.sh` | Одноразовый setup self-signed cert'а через openssl + security import. Идемпотентный (skip если уже есть). |
| `scripts/codesign/sign-local-fast.sh` | Быстрый post-sign готового app, no timestamp/network, strict verification. |
| `package.json::build.mac.identity` | `null`, чтобы не запускать медленный стандартный signer. |
| `package.json::scripts.build/build:install` | После `electron-builder` обязаны вызывать `npm run sign:local-fast`. |
| `~/Library/Keychains/login.keychain-db` | Хранит cert + private key. **Backup'ить вместе с keychain'ом.** Утрата = новый cert + новый TCC grant. |

## Связанные системы

- **Global Dictation** ([`fact-global-dictation.md`](fact-global-dictation.md)) — root-consumer Accessibility permission. Без правильной подписи фича технически работает но paste-to-foreground падает.
- **Microphone permission** — отдельный TCC service (`kTCCServiceMicrophone`). Тот же csreq-механизм, та же проблема. Не починилось бы Pattern B / Pattern C автоматически — это известная регрессия в electron-builder v26+ для adhoc-подписи. С нашей self-signed подписью — работает.
- **Screen Recording** — если когда-то добавим (например screen-capture meeting mode из чипа №3 на скринах), та же история: persistent grant возможен только при stable DR.
