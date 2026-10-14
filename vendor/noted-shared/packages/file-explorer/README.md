# @noted/file-explorer

Общий renderer file explorer для GT Editor и Custom Terminal. Outline-адаптер,
строки, коннекторы, иконки, контекстное меню и layout-функции живут здесь. Локальных
копий и re-export shims в приложениях нет.

## Адаптер приложения

Хост передаёт дерево, обработчик открытия, физический batch move и необязательные
продуктовые контролы строки. Пункты общего меню включаются наличием action callback;
host-only команды вставляются через extension slots. Поэтому пакет не знает про GT
IndexButton/Choose Project или Custom Terminal Link File и file tabs.

Жест, preview, autoscroll, layout animation, Cmd-навигация и отпускание курсора за
узким sidebar принадлежат `@noted/structured-dnd`. File explorer только адаптирует
файловую иерархию к этому headless-контракту и применяет результат атомарно.

## Состояние

Между приложениями синхронизируется только структурная раскладка: ручной порядок и
визуальные parent-связи. Она хранится по абсолютному корню проекта в
`~/.noted-terminal/shared/file-layout.db`; запись использует compare-and-swap revision,
чтобы два Electron-процесса не перетирали друг друга молча. Раскрытие папок, selection,
focused row и scroll остаются локальными: перенос этих состояний между приложениями
создавал бы неожиданные прыжки чужого viewport.

Непустая revision БД не равна ручной сортировке. Manual mode включается только когда
в payload реально есть порядок или visual-parent, поэтому очистка раскладки не
оставляет приложение в ложном ручном режиме.

## Проверка

```bash
npm test
```

Тесты покрывают outline commit с физическим поддеревом, CAS-конфликт, атомарный
batch move и смысловое определение непустой раскладки.
