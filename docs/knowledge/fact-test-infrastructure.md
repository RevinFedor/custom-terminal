# Fact: Test Infrastructure (auto/)

## Философия
Несколько уровней тестирования ловят разные классы багов:
- **Headless** (Node.js + @xterm/headless): логика в изоляции. < 1с, 100% детерминированно.
- **E2E** (Playwright + Electron): реальный TUI. Headless может пройти 22/22, но пропустить баг — Gemini обрезает сообщения до ~137 символов, xterm рендерит иначе.
- **Native iOS E2E** (Simulator + WebDriverAgent/Appium): реальный SwiftUI-клиент, accessibility tree, tap/swipe/type, screenshots и app logs. Ловит то, что API-тесты не видят: overlay съел tap, composer визуально активен при запрещённом send, keyboard перекрыл input, pull-to-refresh не дошёл до threshold, foreground вернул store без видимого loader.

## Структура
```
auto/
├── context.md           # Entry point для AI-агентов
├── playwright/          # Фреймворк: Playwright + Electron специфика
├── libraries/           # Цели: специфика тестируемых библиотек (xterm, zustand)
├── core/                # Shared код: launcher.js, electron.js, headless.js
├── fixtures/            # Golden sessions для тестов без реального AI
├── stable/              # Рабочие тесты (регрессия)
├── sandbox/             # Эксперименты → stable/ когда стабильны
└── screenshots/         # Артефакты
```

## Категории тестов
| Метка | Зависимости | Время |
|---|---|---|
| [Headless] | Node.js | < 1с |
| [E2E+Fixture] | Electron + dev server | 15-60с |

### Ключевые headless-тесты (Логика вьюпорта)
- **`test-buildposition-duplicate-firstline.js`**: Проверка пакетного индексирования Gemini. Валидирует защиту от false positives (цитирование AI) и корректность range-based visibility при дублировании текста.
- **`test-claude-timeline-visibility.js`**: Проверка OSC 7777 маркеров. Валидирует O(1) поиск позиций, обработку первого сообщения (pos 0) и disposal маркеров.
| [E2E+Claude] | + Claude CLI | 30-60с |
| [E2E+Gemini+Claude] | + Gemini CLI | 3-5 мин |

## Event-Driven подход
Тесты ждут **те же сигналы**, что и приложение: Spinner logs, BoundaryMarker, Zustand store changes. Фиксированные `waitForTimeout` — только для keyboard simulation (100ms) и анимаций (300ms).

## Native iOS через `ios-mcp`

Для HabitTracker Terminal mode используется отдельный harness `~/Desktop/ios-mcp/`. Основной режим — `ios_wda_*`: Appium поднимает WebDriverAgent поверх XCUITest, агент читает accessibility tree (`ios_wda_source`), шлёт touch actions (`ios_wda_tap/swipe/type`) и делает screenshots без движения macOS-курсора. Старые CGEvent-команды (`ios_tap/swipe`) двигают реальный курсор Mac и подходят только как debug fallback; для поддерживаемых сценариев они хуже, потому что мешают пользователю работать в фоне и не дают Playwright-like targeting по accessibility.

Сценарии для Terminal Control должны доказывать четыре слоя: UI-действие в Simulator, app-side log (`TerminalScroll`/`TerminalHTTP`/`TerminalSSE`/`TerminalStatus`), серверный/runtime artifact (Codex rollout, JSONL или overseer lifecycle) и финальный visible state. В сессии 2026-06-24 `ios_mac_ios_logs` возвращал устаревшие file tails; свежим источником оказался in-app button `Copy Terminal and AI Chat log` + `pbpaste`. Если эти каналы расходятся, для native Terminal bugs считать in-app copied log authoritative, потому что он берёт текущий UI log buffer.

Минимальный smoke для native Codex должен покрывать: `/agent-tabs` создаёт tab и реально стартует runtime (`starting → active`), первый Send переводит UI в `busy` с loader/Stop, completion возвращает `active`, visible history не дублирует user/assistant rows, а rollout/overseer подтверждают тот же turn count. Для background/foreground проверки нужен длинный turn (`sleep 20` достаточно): приложение уходит в другое iOS app, возвращается пока Codex ещё busy, и сразу показывает `busy`/loader/Stop без ручного refresh; после `task_complete` UI становится `active`.

Haptic нельзя проверить сенсором через Simulator/WDA: XCTest/WebDriver не expose'ит физическую вибрацию, а Simulator не имеет Taptic Engine. Если UX требует доказать haptic, в app code должен быть явный event в том же месте, где вызывается `UIImpactFeedbackGenerator`/`UINotificationFeedbackGenerator`, например `[TerminalHaptic] pull-refresh threshold page=tabs style=medium requestId=...`.

## Ключевые паттерны
- **`logWatch = createLogWatcher(mainProcessLogs)`** — advancing cursor для последовательного отслеживания событий
- **`terminal:paste`** (не `terminal:input`) — для ввода в Claude Code Ink TUI (bracketed paste обязателен)
- **`softAssert`** — для non-critical checks (timing-dependent, не блокирует тест)
- **`ios_wda_habit_pull_refresh({page})`** — smoke pull-to-refresh для native Terminal projects/tabs. Для `page:"tabs"` helper обязан сначала оказаться на списке вкладок; если стартует из chat transcript, делает iOS edge-back и только потом pull.

## См. также
- [`auto/context.md`](../../auto/context.md) — полная документация с шаблонами и troubleshooting
- [`fact-claude-tui-mechanics.md`](fact-claude-tui-mechanics.md) — почему Ink TUI требует bracketed paste
- Глобальный skill `ios-e2e-testing` (`~/.claude/skills/ios-e2e-testing/`) — процедура WDA/Appium, Simulator setup и HabitTracker-specific reference.
