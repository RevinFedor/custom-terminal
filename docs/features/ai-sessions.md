# Feature: AI Sessions (Trojan Horse)

## Intro
Система сохранения и восстановления контекста AI-агентов (Gemini CLI) в разных проектах. Позволяет обходить ограничения CLI на экспорт данных.

## Behavior Specs
- **Export:** Выполняет `/chat save <name>` в терминале, перехватывает JSON-чекпоинт из `~/.gemini/tmp/` и сохраняет в SQLite.
- **Import (Trojan Horse):** 
    1. Создает пустую сессию в Gemini.
    2. Патчит созданный файл чекпоинта данными из БД (подменяя пути и хеши файлов).
    3. Выполняет `/chat resume <tag>` для загрузки данных.

## Code Map
- **Manager:** `src/main/session-manager.js` — логика патчинга путей и работы с ФС.
- **Database:** `src/main/database.js` — схема таблиц `ai_sessions`.
- **UI:** `src/renderer/components/Workspace/panels/SessionsPanel.tsx`.

## Critical Context
- См. `knowledge/fact-gemini-cli.md` про детекцию готовности CLI.
