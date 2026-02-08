# Rendering, Markdown & Styling\n
\n---\n## File: rendering-styles.md\n
# ОПЫТ: Решение конфликта гидратации Markdown (pre inside p)

## Суть проблемы
Библиотека `react-markdown` по умолчанию оборачивает текстовые блоки в теги `<p>`. Однако, если AI возвращает блок кода (который рендерится как `<pre>`), React выбрасывает ошибку валидации DOM: 
`In HTML, <pre> cannot be a descendant of <p>.`
Это приводит к нарушению гидратации и потенциальным багам отрисовки в Electron/React 19.

## Решение
В компоненте `MarkdownRenderer.tsx` переопределен рендерер для параграфа (`p`). Система проверяет наличие блочных элементов (`pre`, `div`) среди дочерних узлов.

### Логика проверки:
Если внутри параграфа обнаружен `pre` или `div`, вместо тега `<p>` используется `<div>`. Это сохраняет валидность HTML-дерева.

```tsx
p({ children, node }) {
  const hasBlockChild = node?.children?.some((child: any) =>
    child.tagName === 'pre' || child.tagName === 'div'
  );

  if (hasBlockChild) {
    return <div className="mb-3 last:mb-0">{children}</div>;
  }
  return <p className="mb-3 last:mb-0">{children}</p>;
}
```

## Результат
- Исчезли ошибки в консоли DevTools.
- Корректная отрисовка смешанного контента (текст + код).
- Стабильная работа `react-virtuoso` при прокрутке длинных ответов.
\n---\n## File: rendering-styles.md\n
# ОПЫТ: Рендеринг Inline-кода (react-markdown v9)

## Проблема
После обновления до `react-markdown` v9+, фрагменты inline-кода (одиночные обратные кавычки `` `code` ``) стали отображаться некорректно: они переносились на новую строку или ломали верстку параграфа.

## Причина
В предыдущих версиях `react-markdown` передавал проп `inline` в компонент `code`. В версии 9 этот проп был удален. Теперь компонент `code` используется как для inline-вставок, так и для больших блоков внутри `<pre>`.

## Решение
В компоненте `MarkdownRenderer.tsx` внедрена проверка родительского элемента. Если `code` находится внутри `pre`, он считается блочным. В противном случае — inline.

### Логика:
```tsx
code(props) {
  const { children, className, node, ...rest } = props;
  const match = /language-(\w+)/.exec(className || '');
  
  // Если нет родителя 'pre' — это inline код
  if (node?.parent?.tagName !== 'pre') {
    return (
      <code className="bg-white/10 px-1 py-0.5 rounded text-sm font-mono" {...rest}>
        {children}
      </code>
    );
  }

  // Блочный код с подсветкой...
  return <SyntaxHighlighter ... />;
}
```

## Результат
Inline-код корректно вписывается в поток текста, имеет аккуратный фон и не вызывает ошибок гидратации.
\n---\n## File: rendering-styles.md\n
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
\n---\n## File: rendering-styles.md\n
# ОПЫТ: Сборка Tailwind v4 в Electron (директива @source)

## Проблема
При использовании Tailwind CSS v4 в связке с Vite и Electron, динамические классы (arbitrary values типа `text-[#a8c7fa]`) не попадали в итоговый билд `output.css`. Интерфейс выглядел "сырым", стили не применялись.

## Причина
В Tailwind v4 механизм сканирования файлов изменился. По умолчанию JIT-движок может не подхватывать `.tsx` файлы в глубоких подпапках Electron-проекта, если они не указаны явно или если структура проекта сбивает стандартный поиск.

## Решение (v2: Vite Plugin)
Позднее было найдено более стабильное решение — использование официального плагина `@tailwindcss/vite`. 

1. **Интеграция:** Плагин подключается в `electron.vite.config.js`.
2. **Преимущества:**
   - **Мгновенный HMR:** Стили обновляются сразу при сохранении файла без перезагрузки страницы.
   - **Авто-сканирование:** Больше не требуется директива `@source`, плагин автоматически видит все файлы, входящие в граф зависимостей Vite.
   - **Отсутствие артефактов:** Исчезла проблема с `output.css`, который мог "отставать" от изменений в коде.

## Итоговый стек
- Tailwind CSS v4
- @tailwindcss/vite (plugin)
- React 19

См. `architecture.md` (раздел Styling).
