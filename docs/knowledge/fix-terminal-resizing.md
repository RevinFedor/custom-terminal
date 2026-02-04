# Experience: Terminal Resizing (Stale Closure Fix)

## Проблема
Терминал переставал реагировать на изменение размеров окна или перемещение разделителя (Resizer). В консоли логи показывали, что `ResizeObserver` срабатывал, но свойство `active` всегда было `false`, из-за чего функция подстройки под размер (`safeFit()`) игнорировалась.

## Причина
Колбэк `ResizeObserver` инициализировался внутри `useEffect` один раз при монтировании. Он захватывал начальное значение переменной `active` (обычно `false`) в своё замыкание (closure). При изменении состояния компонента колбэк продолжал использовать старое значение, не зная, что вкладка стала активной.

## Решение
Использование `useRef` для хранения актуального состояния активности:
1. Создан `activeRef = useRef(active)`.
2. Добавлен `useEffect`, который синхронизирует `activeRef.current = active` при каждом рендере.
3. Внутри колбэка `ResizeObserver` проверка выполняется через `activeRef.current`.

```typescript
const activeRef = useRef(active);
useEffect(() => { activeRef.current = active; }, [active]);

// Внутри ResizeObserver
if (activeRef.current) {
  safeFit();
}
```

## Урок для проекта
При использовании сторонних API с колбэками (ResizeObserver, IntersectionObserver, события на `window`) всегда проверяйте состояние через `Refs`, чтобы избежать проблем с "протухшими" данными в замыканиях.
