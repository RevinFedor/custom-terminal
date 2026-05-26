# Fix: CodeMirror Controlled Editor Echo → RangeError

## Симптомы
- React ErrorBoundary показывает `Position N is out of range for changeset of length M`, где N > M.
- Краш воспроизводится при удалении блока (`⏳` placeholder, выделенный фрагмент) или при печати символа в notes-модалке когда параллельно открыт inline-editor с тем же контентом.
- В `logs/dev.log` видна ping-pong цепочка: один и тот же tab.notes длиной X идёт через 4-5 sync'ов между двумя editor instance за 30ms, после чего краш.
- Курсор после краша оказывается в (0,0) и любая печать снова кидает RangeError.

## Корневая причина
Два MarkdownEditor instance (inline в `InfoPanel`, slideout `TabNotesSlideout`) подписаны на одно поле `tab.notes` через reactive selector в Zustand. Цепочка:

1. Юзер вставил/удалил → editor #1 вызывает `onChange(newContent)` → store обновляется.
2. Editor #2 reactive subscription получает новый `content` prop → его `useEffect` делает `view.dispatch({changes: replaceAll})` чтобы догнаться.
3. **Этот dispatch триггерит CodeMirror `updateListener` (`update.docChanged === true`) → onChange echo → store снова пишется.**
4. Editor #1 видит «новый» content (на самом деле его же echo) → его replaceAll dispatch → ещё onChange → ...

Внутри цикла каждый editor держит локальный CodeMirror selection. Между dispatch'ами doc укорачивается (например 786 → 777), но pending selection остался на 786 → ChangeSet не может ремапнуть anchor за концом нового документа → throw.

В логах видно ровно эту цепочку (отметки времени за ~20ms):
```
sync 4→777            (paste lands)
onChange echo 777     ← echo от моего dispatch
sync 777→786          (AI title replaced ⏳)
onChange echo 786
sync 786→777 slideout  ← stale content из react re-render
onChange echo 777
sync 786→777 inline    ← rollback, CRASH здесь
```

## Что пробовали и почему не сработало (graveyard)
- **Clamp selection перед dispatch.** `safeAnchor = min(anchor, newLen)` — корректное решение для одного шага, но не лечит источник: каждый dispatch генерирует новый echo, а внутренние CodeMirror updates после dispatch'а уже работают с устаревшим pending selection до того как ChangeSet применится. Crash происходит **внутри** CodeMirror state.update, не на моём явном dispatch.
- **Window error listener для диагностики.** Добавили `window.addEventListener('error', ...)` с дампом anchor/head/docLen — увидели stack из CodeMirror internal, не из нашего dispatch. Подтвердило: ошибка не в нашем коде, в чужом state update который реагирует на echo.
- **Гипотеза fold-ranges с stale `to:`.** Когда `^^ ⏳` блок свернут, fold range содержит позиции до изменения. Не подтвердилось логами — crash был и без fold'ов.

## Решение
**Annotation на программные dispatch'и + skip echo в updateListener.**

В `Editor.tsx` (gt-editor packages):

```typescript
import { Transaction } from '@codemirror/state'

// updateListener: фильтруем эхо
EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    const isExternalSync = update.transactions.some(
      tr => tr.annotation(Transaction.userEvent) === 'external-sync'
    )
    if (!isExternalSync) {
      onChangeRef.current(update.state.doc.toString())
    }
  }
})

// External-sync useEffect: помечаем dispatch
view.dispatch({
  changes: { from: 0, to: currentContent.length, insert: content },
  selection: { anchor: safeAnchor, head: safeHead },
  userEvent: 'external-sync',
})
```

После этого `view.dispatch` от prop-sync эффекта больше не триггерит callback в React. Цикл рвётся: editor #1 dispatch'ит → editor #2 ничего не видит в store → React не re-render'ит → editor #2 не диспатчит обратно.

## Принцип переносимый
См. `methodology/переносимый-дизайн.md::Controlled editor: пометь свои dispatch'и`. Любой раз когда два UI экземпляра делят один state-source и пишут друг в друга через onChange — программный sync должен помечаться.

## Связанные файлы
- `gt-editor/packages/markdown-editor/src/Editor.tsx` — updateListener и External sync useEffect.
- `src/renderer/components/Workspace/panels/InfoPanel.tsx` — inline editor с `content={tabNotes}`.
- `src/renderer/components/Workspace/TabNotesSlideout.tsx` — slideout editor с `content` из reactive selector.
- `fix-vite-prebundle-cache.md` — почему изменения в gt-editor пакете могут не доезжать до custom-terminal без правильного pipeline.
