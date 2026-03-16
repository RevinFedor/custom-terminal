# xterm.js — Специфика тестирования терминала

## Селекторы

```javascript
// Контейнер терминала (видимость = терминал готов к рендерингу)
page.locator('.xterm-screen')

// Строки терминала (текстовое содержимое)
page.locator('.xterm-rows > div')
```

## Ожидание готовности

Видимость `.xterm-screen` ≠ готовность PTY. Между появлением UI и возможностью ввода — задержка инициализации `node-pty`.

```javascript
// 1. Ждём рендер
await waitForTerminal(page)

// 2. Фокус (обязательно для keyboard events)
await electron.focusWindow(app)

// 3. Пауза для PTY
await page.waitForTimeout(500)
```

## Чтение содержимого терминала

```javascript
const content = await page.evaluate(() => {
  const rows = document.querySelectorAll('.xterm-rows > div')
  const lines = []
  rows.forEach(row => {
    const text = row.textContent
    if (text?.trim()) lines.push(text)
  })
  return lines.slice(-20).join('\n')  // последние 20 строк
})
```

## Ввод команд

```javascript
// Через хелпер (с delay для корректного ввода):
await typeCommand(page, 'claude')
// Эквивалент:
await page.keyboard.type('claude', { delay: 50 })
await page.waitForTimeout(100)
await page.keyboard.press('Enter')
```

## Новый таб

```javascript
await page.keyboard.press('Meta+t')
await page.waitForTimeout(1500)  // ожидание PTY spawn + shell init
```

## Поиск активного viewport (ловушка visibility)

`visibility: hidden` элементы имеют **ненулевой** `getBoundingClientRect()`. При поиске viewport активного терминала нельзя полагаться только на размеры:

```javascript
// ПЛОХО — поймает скрытый терминал из другого таба:
for (const vp of document.querySelectorAll('.xterm-viewport')) {
  if (vp.getBoundingClientRect().height > 50) { ... }
}

// ХОРОШО — проверяем computed visibility:
for (const vp of document.querySelectorAll('.xterm-viewport')) {
  if (window.getComputedStyle(vp).visibility !== 'hidden' &&
      vp.getBoundingClientRect().height > 50) { ... }
}
```

## Скролл в тестах

Синтетический `WheelEvent` не работает — xterm.js его игнорирует. Для программного скролла ставить `scrollTop` напрямую:

```javascript
// ПЛОХО — xterm игнорирует:
el.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }))

// ХОРОШО — прямая установка:
viewport.scrollTop = Math.max(0, viewport.scrollTop - 200)
```

## OSC 133 — Command Lifecycle

Приложение отслеживает команды через OSC 133 escape-последовательности:
- `A` — Prompt ready
- `B` — Command started
- `C` — Executing
- `D` — Command finished (с exitCode)

В main process логах:
```
[OSC 133] Tab ...-tab-10: Prompt ready (A)
[OSC 133] Tab ...-tab-10: Command STARTED (B)
[OSC 133] Tab ...-tab-10: Executing (C)
[OSC 133] Tab ...-tab-10: Command FINISHED (D) exitCode=0
```
