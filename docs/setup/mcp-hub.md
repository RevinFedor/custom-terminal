# Профиль общего MCP-хаба

Постоянные настройки этой машины находятся в `~/.noted-terminal/mcp-hub.json`,
вне bundle приложения. Main/controller и standalone-хаб читают один bounded
профиль версии1. Startup не пишет, не мигрирует и не chmod-ит его; не импортирует
команды из клиентских JSON/TOML и не ищет пакеты по каталогам автора.

Пример формы — пути условные, не defaults для исполнения:

```json
{
  "version": 1,
  "servers": {
    "browser": {
      "enabled": true,
      "command": "node",
      "args": ["/absolute/operator-supplied/browser/index.js"],
      "env": {},
      "stateful": false
    },
    "sc-desktop": {
      "enabled": true,
      "command": "/absolute/operator-supplied/sc/run.sh",
      "args": [],
      "env": {},
      "stateful": false,
      "reapMarker": "/absolute/operator-supplied/sc/server.js"
    },
    "electron": { "enabled": false },
    "ios": { "enabled": false }
  }
}
```

Поддержаны только шесть известных имён: terminal, knowledge, browser, electron,
ios, sc-desktop. Новому Mac необязательные пакеты и model credentials не нужны:
неиспользуемые интеграции можно явно отключить. Отсутствующая binding видна как
unconfigured, но не запускает пакет и не блокирует остальные валидные bindings.

Профиль владеет только перечисленными entries. Пропуск соседа в частичном профиле
не удаляет его прежний explicit ENV: миграция может идти по частям. Отключение —
только `enabled:false`, оно сильнее оставшегося ENV. Без profile entry действуют
прежние `NOTED_*_MCP_PATH` / `NOTED_SC_DESKTOP_MCP_COMMAND`; для terminal/knowledge
остаются defaults установленных helpers. Пустой/невалидный explicit путь — ошибка,
не признак необязательного отсутствующего пакета. Существующий профиль с
конфликтующим ENV не переписывается: соответствующая binding получает
`override_conflict`, остальные сохраняются. Совпадающий путь допустим.

Enabled entry сохраняет точные command, порядок args, env, stateful и reapMarker.
args обязателен; env по умолчанию пустой; stateful по умолчанию true для electron/ios.
Shell expansion нет. Для wrapper с иным именем фактического процесса нужен точный
absolute reapMarker. Последний произвольный argv/общий interpreter не являются
доказательством владения осиротевшим процессом. Секреты не помещать в argv.

Shared child получает обычный inherited ENV плюс explicit service ENV, но без
Main-only credentials и per-tab/project/identity/discovery полей. Публичные status/
логи не копируют ENV/argv/profile или сырые stderr. Сопоставление конфигурации
передаёт private fingerprint через loopback header; публичный ответ — boolean.
`configurationApplied` подтверждает captured registration definitions и explicit
profile ENV, не bytes executable, ambient ENV, native permissions или live-client
каталог. Готовность children проверяется отдельно. При несовпадении профиля
работающий хаб автоматически не заменяется; restart children не пересоздаёт Map.

Instance routing — отдельная версия. Новый Main публикует app-generation и
передаёт root/generation в служебном instanceRoute; hub с capability
`instanceRouting:1` переносит его per-request, terminal-client закрепляет оба
сервиса. Смена только terminal-child не обновит decoder старого hub. Порученное
применение требует согласованной смены поколения, не дополнительных stdio.
Старый host продолжает четырёхпольные вызовы; полный новый Main входит в следующий
обычный App build. Применённый standalone hub переживает App reopen, но старый
bundled cold launcher при смерти хаба может вновь поднять старый код. Runtime
PASS не доказывает, что bundle уже обновлён.

Malformed/unreadable/oversized (>64KiB)/заменённый во время чтения профиль
отказывает до cold start, не включает молчаливый fallback. Main закрепляет
fingerprint перед spawn: изменившийся затем профиль даёт
`profile_changed_before_launch` ДО listener/children. Следующее самостоятельное
ensure может читать исправленную конфигурацию; завершившийся старый вызов не
получает новую authority. Explicit standalone без Main сам захватывает свой
стабильный snapshot. Живой hub держит captured definitions до явной смены поколения.

## Существующая установка и будущее применение

Поручение восстановить работу MCP включает публикацию проверенных bindings и
штатный перезапуск нужного сервера/хаба: это обслуживание, не новый продуктовый
выбор. Не запрашивать повторное разрешение на каждый такой шаг. Сохранять явно
действующие ограничения пользователя, проверку активных RPC/удерживаемой работы
и запрет слепого replay; старое временное ограничение не переносить на новое
прямое поручение восстановить сервис. Установка приложения/прерывание AI — другие
действия и не следуют автоматически из одного перезапуска MCP.

Code-default пути старой версии не были персистентным профилем. URL
`/mcp/browser` сообщает имя маршрута, но не executable/args/reap marker. Без точных
старых bindings нельзя обещать автоматическую миграцию: нужны проверенные данные
локального владельца либо явное disable. Нельзя угадывать stdio по HTTP entry.

1. Проверить source diff/контроли и собрать coherent версию только в разрешённом
   пользователем build-окне. Полный Main по excerpt не заменять.
2. Проверить точные machine-local bindings. Подготовленный кандидат — не live
   config: сохранить существующие entries, overrides и permissions (обычно0600),
   перечитать исходные bytes перед атомарной публикацией. Этот repair не добавляет
   общего concurrent writer/CAS-сервиса; публикация требует исключения параллельной
   правки профиля. Не перезаписывать весь файл кандидатом.
3. Получить окно смены поколения и завершить работу исходных owners/requests.
   `pendingRequests=0` не является owner drain. App Build Install сам по себе не
   перезапускает detached-хаб и не доказывает применение нового профиля.
4. Зафиксировать PID/listener; один PID-guarded shutdown, подтверждённое освобождение
   порта, затем один новый hub из согласованного Main/standalone entry. Никаких
   параллельных настоящих stdio-копий.
5. Проверить config match, ожидаемые registrations, initialize и tools/list
   каждого нужного child, затем реальный доступ уже живых клиентов. SC53127
   ChatGPT job не доказывает Browser MCP53133→3458/HH. Если клиент удержал старый
   каталог, reconnect/restart требует отдельного согласованного действия после drain.
6. Rollback сохраняет последующие чужие правки: восстановить лишь проверенные
   bindings по текущим bytes и вновь проверить незавершённую работу владельцев
   перед штатной сменой поколения. Изменение файла
   не является применением его к живому Map. Сам repair не разрешает paid/tool calls.
