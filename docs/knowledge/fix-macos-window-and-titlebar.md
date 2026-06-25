# Fix: macOS — окно не появляется и Title Bar drag/no-drag

Два связанных шрама окружения macOS Electron-vite + custom title bar.

## Симптомы

- `npm run dev` через electron-vite: dev server стартует, иконка в Dock, **но окно не появляется** до клика на иконку.
- В Title Bar `-webkit-app-region: drag` блокирует `onClick`/`onDoubleClick`/`onMouseDown` — события перехватываются оконным менеджером для перетаскивания.
- Двойной клик по табам сворачивает/разворачивает окно (нативный macOS Zoom), JS-обработчик не вызывается.
- Динамическое переключение `drag`/`no-drag` вызывает микро-фризы интерфейса.

---

## Часть 1: окно не появляется (electron-vite vs concurrently)

### Причина
electron-vite запускает Electron как **дочерний процесс Node.js**. `concurrently + wait-on + electron .` запускает как **независимый процесс**. macOS Sequoia усилил защиту от focus-stealing для дочерних процессов — приложение регистрируется как `accessory` (фоновый), не `regular`.

### Решение
`app.setActivationPolicy('regular')` **до** `app.whenReady()`:

```js
if (process.platform === 'darwin') {
  app.setActivationPolicy('regular');
}

mainWindow.once('ready-to-show', () => {
  mainWindow.show();
  if (process.platform === 'darwin') {
    setTimeout(() => {
      mainWindow.moveTop();
      app.focus({ steal: true });
      mainWindow.focus();
    }, 50);
  }
});
```

### Что не помогает
- `show: true` вместо `show: false` — не лечит фокус
- `app.dock.show()` + `app.focus({ steal: true })` без `setActivationPolicy` — не лечит
- `setAlwaysOnTop(true)` → focus → `setAlwaysOnTop(false)` — не лечит

Только `setActivationPolicy('regular')` снимает блок macOS на focus-steal для дочерних процессов.

---

## Часть 2: Title Bar drag/no-drag (Layered Cake)

### Что пробовали и почему не работает

**Попытка 1: Динамическое переключение `drag`/`no-drag`** через `style.WebkitAppRegion = isDragActive ? 'no-drag' : 'drag'`.
При быстром double-click состояние не успевает переключиться → нативный Zoom срабатывает раньше, чем JS. Плюс микро-фризы на каждом изменении.

**Попытка 2: Таймер на разделение single/double click** через `if (Date.now() - lastClick < 300)`.
Костыль с точной настройкой таймингов, не предотвращает системный Zoom при первом double-click (он срабатывает синхронно до timer'а).

### Решение — Layered Cake (как в Discord/VS Code)

```
┌─ Title Bar Container (drag)               z-index: 0
│  ┌─ Interactive Layer (no-drag)           z-index: 10
│  │  [Tab1] [Tab2] [Tab3]  [ Empty Zone ]
│  └─
└─
```

**Родитель — `drag`:**
```tsx
<div className="title-bar" style={{ WebkitAppRegion: 'drag' }}
     onMouseDown={() => setActiveArea('projects')}>
```
`onMouseDown` срабатывает даже на drag-области (в отличие от `onClick`).

**Дочерние интерактивные зоны — `no-drag`:**
```tsx
<div style={{ WebkitAppRegion: 'no-drag' }}
     onDoubleClick={(e) => {
       if (e.target === e.currentTarget) handleCreateNewProject();
     }}>
```
Проверка `e.target === e.currentTarget` — double-click срабатывает только при клике в **пустую** зону контейнера, не при клике в дочерний таб.

### Левая часть шапки — оставить чистой
Зона до разделителя (левее табов) — без `no-drag` оверлеев. Это позволяет ОС обрабатывать **нативный** double-click для macOS Zoom (свернуть/развернуть окно). Пользователь сохраняет привычное поведение в одной зоне, JS-логика работает в другой.

### Ключевые правила
1. **Родитель всегда `drag`** — перетаскивание за любую «пустую» область.
2. **Дочерние интерактивные элементы всегда `no-drag`** — гарантирует работу JS.
3. **`onMouseDown` на родителе** вместо `onClick` — срабатывает даже когда ОС начинает drag.
4. **`e.target === e.currentTarget`** для double-click — отсечь срабатывание при клике в дочерние табы.

### Файлы
- `src/renderer/App.tsx` — Title Bar, ProjectTabItem, ProjectEmptyDropZone
- `src/renderer/styles/globals.css` — `.title-bar`, `.window-controls-placeholder`

---

## Часть 3: Dev stack links открывают браузер по умолчанию

### Симптом
При клике по ссылке из dev overlay / stack trace вроде `http://localhost:5182/src/renderer/App.tsx:962:7` открывается новая вкладка в браузере по умолчанию. Это выглядит так, будто Yandex сам реагирует на правки, но реальная причина в Electron main window navigation guard.

### Причина
Глобальный `will-navigate`/`setWindowOpenHandler` перехватывал любую навигацию и для всех `http(s)` делал `shell.openExternal(url)`. Для внешних ссылок это правильно, но dev renderer-origin (`localhost:5182`) — внутренняя ссылка приложения. Если отправлять её в `openExternal`, она уходит в Yandex/Chrome; если просто разрешить навигацию внутри Electron, главное окно уезжает со SPA на source-файл и renderer ломается.

### Решение
Renderer-origin URL в dev нужно гасить: `event.preventDefault()` и без `shell.openExternal`. В `setWindowOpenHandler` для того же origin возвращать `deny`. Внешние `http(s)` ссылки продолжают открываться во внешнем браузере.
