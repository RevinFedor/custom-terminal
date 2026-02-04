# Experience: Markdown Editor Recreation Fix

## Проблема (The Bug)
В `gt-editor` (Markdown редактор) наблюдался эффект "сброса" курсора и потери фокуса при вводе каждого символа. Редактор визуально мерцал, а введённый символ мог оказаться не в том месте.

## Причина
Компонент `MarkdownEditor` использовал дефолтное значение для пропса в виде литерала массива:
```typescript
export function MarkdownEditor({ includeOffsets = [] }: Props) { ... }
```
В React при каждом рендере родителя `{ includeOffsets = [] }` создавал **новую ссылку** на пустой массив (`[] !== []`). Этот пропс был в зависимостях `useEffect`, который инициализировал CodeMirror. В итоге при каждом нажатии клавиши (которое вызывало `setState` в родителе) весь инстанс редактора уничтожался и создавался заново.

## Решение
Вынос пустого массива в стабильную константу на уровне модуля:
```typescript
const EMPTY_OFFSETS: any[] = [];

export function MarkdownEditor({ includeOffsets }: Props) {
  const stableIncludeOffsets = includeOffsets ?? EMPTY_OFFSETS;
  
  useEffect(() => {
    // Инициализация...
  }, [..., stableIncludeOffsets]); // Ссылка теперь стабильна
}
```

## Урок для проекта
Никогда не использовать литералы объектов или массивов в качестве дефолтных значений пропсов внутри деструктуризации параметров компонента, если они попадают в `useEffect` или `useMemo`.
