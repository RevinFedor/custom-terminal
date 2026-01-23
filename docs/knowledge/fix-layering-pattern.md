# ОПЫТ: Решение проблем наложения UI (Layering & Portals)

## Проблема: "WebGL Canvas съедает мой интерфейс"
При использовании `xterm.js` (даже в режиме Canvas) и сложных UI-компонентов (модалки, кнопки поверх терминала), возникали две критические проблемы:
1. **Stacking Context:** Элементы с `position: fixed` и высоким `z-index` оказывались *под* терминалом или некорректно позиционировались из-за `transform` или `filter` у родительских контейнеров.
2. **Event Blocking:** Кнопки поверх терминала не реагировали на клики, либо клики проваливались "сквозь" них в терминал.

## Решение 1: React Portals
Для элементов, которые должны быть гарантированно поверх всего (FileExplorer, FilePreview), используется `createPortal`.

### Почему это помогло
Порталы рендерят компоненты напрямую в `document.body`, полностью игнорируя DOM-иерархию воркспейса. Это выводит их за пределы локальных контекстов наложения (Stacking Contexts), созданных Flex-контейнерами или анимациями.

```tsx
return createPortal(
  <motion.div style={{ position: 'fixed', zIndex: 99999 }}>
    {/* контент */}
  </motion.div>,
  document.body
);
```

## Решение 2: Layering Pattern (Слоеный пирог)
Для элементов внутри терминала (кнопка "Scroll to bottom", Restart Zone), где Portal не применим, используется паттерн соседних слоев.

### Структура (Terminal.tsx):
```tsx
<div className="absolute inset-0"> 
  {/* Слой 1: Тяжелый рендеринг терминала */}
  <div ref={terminalRef} className="terminal-instance absolute inset-0" />
  
  {/* Слой 2: Прозрачный UI слой поверх */}
  <div className="absolute inset-0 pointer-events-none z-10">
    {showScrollButton && (
      <button className="pointer-events-auto">↓</button>
    )}
  </div>
</div>
```

### Ключевые моменты:
- **`absolute inset-0`**: Вместо `relative w-full h-full`, чтобы избежать конфликтов с размерами `xterm.js`.
- **`pointer-events-none`** на контейнере слоя и **`pointer-events-auto`** на самих элементах (кнопках). Это позволяет кликать по кнопкам, но пропускать клики в терминал, если нажатие произошло в пустом месте слоя.
- **`zIndex`**: Явное указание `z-index` для UI-слоя заставляет браузер рисовать его после (поверх) холста терминала.

## Решение 3: Lock на инициализацию (isCreatingRef)
Чтобы избежать Race Condition при монтировании (когда React вызывает `useEffect` дважды или быстро переключает табы), введен флаг-замок `isCreatingRef`. Он гарантирует, что один и тот же DOM-узел не будет инициализирован терминалом дважды, что предотвращает краши отрисовки.
