# Feature: приём переноса файла из GT Editor

## Почему это не обычный Cmd+V

GT Editor кладёт в системный clipboard собственный format
`application/x-gt-editor-file-transfer-v1`. В нём находится короткий ticket, а
не текст документа и не file URL. Custom Terminal перехватывает `Cmd/Ctrl+V`
только когда файловый sidebar реально владеет фокусом и clipboard содержит
валидный неистёкший ticket. Во всех остальных случаях paste продолжает идти в
xterm, SDK composer или другую активную поверхность.

Sidebar получает keyboard-focus и видимую 1px рамку при открытии. Клик задаёт
destination так:

- выбранная папка → эта папка;
- выбранный файл → его родительская папка;
- пустое место дерева → корень текущего sidebar.

Клик по заголовку директории не равен выбору корня: это существующий directory
picker. E2E для root обязан нажимать именно пустое место файлового дерева.

## Межприложенческий commit

`GtEditorTransferClient` читает ticket, проверяет destination и discovery
`~/.noted-terminal/gt-editor-api.json`, затем вызывает авторизованный
`POST /api/file-transfer/commit`. Custom Terminal намеренно не делает локальный
`rename`: только GT Editor знает актуальный dirty/Untitled-текст, открытые окна,
project membership и свои path-keyed состояния.

После успешного ответа Custom Terminal:

1. переписывает собственные ссылки `oldPath → newPath` в tab/history file path,
   project open-file path и JSON-массивах prompt file references;
2. инвалидирует project prompt catalog;
3. рассылает событие смены пути открытым renderer-окнам;
4. перечитывает дерево, раскрывает parent при необходимости и ставит selection на
   новый файл;
5. показывает тост `Файл перенесён: <имя>` справа сверху.

Тост использует общий непостоянный контракт `showToast` и живёт 2500 мс. E2E
должен фиксировать его сразу после завершения paste, а не считать отсутствие на
снимке через 3+ секунды продуктовой ошибкой.

## Надёжность

- Ticket не содержит authority на произвольный filesystem move: GT сверяет
  `handoffId` со своим durable outbox.
- Истёкший или неизвестный ticket, недоступная destination и выключенный GT
  возвращают явную ошибку; исходный файл не удаляется.
- Повтор того же commit идемпотентен и возвращает уже выбранный `newPath`, не
  создавая `-копия-02`.
- Коллизии разрешает GT Editor: `name-копия-01.ext`, `-02` и далее.
- После записи destination GT сначала обновляет ссылки и live documents, а
  исходный disk file удаляет последним этапом.
- Операция не очищает clipboard автоматически: это позволяет безопасно повторить
  запрос после временного сетевого/renderer сбоя. Новая команда GT заменяет ticket.

## Основные точки и тесты

- client: `src/main/gt-editor-transfer-client.js`;
- paste IPC: `src/main/main.js::gt-editor-transfer:paste`;
- focus/destination/toast: `src/renderer/components/Workspace/Sidebar.jsx`;
- unit: `src/main/gt-editor-transfer-client.test.js`;
- E2E: отдельные dev leases, реальный RMB/Meta+V, main + project GT windows,
  dirty saved file, `Untitled`, root/folder destination, collision и path rewrite.
