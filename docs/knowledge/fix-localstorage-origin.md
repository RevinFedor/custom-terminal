# Fix: localStorage теряется при сдвиге vite-порта + reload-trap

## Симптом
Юзер выставил настройку в UI (`defaultClaudeEffort: max`) → закрыл приложение → запустил `npm run dev` снова → **настройка исчезла**, показывает дефолт. Юзер думает, что persistence не работает или БД сломалась.

## Причина — `localStorage` привязан к origin (scheme+host+port)

Vite dev-server поднимается на `5181`, но если порт занят — берёт `5182`, `5183`, ... Это случается часто:
- Предыдущий `npm run dev` оставил orphan Electron (PTY с активным renderer'ом).
- Юзер запустил два инстанса параллельно.
- `npm run dev` в одном окне, `electron .` в другом.

Каждый порт = отдельный origin = **отдельное localStorage хранилище**. Настройка **была** сохранена, но на `http://localhost:5181`. Сейчас Electron открыл `http://localhost:5182` → новое пустое хранилище.

В **production** Electron использует `file://` или фиксированный internal URL → origin стабильный → localStorage переживает рестарты. Проблема только в dev.

## Решение — миграция настроек в SQLite через `app:setState`

```ts
// Сохранение
ipcRenderer.invoke('app:setState', { key: 'defaultClaudeEffort', value: v });
// Загрузка
const v = await ipcRenderer.invoke('app:getState', 'defaultClaudeEffort');
```

SQLite в main process — origin-independent (живёт в `app.getPath('userData')`, один на app, не на vite-port). Выживает любой port shift.

### Migration pattern (без потери данных у существующих юзеров)
1. `loadInit()` сначала читает `localStorage` — **синхронно**, для initial Zustand state. Бутстрап быстрый, без mounted-flicker.
2. После init — async IIFE загружает из SQLite (authoritative) и `useStore.setState(...)` если значения отличаются.
3. Каждый `saveX()` пишет в **оба места** — localStorage (mirror для следующего sync-init) + SQLite (truth).
4. localStorage становится non-authoritative кэшем, можно удалить через релиз-два.

## Когда localStorage vs SQLite

| | localStorage | SQLite (`app:setState`) |
|---|---|---|
| Скорость init | синхронно (нужно для initial Zustand) | async (требует await IPC) |
| Origin-stability | привязан к origin | один на app |
| Стабильность в dev | ломается при port shift | надёжно |

**Правило:**
- **UI-эфемерное** (open/closed состояние модалок, hover preferences, expand-state блоков): localStorage.
- **Persistence value** которое юзер ожидает после рестарта (effort, модель, customization workspace, токены): SQLite.

Принцип: см. `methodology/переносимый-дизайн.md::Persistence-class для dev settings`.

## Что пробовали и почему отбросили
- **`electron-store`** — лишняя зависимость, тот же IPC pattern + код для миграций. SQLite уже есть через `projectManager.db`, переиспользовали.
- **Файл в `app.getPath('userData')/settings.json`** — race при одновременной записи нескольких настроек, нужен debounce + queue. SQLite + `better-sqlite3` даёт сериализуемость из коробки.

---

## Bonus: `location.reload()` открывает OS browser вместо renderer reload

### Симптом
В ErrorBoundary кнопка Reload вместо перезагрузки renderer открывает default OS browser (Chrome/Yandex) и грузит туда `file://...` или `app://...` URL. Воспроизводится после ошибок в renderer + некоторых path-resolution edge-cases.

### Причина
При custom-protocol page `window.location.reload()` иногда роутится через **OS protocol handler**, а не через Electron renderer reload. Поведение интермиттентное.

### Решение — IPC в main вместо `location.reload()`:

```js
// main.js
ipcMain.on('app:reload', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.webContents.reload();
});

// renderer
try {
  window.require('electron').ipcRenderer.send('app:reload');
} catch {
  location.reload(); // fallback для не-Electron (mobile-web в браузере)
}
```

`webContents.reload()` всегда выполняется внутри той же BrowserWindow независимо от protocol — обходит OS handler routing.
