# Workspace-session: частичное восстановление нельзя сохранять как рабочее место

## Симптом

После install/relaunch исчезли workflow `uav repo`, `sc-desk`, `flow-tab` и
`ios-dev`, а `main` вместо пяти окон показывал одну вкладку. Проекты и сами
вкладки в БД оставались — потерялась сохранённая карта рабочих мест.

## Доказанный инцидент 2026-08-22

- `04:25:56.407 UTC`: `space-1` ещё возвращался с пятью panes.
- `05:43:14.042`: новый renderer вошёл в `isRestoring=true`.
- `05:43:14.603`: его закрыли посреди project-loop; shutdown записал
  `projects=8 panes=0 view=dashboard`.
- `05:52:41.574`: следующий процесс прочитал именно этот частичный snapshot.
- В `07:21` migration добавляла GT/Mac к уже оставшемуся одному workflow
  (`total=2`, затем `total=3`); она не была удаляющим writer.

Перезапуск около `05:23` использовал тот же renderer bundle
`App-C_i6exGp.js`, поэтому потерю нельзя объяснить переходом на новую версию.
Первый сокращающий write в окне `04:25:56–05:23:27` по старым логам нельзя
атрибутировать до payload: тогда shutdown не печатал IDs workflow. Повторный
destructive overwrite в `05:43` доказан полностью и сам по себе достаточен для
окончательной потери.

## Что система ошибочно приняла за что

На старте Zustand сначала содержит каркас: один `space-1`, ноль восстановленных
окон и не весь список проектов. Настоящие `spaces` устанавливаются после
завершения project-loop. Обычное отложенное сохранение уже проверяло
`isRestoring`, а `beforeunload` вызывал немедленную запись без этой проверки.

Получалось:

```text
close во время restore
  → saveSessionImmediate()
  → buildSessionSnapshot(частичный Zustand)
  → app:setStateSync
  → app_state.workspace-session заменён целиком
```

Форма snapshot была технически полной, но данные внутри ещё не были
пользовательским workspace. Централизация полей в `sessionSnapshot.mjs`
закрыла прежний баг «shutdown перечислил меньше полей», но не этот баг
«правильные поля сняты с незавершённого состояния».

## Защита

1. `saveSessionImmediate` не пишет `workspace-session`, пока `isRestoring`.
   Предыдущая полная запись безопаснее любого частичного каркаса.
2. Main сравнивает набор workflow IDs. Исчезновение хотя бы одного ID
   отклоняется, если writer не передал явное
   `allowWorkspaceSpaceRemoval=true`. Такой флаг даёт только команда удаления
   workflow; обычный save, shutdown, migration и recovery — нет.
3. Перед каждой реальной заменой `workspace-session` предыдущая версия
   атомарно попадает в `app_state_revisions`. Хранятся последние 100 версий с
   `reason/source`; unchanged writes историю не засоряют.
4. Authenticated Workspace API отдаёт все workflow, fingerprint и безопасные
   revision summaries. Recovery сначала делает dry-run, проверяет каждый
   project/tab в живом renderer и коммитит только при совпавшем fingerprint.
   Писать SQLite за спиной renderer запрещено: следующий debounce снова
   перезаписал бы такую правку.

## Восстановление исторической раскладки

Production-логи позволяют точно восстановить показанные panes и фокус пяти
старых workflow. Они не доказывают все скрытые chips каждой полосы, поэтому
recovery не выдумывает их: восстанавливаются только доказанные окна, а все
durable вкладки остаются доступны в проектном sidebar.

Production recovery восстановил семь workflow в порядке
`main → uav repo → sc-desk → flow-tab → ios-dev → gt-editor → mac-electron`.
Три старых tab ID к моменту ремонта уже были закрыты: `main tab-2601` и iOS
`tab-69/tab-97`; dry-run обнаружил это до записи. Они не воскрешались.
Поэтому `main` восстановлен с четырьмя доказанными живыми panes, UAV/SC/Flow
— с двумя, iOS/GT/Mac — с явным пустым окном и своим project binding.
Состояние пережило три штатных restart-цикла; installed asar совпал с локальной
сборкой, а revision API сохранил предыдущее трёх-workflow состояние.

## Регрессии

- shutdown во время `isRestoring` не вызывает `app:setStateSync`;
- snapshot с меньшим набором workflow IDs отклоняется без ревизии и без
  изменения текущей записи;
- явное удаление проходит и архивирует предыдущую запись;
- stale recovery fingerprint не меняет состояние;
- revision restore требует точного доказательства текущего значения.
