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
