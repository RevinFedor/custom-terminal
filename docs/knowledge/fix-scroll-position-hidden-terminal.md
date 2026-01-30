# ОПЫТ: Сброс scroll position в скрытом терминале

## Проблема
При переключении между вкладками терминала, если в скрытом табе продолжают поступать данные (например, Claude Code печатает), при возврате на этот таб происходит "дёргание" — терминал показывает верх буфера вместо ожидаемой позиции.

**Корневая причина:** Баг xterm.js — при записи данных в терминал с `visibility: hidden`, `viewportY` сбрасывается в 0, хотя `baseY` (размер буфера) продолжает расти.

Логи демонстрируют проблему:
```
viewportY= 466 baseY= 466 isAtBottom= true   ← до записи
viewportY= 0   baseY= 471 isAtBottom= false  ← после записи в скрытый терминал
```

## Решение
Вместо сохранения только `scrollPosition`, дополнительно сохраняем флаг `wasAtBottom`:

```typescript
const savedScrollPosition = useRef<number | null>(null);
const wasAtBottom = useRef<boolean>(true);

// При деактивации таба:
savedScrollPosition.current = currentViewportY;
wasAtBottom.current = currentViewportY >= currentBaseY;

// При активации таба:
if (wasAtBottom) {
  term.scrollToBottom();  // Игнорируем сброшенный viewportY
} else {
  term.scrollToLine(savedScrollPosition);  // Пользователь был проскроллен вверх
}
```

## Критическое правило
При восстановлении scroll position после переключения табов **нельзя полагаться на текущий `viewportY`** — он может быть сброшен в 0 из-за бага xterm.js. Используй сохранённый флаг `wasAtBottom` для определения нужного поведения.

## Файлы
- `src/renderer/components/Workspace/Terminal.tsx` — реализация сохранения/восстановления scroll position
