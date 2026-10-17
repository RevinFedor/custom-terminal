# GitHub и сохранение исходной истории Noted Terminal

## Выбранный репозиторий и история

Fedor14.10 выбрал существующий `RevinFedor/custom-terminal` и локальную `main`
как источник актуального кода. Отдельный root snapshot был отвергнут; ошибочно
созданный `RevinFedor/noted-terminal` удалён по прямому поручению пользователя с
его ручным подтверждением паролем. Удаление проверено через GitHub UI и API404.
Новый основной репозиторий вместо прежнего создавать нельзя.

Локальная и remote main разошлись ещё от общего предка4апреля. Normal fast-forward
невозможен; прежний183-file merge conflict не является несовместимостью183фич.
Приоритет локального кода реализован history-only merge: два родителя сохраняют
обе линии, tree берётся из актуального локального кода с проверенными setup/docs
адаптациями. Это `-s ours`, не `-X ours`: старые неконфликтующие remote-файлы не
подмешиваются в текущий продукт. Все484локальных и72remote-only коммита сохранены.

После объяснения разницы Fedor прямо разрешил удалить исторические ключи и
приватные экспорты с изменением SHA. Даты, авторы, сообщения и parent-граф
сохранены; точная исходная история находится в отдельном приватном bundle.
Позднее отдельно разрешено удалить восемь строк `Co-Authored-By` с Claude.
Основной автор этих коммитов уже был RevinFedor; код и сами коммиты из-за авторства
не удаляются. `apple-developer-chat-request.txt` также исключается из обеих
публикуемых веток и всей их достижимой истории, а не только из нового tree.

При первой очистке filter-repo схлопнул26повторённых коммитов с совпавшими
метаданными/tree/parents. Восстановление использует непрозрачный дополнительный
Git-header `noted-history-id`: он сохраняет отдельную идентичность всех606исходных
коммитов без публикации прежних SHA. Приватный salt/map в Git не входит.
Не применять pruning и не терять пустые/повторённые коммиты при следующей очистке.
Перед push проверять отдельность коммитов, авторов/дат и отображение parents;
публиковать только выбранные refs с точными leases, не backup/private refs.

## Ветки GitHub и сохранённые старые версии

Удаление из текущего tree и `.gitignore` не скрывают старую историю. Даже после
очистки всех публикуемых refs GitHub может отдавать прежние объекты по старому
SHA: после push14.10 это подтверждено авторизованным Contents API для Zen fallback,
Gemini credential в трёх старых generated JS bundles и технического ChatGPT capture.
Обычный clone очищенных веток
их уже не включает. Private repo закрывает посторонний доступ, но не доказывает
физического удаления прежних объектов и не отзывает уже раскрытый ключ.

Для полного удаления серверных объектов/кешированных представлений предусмотрен
GitHub Support; подробности в [официальной инструкции](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
У credential риск снимает отзыв/ротация. Прочитанный capture содержит technical
audit/диагностику и короткие хвосты запросов/ответа, а не подтверждённую личную
Telegram-переписку: прежнее определение «личная переписка» было чрезмерным.
Проверенный original Telegram path по старому локальному SHA даёт GitHub404;
raw local историю не публиковали. Это не полный ручной аудит каждого retained
старого файла. Если оба раскрытых ключа уже отозваны, ожидание Support только из-за
этого technical capture не является обязательным условием source publication.
Не обещать срок автоматического удаления старых SHA; contributor-refresh24часа
не означает такой же срок server GC. У реальной личной переписки ротации нет.
Предыдущие SHA и примеры приватного содержимого не публиковать как способ
подтверждения очистки. Текущую видимость и прямое чтение старого SHA проверять
отдельно от remote HEAD/clone. Статус обращения и публичности вести в рабочем tmp.

## Scanner не заменяет проверку credential expression и captures

Первичный scanner0 и две Luna-проверки отдельного snapshot пропустили hardcoded
OpenCode Zen fallback `ENV || literal`.14.10 подтверждено, что literal остался в
source/public copy и июньской remote main; значение не публиковать и не проверять
inference-запросом. Закрытие GitHub-доступа не отзывает уже открытый credential:
действующий ключ требует ротации владельцем. Проверять также default/fallback
expressions, compiled JS/env inlining, копии source в test artifacts, private
сообщения/captures/DB, а не только новые строки с `key = ...`.

У исходной main подтверждены private Telegram exports и непустой Gemini credential
literal в исторических generated bundles. ID/token/nonce из тестового job protocol
не объявлять внешним API-ключом только по regex. User-selected реальный screenshot
Fedor разрешил без замазывания сессий; это не общее разрешение публиковать все captures.

## Публикация и установленное приложение — разные границы

Build/native/renderer проверки14.10 выполнены в изолированном checkout,
соответствующем перенесённому в основную main source. Это не проверка на другом
Mac. Прежний anonymous clone подтверждал отвергнутый snapshot; после containment
тот repo стал private, затем удалён пользователем. Новый авторизованный clone
canonical repo и anonymous доступ — отдельные проверки. Scanner0 не подтверждает
отсутствие credential из-за найденного false negative. GUI/login/provider-result/
другой Mac acceptance не выполнялись.

Portable adaptations перенесены в source основной main с сохранением чужих
dirty/staged правок:
bundled noted-shared0.2.0 и текущий Markdown Editor source, явный native drag
compiler, checkout-local native/build scripts, ad-hoc build без install/open,
optional configurable MCP adapters, локальный connection URL вместо author VPS
и точечная JSON-secret редакция. Gemini helpers получают настроенный локальный
ключ через ограниченный IPC, а не baked renderer literal; пустой build define
сам по себе сломал бы прежние helpers. Zen fallback удалён, используемый ключ
перенесён в локальный ENV; [ключи и их назначение](../setup/keys.md).
Установленное приложение и параллельная справка Fedor не обновлялись этой работой.

Новые пользовательские инструкции входят в основную source main:
`docs/setup/macos.md`, `docs/setup/noted-terminal.prompt.md`, `docs/verification.md`.
Изолированные source/native/renderer проверки относятся к описанному checkout;
авторизованный clone основного repo проверяется отдельно от anonymous доступа.
Source build не является notarized installer; managed CLI bypass-mode, ручной
login/permissions и расход квоты описаны до первого agent launch/prompt.

Текущий главный рабочий файл владельца — `docs/tmp/установка-и-справка.md`.
Отчёты, manifest, clean clone, build logs и локальная .app не входят в public tree.
