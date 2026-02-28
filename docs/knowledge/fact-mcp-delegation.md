# Feature: Gemini → Claude MCP Delegation

## Intro
Система делегации позволяет Gemini CLI передавать сложные задачи Claude Code, запуская его в полноценном, видимом пользователю терминальном табе. Это превращает Gemini в "оркестратора", который может наблюдать за работой sub-агента.

## Архитектура: Fire-and-forget
В отличие от прямой интеграции через SDK, MCP-делегация работает по принципу "выстрелил и забыл":
1. **Gemini → MCP Tool:** Gemini вызывает инструмент `delegate_to_claude`.
2. **Instant Response:** MCP-сервер мгновенно возвращает `taskId`, подтверждая прием задачи. Gemini продолжает свою работу или ждет.
3. **Async Execution:** Main-процесс создает скрытый Claude-таб, выполняет задачу и отслеживает завершение через PTY-поток.
4. **Late Delivery:** Результат доставляется в Gemini PTY через механизм инъекции (`safePasteAndSubmit`), когда Claude закончил работу.

### Психология промпта (Tool Descriptions)
Для предотвращения бесконечных циклов в Gemini ("Potential loop detected") описания инструментов в MCP-сервере сформулированы максимально жестко:
- **Fire-and-forget:** В описании `delegate_to_claude` явно указано, что результат возвращается мгновенно и Gemini **НЕ ДОЛЖЕН** поллить `get_task_status`. Это критично, так как Gemini склонен перепроверять статус, если не видит мгновенного текстового ответа в инструменте.
- **Meta-level injection:** Gemini объясняется, что ответ появится в терминале сам собой на "мета-уровне".
- **Diagnostic only:** Инструмент `get_task_status` помечен как "только для диагностики", чтобы агент не использовал его в основном цикле ожидания.

### Handshake: Slash-Command Splitting
При делегации промпта вида `/model haiku\nTask` система использует `sendHandshakePrompt()` для разделения текста. Это решает проблему "неизвестной модели", когда Claude пытался интерпретировать весь многострочный блок как имя модели. Подробнее см. [`fix-gemini-delegation-handshake.md`](fix-gemini-delegation-handshake.md).

## Механизм обнаружения (PID-based Discovery)
Main-процесс запускает HTTP-сервер на случайном свободном порту (`port 0`).
- **Endpoint Discovery:** Актуальный порт записывается в `~/.noted-terminal/mcp-port-<process.pid>`. Использование PID в имени файла обеспечивает изоляцию при параллельном запуске нескольких экземпляров приложения.
- **MCP Server:** Процесс `mcp-server.mjs` при старте выполняет **Process Tree Walking** вверх от своего PPID (Gemini), чтобы найти файл порта, соответствующий "родному" инстансу Electron. См. [`fix-mcp-multi-instance.md`](fix-mcp-multi-instance.md).

## Viewport UX: Seamless Observation
При делегации создается связь `parentTabId`. Это активирует специальное поведение интерфейса:
- **SubAgentBar:** Над терминалом появляется панель с чипами активных sub-агентов.
- **UUID Links in Terminal:** В выводе Gemini (терминал) UUID задач автоматически распознаются как ссылки. Клик по ID вызывает переход к соответствующей вкладке Claude-суб-агента через IPC `mcp:focus-task`. См. [`fix-tab-persistence.md`](fix-tab-persistence.md) (секция Closure Trap).
- **Viewport Switching:** Клик по чипу переключает видимость (`zIndex`) между терминалом Gemini и Claude. 
- **Active Context:** Фокус в `TabBar` остается на Gemini. Это позволяет пользователю "подглядывать" за работой Claude, не переключая основной контекст вкладки.

### Изоляция (Visibility)
Вкладки суб-агентов **жестко фильтруются** в основном `TabBar`.
- **Правило:** Таб с установленным `parentTabId` никогда не отображается в основном списке (ни в Main, ни в Utility зонах). См. [`fix-tab-persistence.md`](fix-tab-persistence.md) для деталей сохранения этой связи после рестарта.
- **Motivation:** Это предотвращает захламление интерфейса и четко разделяет "оркестратор" (Gemini) и его "рабочих воркеров" (Claude sub-agents).
- **Detach:** При отсоединении суб-агента (через контекстное меню чипа), `parentTabId` сбрасывается в `undefined`, после чего таб мгновенно появляется в общем списке `TabBar`.

## Behavior Specs
- **Status Sync:** Чипы sub-агентов в реальном времени отображают статус (`⟳` running, `✓` done, `✗` error). При перезапуске приложения статус восстанавливается как `done`.
- **Cleanup:** При закрытии Gemini-таба все связанные с ним sub-агент процессы получают сигнал `Ctrl+C` и отключаются.
- **Sub-Agent Context Menu:** Правый клик по чипу в SubAgentBar открывает нативное меню:
    - **Task ID:** Копирование ID задачи (нужно для диалога с Gemini).
    - **Session ID:** Копирование ID сессии Claude (для Fork/Timeline).
    - **Detach:** Отсоединение таба и превращение его в самостоятельную вкладку.

## См. также
- **Multi-instance Isolation:** [`fix-mcp-multi-instance.md`](fix-mcp-multi-instance.md) — детали реализации PID-портов.
- **Tab Persistence:** [`fix-tab-persistence.md`](fix-tab-persistence.md) — как сохраняются связи суб-агентов.
- **Reliability Fixes:** [`fix-mcp-reliability.md`](fix-mcp-reliability.md) — детали реализации cooldown, CWD и retry логики.
