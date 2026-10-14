# noted-shared

Единый исходник общих интерфейсных механизмов Noted-приложений. Репозиторий не
принадлежит ни GT Editor, ни Custom Terminal: приложения подключают исходники через
Vite alias и передают им только свои данные и действия.

## Пакеты

- `@noted/structured-dnd` владеет жестом: pointer capture, геометрией, semantic
  preview, автоскроллом, анимацией раскладки, горизонтальным изменением иерархии и
  отпусканием за узким sidebar. Он не знает про файлы, IPC, базу и команды меню.
- `@noted/file-explorer` переводит файловое дерево в outline, рисует строки,
  коннекторы, иконки и общее контекстное меню. Он координирует сохранение визуальной
  раскладки и атомарный batch move, но физические файловые операции выполняет host.

GT Editor и Custom Terminal используют оба пакета. Продуктовые команды передаются
как capabilities: отсутствие callback означает отсутствие пункта. Расширения вроде
GT Index/Choose Project и Custom Terminal Link File остаются в приложениях. Voice
Record пока использует только DnD-ядро для своего существующего prompt editor;
его модель поведения этой миграцией не унифицируется.

## Единственная версия

Все package manifests имеют одну версию. Каждый consumer указывает принятую версию
в `assertNotedShared`; build падает при несовпадении или при появлении старой локальной
копии `packages/file-explorer` / `packages/structured-dnd`. React и UI peer-зависимости
резолвятся из consumer, поэтому bundle не получает второй runtime из этого checkout.

При изменении контракта:

1. Поднять одну версию в root и обоих package manifests.
2. Обновить `NOTED_SHARED_VERSION`.
3. Явно обновить `expectedVersion` в каждом готовом consumer.
4. Прогнать package tests и сборки всех принявших версию приложений.

## Проверка

```bash
npm test
```

