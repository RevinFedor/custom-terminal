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
