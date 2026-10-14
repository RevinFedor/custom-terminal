# Проверка исходников — 14 октября 2026

Публикуется source checkout с сохранённой историей разработки. Это не подписанный
binary release и не проверка установки на чужом компьютере.

| Проверка | Результат и предел |
|---|---|
| История до новых publication commits |606исходных commits сохранены: authors, dates, messages и parent graph проверены. Private payload/ключи удалены, SHA изменились |
| Source install |Обычный `npm ci` в изолированной копии прошёл; bundled editor/shared packages не требуют соседних репозиториев |
| Native rebuild |Подготовлены better-sqlite3/node-pty для Electron ABI119; живое приложение не перезапускалось |
| `build:renderer` |Editor/main/renderer сборка прошла; synthetic Gemini build-key canary в renderer отсутствует |
| `test:setup` |45/45PASS,0skips:43setup checks плюс2runtime-key checks |
| Diagnostic export + runtime key |8/8PASS: временные файлы, оба text policies, actual IPC registration с синтетическим ENV; provider не вызывается |
| Secret scan |Известные credential values проверяются отдельно от regex; model-name срабатывания классифицируются как false positives, scanner не заменяет privacy audit |

Gemini-ключ читается runtime Electron main из ENV и передаётся существующим local
renderer actions через один IPC. Он не встраивается Vite в JS bundle. Zen больше
не имеет встроенного ключа. Пример конфигурации — [ENV](setup/keys.md).

Два Luna review и scanner нашли исходные publishing risks; дополнительная
проверка обнаружила пропущенный fallback key и старый API-header key. Они убраны
из всех публикуемых исторических версий. Private reports и точный backup исходной
истории остаются вне Git. Все user-selected desktop/iPhone PNG скопированы без blur
или генерации интерфейса. Непубличные captures/DB/logs/config исключены.

Не выполнялись: CLI login/GUI/OS permissions на новом Mac, реальный prompt/result,
iPhone/companion E2E, paid inference/transcription, installation/replacement в
`/Applications`, notarization. Исторические app/UI tests вне перечисленных проверок
не объявляются все пройденными. Installed app/CLI пользователя не обновлялись.

Переносимый `build:app` раньше проверялся на той же frozen code base с real native
smoke и ad-hoc `.app`; этот новый кандидат проверен source/native/renderer tests.
Повторный binary release не выполнялся. История source и готовность установленной
сборки — разные границы.
