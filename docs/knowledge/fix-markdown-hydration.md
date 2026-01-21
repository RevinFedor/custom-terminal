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
