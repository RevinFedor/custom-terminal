# Fact: Test Infrastructure (auto/)

## Философия
Два уровня тестирования, каждый ловит свой класс багов:
- **Headless** (Node.js + @xterm/headless): логика в изоляции. < 1с, 100% детерминированно.
- **E2E** (Playwright + Electron): реальный TUI. Headless может пройти 22/22, но пропустить баг — Gemini обрезает сообщения до ~137 символов, xterm рендерит иначе.

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

## Ключевые паттерны
- **`logWatch = createLogWatcher(mainProcessLogs)`** — advancing cursor для последовательного отслеживания событий
- **`terminal:paste`** (не `terminal:input`) — для ввода в Claude Code Ink TUI (bracketed paste обязателен)
- **`softAssert`** — для non-critical checks (timing-dependent, не блокирует тест)

## См. также
- [`auto/context.md`](../../auto/context.md) — полная документация с шаблонами и troubleshooting
- [`fact-claude-tui-mechanics.md`](fact-claude-tui-mechanics.md) — почему Ink TUI требует bracketed paste
