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
