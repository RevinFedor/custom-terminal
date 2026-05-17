# Fix: InfoPanel держал local mirror `tab.notes` через useState+useEffect

## Симптомы
- Пользователь жмёт «✦ Generate description» в InfoPanel — параллельно правит текст в открытом slide-out. Возвращается описание из Gemini → InfoPanel записывает результат — **затирая** свежие правки слайдаута. Описание видно, ручной текст пропал.
- Между правкой в slide-out и обновлением UI в InfoPanel — один кадр лаг (`useEffect` цепляется по `[liveTabNotes]`, обновляет local state на следующий рендер).
- Документ [fact-notes.md::Single source of truth](./fact-notes.md) явно говорит *«локальных mirror'ов нет — единственный источник истины это `tab.notes`»* — но в коде InfoPanel.tsx был `useState('')` + `useEffect(setTabNotes(liveTabNotes), [liveTabNotes])`. Доc-vs-code drift.

## Корневая причина
В `InfoPanel.tsx` стоял классический pattern:
```ts
const [tabNotes, setTabNotes] = useState('')
const liveTabNotes = useWorkspaceStore((s) => /* read tab.notes */)
useEffect(() => { setTabNotes(liveTabNotes) }, [liveTabNotes])
```

В `handleGenerateDescription` после await fetch использовался `tabNotes.split('\n')` — **зафризенный в closure на момент клика**. Если слайдаут за это время дописал текст — функция работала со старой версией, потом писала результат `setTabNotesStore(activeTabId, newNotes)` → store перезаписывался, slideout получал старую версию с приклеенным описанием. Concurrent write race.

Дополнительно: pattern возвращал ping-pong цикл который уже был задокументирован в [fix-codemirror-controlled-editor.md](./fix-codemirror-controlled-editor.md). Mirror через `useState` → `useEffect` обновляет local → re-render → передача в `<MarkdownEditor content={tabNotes}>` → external-sync dispatch → echo → новый store update → новый mirror tick.

## Решение
**Удалить mirror полностью. Читать напрямую через reactive selector. Внутри async handlers — снимать актуальный snapshot через `useWorkspaceStore.getState()` после `await`.**

```ts
// Mirror удалён.
const tabNotes = useWorkspaceStore((s) => /* read tab.notes */)

// Внутри async handler — НЕ использовать tabNotes (closure-зафризен).
// Читать актуальный snapshot после await:
const response = await fetch(...)
const data = await response.json()
let currentNotes = ''
for (const [, workspace] of useWorkspaceStore.getState().openProjects) {
  const tab = workspace.tabs.get(activeTabId)
  if (tab) { currentNotes = tab.notes || ''; break }
}
const newNotes = injectDescription(currentNotes, data.description)
setTabNotesStore(activeTabId, newNotes)
```

`<MarkdownEditor content={tabNotes}>` подписан на reactive selector — рендерится по новым значениям сам, без mirror.

## Что пробовали (graveyard)
- **Оставить mirror, добавить `setTabNotes(liveTabNotes)` в начале async handler.** Не помогает: snapshot перед await был свежий, но после await store успевал поменяться от слайдаута, а handler писал в store наш «свежий-на-момент-вызова» вариант с описанием — concurrent правки в слайдауте всё равно терялись. Лечит симптом, не источник.
- **Через `useRef` хранить latest tabNotes (updateRef в useEffect).** Решает stale closure в async, но mirror остаётся, ping-pong потенциал остаётся, doc-vs-code drift остаётся. Полумера.

## Принцип
Переносимый — см. [methodology/design.md::State-mirror через useState — ловушка stale read в async](../methodology/design.md). Любой раз когда компонент мирорит reactive-state в локальный `useState` — это контракт «локальный snapshot отстаёт на 1 кадр + closure-зафризен в async». Если в компоненте есть async handlers пишущие обратно в store — mirror **обязательно** даст concurrent-write race.

## Связанные файлы
- `src/renderer/components/Workspace/panels/InfoPanel.tsx` — `useState+useEffect` mirror удалён, `tabNotes` теперь reactive selector. `handleGenerateDescription` использует `useWorkspaceStore.getState()` после `await`.
- [fix-codemirror-controlled-editor.md](./fix-codemirror-controlled-editor.md) — ping-pong цепочка которую возвращал mirror.
- [fact-notes.md::Single source of truth](./fact-notes.md) — теперь снова правда.
- [fix-stale-closure-timeline.md](./fix-stale-closure-timeline.md) — другой шрам того же класса (closure-фриз в Timeline async).
