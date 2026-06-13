# Факт: Reserved Directories / Bookmarks удалены

Reserved Directories / Bookmarks больше не является продуктовой сущностью Dashboard. Старый flow `Add Directory` → секция `Reserved Directories` → карточка `Add Project` удалён вместе с UI/store/IPC/SQLite-поверхностью, потому что пользователь больше не использует этот сценарий.

Если поиск по старым словам (`BookmarkCard`, `useBookmarksStore`, `bookmarks`, `Reserved Directories`, `Add Directory`) привёл сюда, не восстанавливай фичу по инерции. Новый быстрый способ создания проекта должен проектироваться заново как часть Dashboard/Project flow, а не как возврат старой таблицы `bookmarks` и отдельной карточки.
