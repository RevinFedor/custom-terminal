# ЛОВУШКА: Глобальный перехватчик console.log в Renderer

## Файл: `src/renderer/main.tsx` (строки 6-22)

## Проблема
`console.log()` в renderer-процессе **НЕ выводит ничего** в DevTools Console. Логи молча проглатываются. Это может стоить часов отладки.

## Причина
В `main.tsx` установлен глобальный фильтр:
```javascript
const RESTORE_DEBUG = true;
if (RESTORE_DEBUG) {
  console.log = (...args) => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('[RESTORE]')) {
      _origLog(...args);
    }
  };
}
```
Пропускаются **только** логи с префиксом `[RESTORE]`. Всё остальное — в /dev/null.

## Что НЕ затронуто
- `console.warn()` — работает нормально, НЕ фильтруется
- `console.error()` — работает нормально, НЕ фильтруется
- Main process логи (терминал `npm run dev`) — не затронуты, это другой процесс

## Правило для отладки
Для временных отладочных логов в renderer использовать `console.warn()`, а не `console.log()`.

## Пример
```typescript
// ❌ НЕ ПОЯВИТСЯ в DevTools
console.log('[Timeline] click:', entry.uuid);

// ✅ Появится в DevTools
console.warn('[Timeline] click:', entry.uuid);
```
