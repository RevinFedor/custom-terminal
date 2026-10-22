# Поиск сообщений падает только в packaged: зависимость оказалась под соседним пакетом

20Oct2026. `search_user_messages` возвращал HTTP500 с `ERR_MODULE_NOT_FOUND`:
`micromark-core-commonmark/lib/content.js` не находил `micromark-util-subtokenize`.
В исходном `node_modules` пакет был установлен; переустановка зависимостей и
подавление ошибки парсера не устраняли бы подтверждённую границу упаковки.

Pinned electron-builder25.1.8 / app-builder-bin5.0.0-alpha.10 при `--flatten`
возвращал этот пакет только как `micromark.conflictDependency`. Реальный copier
по такому дереву сохранял его в `micromark/node_modules`, откуда sibling
`micromark-core-commonmark` читать его не может. Поэтому наличие пакета где-то
в ASAR не доказывает возможность импорта из конкретного модуля. Внутренняя
причина классификации flattener как conflict не установлена; его ошибочное
дерево и последующее размещение воспроизведены непосредственно.

Сохраняющее исправление — один явный `build.files` mapping полного locked
пакета в общий `node_modules/micromark-util-subtokenize`, с исключением его
вложенного `node_modules`. Обычный production collector и pruning сохраняются;
версии зависимостей и поведение поиска/Markdown не меняются.

Регрессия [packaged-user-message-search.test.mjs](../../scripts/packaged-user-message-search.test.mjs)
использует настоящие builder collector/file selectors и физические private
OLD/GREEN деревья. Старое размещение даёт ту же ошибку реального
`UserMessageHistory.search()`, новое сохраняет поиск, классификацию prompt и
исключение цитированного wrapper; отдельно разрешаются173 runtime import edges.
Сессии в этом контроле синтетические: он не подменяет HTTP/ASAR проверку после
установки. При проверке релиза нужны импорт из упакованного sibling и реальный
поиск, а не только целостность перечисленных в архиве файлов.

Команда: `node --test scripts/packaged-user-message-search.test.mjs`.
Проверка входит в `npm run test:setup`; она не запускает Electron или provider.
