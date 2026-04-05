# Environment, OS & Infrastructure\n
\n---\n## File: fix-environment.md\n
# Fix: Electron-vite окно не появляется на macOS

## Проблема
При запуске `npm run dev` (electron-vite) на macOS Sequoia/Tahoe:
- Dev server стартует успешно
- Иконка появляется в Dock
- **НО окно не появляется** — требуется клик на иконку

При этом в проектах с `concurrently + wait-on + electron .` всё работает.

## Причина
**electron-vite** запускает Electron как **дочерний процесс Node.js**, тогда как `concurrently` запускает Electron как **независимый процесс**.

macOS Sequoia усилил защиту от "focus stealing", и дочерние процессы получили более строгие ограничения. По умолчанию приложение регистрируется как `accessory` (фоновый процесс), а не `regular` (обычное приложение).

## Решение
Вызвать `app.setActivationPolicy('regular')` **ДО** `app.whenReady()`:

```javascript
const { app, BrowserWindow } = require('electron');

const isDev = !app.isPackaged;

// ⚡ КРИТИЧЕСКИ ВАЖНО: Устанавливаем activation policy ДО app.whenReady()
// Это обходит защиту macOS Sequoia/Tahoe от "focus stealing" для дочерних процессов
if (process.platform === 'darwin') {
  app.setActivationPolicy('regular');
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    show: false, // Оставляем false для предотвращения белого экрана
    // ...
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // Дополнительная активация для надёжности
    if (process.platform === 'darwin') {
      setTimeout(() => {
        mainWindow.moveTop();
        app.focus({ steal: true });
        mainWindow.focus();
      }, 50);
    }
  });

  // ...
}

app.whenReady().then(() => {
  createWindow();
});
```

## Почему это работает

| Аспект | Без fix | С fix |
|--------|---------|-------|
| Parent process | Node.js (electron-vite) | Node.js (electron-vite) |
| NSRunningApplication | Background utility | **Regular application** |
| Activation policy | `accessory` | `regular` |
| Focus stealing | Блокируется | Разрешён |

## Не работающие решения
- `show: true` вместо `show: false` — не помогает
- `app.dock.show()` + `app.focus({ steal: true })` — не помогает
- `setAlwaysOnTop(true)` → focus → `setAlwaysOnTop(false)` — не помогает

Только `app.setActivationPolicy('regular')` решает проблему.

## Связанные ресурсы
- macOS NSApplicationActivationPolicy
- Electron app.setActivationPolicy() API
- electron-vite process model
\n---\n## File: fix-environment.md\n
# Fix: MacOS Titlebar Click & Drag Conflict

## Проблема
В Electron на macOS использование `-webkit-app-region: drag` полностью блокирует события мыши (`click`, `mousedown`, `double-click`) для JavaScript. События перехватываются оконным менеджером ОС для перемещения окна.

## Решение (Стратегия "Interactive Over Drag")
Мы используем комбинацию слоев и точечного отключения drag-области:

1.  **Title Bar Container:** Имеет `WebkitAppRegion: drag`. Это позволяет таскать окно за фон шапки.
2.  **Interactive Areas:** Контейнеры табов и пустые зоны клика имеют `WebkitAppRegion: no-drag`. Это возвращает события в JavaScript.
3.  **Focus Trigger:** Для немедленной реакции (даже если ОС пытается начать Drag) используется событие `onMouseDown`, а не `onClick`.
4.  **Native Zoom:** Левая часть шапки (до разделителя) оставлена "чистой" (без `no-drag` оверлеев), что позволяет ОС обрабатывать нативный двойной клик для развертывания окна (Zoom).

## Результат
Пользователь может перетаскивать окно за любую свободную часть шапки, но при этом двойной клик по пустой зоне создает проект, а двойной клик слева — масштабирует окно.
\n---\n## File: fix-environment.md\n
# Knowledge: Title Bar — Layered Drag Strategy

## Проблема
На macOS при использовании `-webkit-app-region: drag` на интерактивных элементах title bar возникают конфликты:
1. **Двойной клик** разворачивает/сворачивает окно вместо вызова JS-обработчика
2. **onClick/onDoubleClick** не срабатывают, события перехватываются системой
3. Динамическое переключение `drag`/`no-drag` вызывает визуальные фризы

## Что пробовали и почему не сработало

### Попытка 1: Динамическое переключение drag/no-drag
```tsx
style={{
  WebkitAppRegion: isDragActive ? 'no-drag' : 'drag'
}}
```
**Почему не сработало:** При быстром double-click состояние не успевает переключиться. Также вызывает микро-фризы при каждом изменении.

### Попытка 2: Таймер для определения double-click
```tsx
const handleMouseDown = () => {
  if (Date.now() - lastClick < 300) {
    setIsDoubleClick(true); // switch to no-drag
  }
}
```
**Почему не сработало:** Костыльное решение, не предотвращает системный zoom при первом double-click, требует точной настройки таймингов.

## Решение: Стратегия "Слоёного пирога" (Layered Cake)

Современные приложения (Discord, VS Code) используют слоистую архитектуру title bar:

### Принцип
```
┌─────────────────────────────────────────────────┐
│  Title Bar Container (drag)                     │  ← z-index: 0, фон
│  ┌─────────────────────────────────────────┐   │
│  │  Interactive Layer (no-drag)            │   │  ← z-index: 10, прозрачный
│  │  [Tab1] [Tab2] [Tab3]  [ Empty Zone ]   │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

1. **Нижний слой (Background):** Весь title bar имеет `drag`. Отвечает за перетаскивание окна.
2. **Верхний слой (Interactive):** Контейнер с табами и кнопками имеет `no-drag`. JavaScript ловит все события.
3. **Секрет:** Интерактивный слой прозрачный — клики "проваливаются" на drag-слой при зажатии и перетаскивании.

### Реализация в коде

**Title Bar (родитель):**
```tsx
<div
  className="title-bar"
  style={{
    WebkitAppRegion: 'drag'  // Всегда drag
  }}
  onMouseDown={() => setActiveArea('projects')}  // Работает даже при drag
>
```

**Контейнер табов (дочерний):**
```tsx
<div
  className="flex items-center gap-1 px-2 h-full"
  style={{ WebkitAppRegion: 'no-drag' }}  // Жестко no-drag
  onDoubleClick={(e) => {
    if (e.target === e.currentTarget) {
      handleCreateNewProject();  // Теперь работает!
    }
  }}
>
```

**Пустая зона (ProjectEmptyDropZone):**
```tsx
<div
  className="flex-1 h-full min-w-[60px]"
  style={{ WebkitAppRegion: 'no-drag' }}  // Жестко no-drag
  onDoubleClick={() => onDoubleClick()}   // Работает!
/>
```

## Ключевые правила

1. **Родитель всегда `drag`** — обеспечивает перетаскивание окна за любую "пустую" область
2. **Дочерние интерактивные элементы всегда `no-drag`** — гарантирует работу JS-событий
3. **Используй `onMouseDown` на родителе** вместо `onClick` — срабатывает даже когда система начинает drag
4. **Проверяй `e.target === e.currentTarget`** для double-click на контейнерах — предотвращает срабатывание при клике на дочерние элементы

## Связанные файлы
- `src/renderer/App.tsx` — Title Bar, ProjectTabItem, ProjectEmptyDropZone
- `src/renderer/styles/globals.css` — `.title-bar`, `.window-controls-placeholder`
\n---\n## File: fix-environment.md\n
# ОПЫТ: Экранирование символов в Main процессе (Vite Transform Error)

## Проблема
При запуске приложения через `npm run dev` возникала ошибка `Transform failed: Unexpected character '$'`, указывающая на файл `main.js`. Приложение не запускалось.

## Причина
В `main.js` использовались шаблонные строки (template literals) для формирования Bash-команд, содержащих системные переменные Shell (например, `echo $PWD`). Vite при попытке транспиляции кода Main-процесса воспринимал `$` внутри обратных кавычек как попытку интерполяции переменной JavaScript, которой не существовало.

## Решение
Все символы `$` в строках, предназначенных для выполнения в терминале или PTY, должны быть экранированы обратным слешем, если они находятся внутри шаблонных строк.

**Плохо:**
```javascript
const cmd = `echo $PWD`; // Vite ищет JS переменную PWD
```

**Хорошо:**
```javascript
const cmd = `echo \$PWD`; // Интерпретируется как литерал $
```

### Сложные случаи (awk и др.)
При использовании команд типа `awk`, где символ `$` является частью синтаксиса, рекомендуется использовать конкатенацию строк, чтобы полностью избежать проблем с трансформацией Vite:

```javascript
// В main.js
const cmd = 'lsof -p ' + pid + ' | grep cwd | awk \'{print ' + '\$' + '9}\'';
```
Это гарантирует, что Vite не попытается интерпретировать `$9` как переменную, и команда дойдет до Shell в первозданном виде.

## Результат
Ошибка сборки устранена, команды корректно передаются в оболочку.
\n---\n## File: fix-environment.md\n
# Fact: Gemini CLI Behavior

Внешние особенности работы с Gemini CLI в Raw Mode.

## 1. Готовность к вводу
- **Сигнал:** ANSI-код `HIDE CURSOR` (`\x1b[?25l`). Это самый быстрый и точный индикатор того, что CLI готов принимать команды.
- **Запасной вариант:** Silence Detection (окно тишины) в 1500мс.

## 2. Защита от Paste (Raw Mode)
- **Проблема:** Быстрая отправка текста воспринимается как вставка (paste) и не триггерит выполнение команды.
- **Решение:** Всегда делать задержку 150мс перед отправкой `\r` (Enter).

# Fix: process.env в Renderer = undefined после production build

## Симптомы
- API calls возвращают `key=undefined` в production (packaged app)
- В dev mode (npm run dev) всё работает
- Gemini API возвращает 400 "API key not valid"

## Причина
Vite заменяет `process.env.X` в renderer-коде на **литерал при сборке**. Если env var не определён в build-time контексте — подставляется `undefined`. Main process (`src/main/`) работает с настоящим `process.env` (Node.js runtime), а renderer — с замороженным снапшотом.

## Решение
`define` в `electron.vite.config.js` с предварительной загрузкой `.env` через `dotenv`:
```javascript
import { config } from 'dotenv';
const env = config({ path: resolve(__dirname, '.env') }).parsed || {};

// В секции renderer:
define: {
  'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
},
```

## Почему не другие подходы
- `VITE_` prefix (`import.meta.env.VITE_GEMINI_API_KEY`) — требует переписать все 11 мест в renderer, ломает единообразие с main process
- IPC handler для получения ключа — оверинжиниринг для статического значения
- `.env` loader в main.js — работает только для main process, renderer бандлится отдельно

---

# Fact: Pragmatic Drag-and-Drop (PDND)

- Библиотека от Atlassian (`@atlaskit/pragmatic-drag-and-drop`).
- **Особенности:** Не предоставляет готовых UI-компонентов, только логику.
- **Индикаторы:** Должны реализовываться через Absolute Overlay, чтобы избежать Layout Shift во Flexbox-контейнерах.
\n---\n## File: fix-environment.md\n
# Fact: Log Compression Algorithms

В приложении реализована интеллектуальная очистка логов для экономии контекстного окна AI и улучшения читаемости.

## 1. Grafana Logs
Оптимизировано для дампа из интерфейса Grafana (Loki).
- **Стриппинг stderr:** Удаляются строки-заголовки `stderr`, которые дублируют сообщение в консоли.
- **Удаление Fields:** Полностью вырезается секция метаданных `Fields` (hostname, service, source и т.д.), если они не несут полезной нагрузки для конкретной ошибки.
- **Timestamp Cleanup:** Удаляются длинные ISO-даты в начале строк, оставляя только текст сообщения.
- **Дедупликация:** Повторяющиеся подряд одинаковые строки схлопываются.

## 2. Browser Console Logs
Оптимизировано для копирования из DevTools.
- **Stacktrace Strip:** Удаляются строки вызова функций (`at Object.onClick (file.js:123)`), если они забивают текст.
- **Object Truncation:** Сокращаются дампы огромных JSON-объектов `{...}` до компактного вида, если они встречаются внутри лога.
- **File:Line Cleanup:** Удаляются префиксы имен файлов в начале каждой строки.

## 3. Общие правила
- **Результат:** После нажатия кнопки "Logs", объем текста в буфере обмена уменьшается на 60-90%.
- **Feedback:** Система всегда сообщает пользователю исходный и финальный размер (например, "Сжато: 5000 -> 800 символов").
