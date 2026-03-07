# Test: Update API (Update Docs)

## Overview
Стабильный E2E тест `auto/stable/test-update-api.js` проверяет полный пайплайн Update API → Haiku для обновления документации.

## Scope
- **UI Buttons:** Наличие и видимость кнопки "Update API" в ActionsPanel
- **Provider Popup:** Выпадающее меню выбора провайдера (claude-api, gemini-api, gemini -p)
- **JSONL Creation:** Создание prefilled JSONL с анализом и assistant подтверждением
- **Tab Naming:** Правильное именование таба (`docs-XX`) с флагом `nameSetManually: true`
- **Shared Counter:** Общий счетчик для Gemini и Claude flows (docs-01, docs-02, ...)

## Key Flows
1. **Export Session** → Select provider → Trigger API call
2. **Verify JSONL** → Check for 2 records (user + assistant)
3. **Check Tab Name** → `docs-XX` persists even after Claude starts
4. **Counter Increment** → Multiple calls create docs-01, docs-02, docs-03...

## Known Issues
None (test marked as stable).

## Reference
- `knowledge/fact-docs-update.md` — API pipeline details.
- `knowledge/fact-claude-sessions.md` — Prefilled Sessions structure.
- `knowledge/fix-tab-naming-race.md` — Tab naming persistence.
- `auto/context.md` — Testing infrastructure.

## Run
```bash
node auto/stable/test-update-api.js
```
