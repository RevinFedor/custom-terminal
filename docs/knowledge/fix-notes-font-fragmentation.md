# Fix: Шрифт/padding `tab.notes` разъезжались между inline / slide-out / Cmd-hover preview

## Симптомы
- Пользователь меняет шрифт заметки в Settings — изменение видно в одной поверхности (inline в InfoPanel), но не в slide-out. Или наоборот: slide-out обновился, inline и hover preview остались прежними.
- Контент `tab.notes` один и тот же, но три отображения трёх размеров: inline 13px, slide-out 14px, Cmd+hover popover 13px.
- В Settings → раздел заметок две одинаковые группы ползунков («Превью заметок (в сайдбаре)» + «Редактор заметок (slide-out)»), не очевидно какая на что влияет.

## Корневая причина: persistence-ключ привязан к surface, не к контенту
В useUIStore жили **два** независимых набора полей:

- `tabNotesFontSize` / `tabNotesPaddingX` / `tabNotesPaddingY` — localStorage только (`noted-terminal-tab-notes-*`), range 10..24 / 0..32.
- `notesEditorFontSize` / `notesEditorPaddingX` / `notesEditorPaddingY` — localStorage + SQLite mirror через `app:setState`, range 10..28 / 0..48.

InfoPanel inline editor и TabPreviewPopover читали `tabNotes*`. TabNotesSlideout читал `notesEditor*`. SettingsModal экспонировал обе группы в разных секциях. Один контент `tab.notes` — три surface'а — рассинхронизированные настройки.

Это тот же класс что [fix-foldstate-dual-editor-divergence.md](./fix-foldstate-dual-editor-divergence.md) из gt-editor: persistence-ключ привязан к месту рендера, а не к содержимому. Принципе — см. [methodology/дизайн-принципы.md::Один источник правды](../methodology/дизайн-принципы.md).

## Решение
Оставлен один набор `notesEditor*` (более полный — шире range, дублирующий mirror в SQLite). Удалены:

- Поля `tabNotesFontSize/PaddingX/PaddingY` + setters из `useUIStore.ts`.
- Дублирующая секция в `SettingsModal.tsx` — две группы схлопнуты в одну «Заметки вкладки» с подписью «Inline, slide-out и hover preview».
- Локальные `useUIStore((s) => s.tabNotes*)` selectors в `InfoPanel.tsx` и `TabPreviewPopover.tsx` — заменены на `notesEditor*`.

## Migration: legacy localStorage переезд
Был сценарий: пользователь годами правил только inline-шрифт (через старую секцию Settings), `noted-terminal-tab-notes-*` накопил значение, `noted-terminal-notes-editor-*` остался default'ным. После удаления `tabNotes*` сеттеров пользователь бы потерял своё значение.

Migration зашит в getter каждого `notesEditor*` поля в `useUIStore`:

```ts
let saved = localStorage.getItem('noted-terminal-notes-editor-font-size')
if (!saved) {
  const legacy = localStorage.getItem('noted-terminal-tab-notes-font-size')
  if (legacy) {
    localStorage.setItem('noted-terminal-notes-editor-font-size', legacy)
    saved = legacy
  }
}
```

Запускается один раз на boot когда новый ключ отсутствует. Legacy ключ остаётся (не чистим) — на случай отката деплоя. Стереть legacy можно следующей итерацией через 1-2 релиза.

## Что пробовали (graveyard)
- **Оставить `tabNotes*` как «inline-only» knob, `notesEditor*` как «slide-out only».** Не помогло концептуально: пользователь не думает о shrift'е заметки как о per-surface настройке. Он думает «у этой вкладки заметка вот таким шрифтом». Surface — деталь реализации, не должна светиться в UI настроек.
- **Удалить `notesEditor*` (оставить `tabNotes*` как единственный).** Технически сработало бы, но `notesEditor*` имел SQLite-mirror через `app:setState` — переживает dev-port shuffle между Vite-сессиями (разные порты = разные localStorage origins). `tabNotes*` без mirror'а терял значение после смены порта.

## Связанные файлы
- `src/renderer/store/useUIStore.ts` — getters `notesEditor*` с migration; удалены `tabNotes*` поля.
- `src/renderer/components/UI/SettingsModal.tsx` — одна секция «Заметки вкладки» вместо двух.
- `src/renderer/components/Workspace/panels/InfoPanel.tsx`, `Workspace/TabNotesSlideout.tsx`, `Workspace/TabPreviewPopover.tsx` — потребители.
- [fix-foldstate-dual-editor-divergence.md](../../gt-editor/docs/knowledge/fix-foldstate-dual-editor-divergence.md) — другой шрам того же класса.

## Постскриптум: пересмотр через эксплуатацию (вернулись к трём шрифтам, но по другой модели)

После некоторого времени эксплуатации единого `notesEditorFontSize` выяснилось: юзер реально хочет **разный** шрифт в разных surface'ах. Не потому что они «разные места» (старый антипаттерн per-surface knob), а потому что у них **разная плотность окружения**: сайдбар тесный → читается мелче, slide-out просторный → крупнее, popover над курсором — отдельная балансировка.

Структура теперь: `notesSidebarFontSize` (inline в InfoPanel), `notesExpandedFontSize` (slide-out), `notesTooltipFontSize` (CMD+hover preview). Padding'и `notesEditorPaddingX/Y` остались **общие** — это визуальный отступ редактора, плотностью не диктуется.

Это **не** возврат к старому фрагментированному состоянию. Различие:

- **Раньше** (`tabNotes*` + `notesEditor*`): persistence-ключ привязан к surface произвольно — inline+preview жили в `tabNotes`, slide-out отдельно в `notesEditor`. Юзер видел две группы ползунков в Settings без объясняющей логики. Это plain per-surface knob → антипаттерн.
- **Сейчас** (`notesSidebar` / `notesExpanded` / `notesTooltip`): persistence-ключ привязан к density-контексту. Три knob'а потому что есть три ощутимо разные плотности; юзер думает «компактно/просторно/всплывает», не «inline/slideout/preview».

Тест на различие: если три knob'а можно одной фразой объяснить через плотность («там тесно — мельче, там просторно — крупнее, там всплывает — отдельный») — оставь раздельно. Если только через перечисление surface'ов («тут одно, тут другое, потому что три места рендерят») — схлопывай в один. См. `methodology/дизайн-принципы.md::Один контент в нескольких density-контекстах = независимые шрифты по семантике плотности`.

Migration: переход с единого `notesEditorFontSize` обратно на три выполняется в getter'ах. Если новые ключи (`noted-terminal-notes-{sidebar,expanded,tooltip}-font-size`) отсутствуют — читаем legacy `noted-terminal-notes-editor-font-size` (или ещё более старый `noted-terminal-tab-notes-font-size`) и подставляем во все три. Юзер не теряет накопленное значение, дальше может разойтись по плотностям.
