# 2026-01-18: Tailwind CSS Migration & Major Fixes

## Задачи сессии

### 1. ✅ Миграция на Tailwind CSS v4
- Удалили `styles.css` (старые CSS variables)
- Создали `input.css` с Tailwind v4 config
- Настроили @theme для цветов и spacing
- Перенесли все стили в Tailwind классы
- Настроили build: `npx tailwindcss -i ./input.css -o ./output.css --minify`

### 2. ✅ File Preview - Syntax Highlighting
**Проблема:** Нужна подсветка синтаксиса для предпросмотра файлов

**Решение:**
- Установили `highlight.js`
- Добавили VS2015 тему (темная, как в VS Code)
- Реализовали автоопределение языка по расширению
- Добавили номера строк с hover эффектом
- Поддержка 25+ языков программирования

**Файлы:**
- `renderer.js:972-1074` - `openFilePreview()` с подсветкой
- `index.html:7` - подключение highlight.js CSS

### 3. ✅ File Explorer - Tree Structure
**Проблема:** Файлы и папки были на разных уровнях из-за отсутствия chevron

**Решение:**
- Добавили chevron (▶/▼) для папок
- Файлы выровнены на том же уровне (пустое пространство)
- Иконки меняются: 📁 → 📂 при раскрытии

**Файлы:**
- `renderer.js:1147-1217` - обновленная логика `renderFileTree()`

### 4. ✅ File Preview Positioning
**Проблема:** Превью открывалось поверх всего приложения

**Решение:**
- Переместили overlay из workspace-view в main-container
- Теперь закрывает только правую область (terminal + notes panel)
- File explorer остается видимым слева
- Добавили `pointer-events` контроль для корректной работы

**Файлы:**
- `index.html:148` - новое расположение overlay
- `renderer.js:988-1045` - логика открытия/закрытия

### 5. ✅ Tabs Persistence (Сохранение табов)
**Проблема:** Табы терялись при перезапуске приложения

**Решение:**
- Добавили поле `tabs: []` в schema проекта
- Автосохранение при создании/закрытии/переименовании
- Восстановление табов при открытии проекта
- Миграция старых проектов (добавление tabs поля)

**Файлы:**
- `project-manager.js:65,88-94` - методы save/restore
- `main.js:196-199` - IPC handler
- `renderer.js:363-378,569,678,716` - автосохранение

### 6. ✅ Tab ID Conflicts (КРИТИЧЕСКИЙ БАГ)
**Проблема:** У разных проектов были одинаковые tab-1, tab-2 → показывались все табы

**Решение:**
- Tab IDs теперь уникальны: `${projectId}-tab-${counter}`
- Пример: `L1VzZXJzL2ZlZG9yL0Rlc2t0b3AvY3VzdG9tLXRlcm1pbmFs-tab-1`
- `renderTabsForProject()` корректно изолирует табы между проектами

**Файлы:**
- `renderer.js:536` - создание уникальных ID
- `renderer.js:465` - restore с правильными ID
- `renderer.js:484-514` - улучшенная изоляция табов

### 7. ✅ Dashboard Tabs Active State
**Проблема:** Табы Projects/Settings не показывали активное состояние

**Решение:**
- Добавили CSS в `input.css:74-76` для `.dash-nav-btn.active`
- JavaScript динамически переключает `text-white` ↔ `text-[#888]`
- Пересобрали Tailwind CSS

**Файлы:**
- `renderer.js:118-149` - обновленная логика переключения
- `input.css:74-76` - стили активного таба

### 8. ✅ Project Chips Active State
**Проблема:** Активный проект (chip вверху) не выделялся

**Решение:**
- Добавили Tailwind классы для активного состояния
- `!bg-accent !border-accent !text-white` для активного проекта

**Файлы:**
- `renderer.js:339-371` - рендеринг chips с активным состоянием

## Технические детали

### Tailwind CSS v4 Setup

**input.css:**
```css
@import "tailwindcss";

@theme {
  --color-bg-main: #1e1e1e;
  --color-panel: #252526;
  --color-accent: #007acc;
  // ... и т.д.
}

@layer components {
  .dash-nav-btn.active {
    @apply !text-white;
  }
}
```

**Build:**
```bash
npx tailwindcss -i ./input.css -o ./output.css --minify
```

### Projects.json Schema (Updated)

```json
{
  "/path/to/project": {
    "id": "base64(path)",
    "path": "/path/to/project",
    "name": "project-name",
    "notes": {
      "global": "...",
      "sessions": []
    },
    "quickActions": [...],
    "tabs": [                    // ← НОВОЕ!
      {
        "name": "Main",
        "cwd": "/path/to/project"
      }
    ]
  }
}
```

### File Preview Flow

```
User clicks file
  ↓
openFilePreview(filePath)
  ↓
1. Hide all terminals
2. Hide notes panel + resizer
3. Position overlay (after file-explorer if visible)
4. Read file via IPC
5. Detect language by extension
6. Apply syntax highlighting (highlight.js)
7. Render with line numbers
  ↓
User presses ESC or clicks ×
  ↓
closeFilePreview()
  ↓
1. Hide overlay (display: none, pointer-events: none)
2. Restore notes panel + resizer
3. Restore active terminal
4. Fit terminal + focus
```

## Известные особенности

### npm run dev (Live Reload)
- Перезагружает окно при изменении `renderer.js`, `output.css`, `index.html`
- Память очищается, но `projects.json` сохраняется
- Сессионные заметки НЕ сохраняются (только в памяти)
- Production сборка работает нормально

### Sessions vs Persistence
**Сохраняется:**
- ✅ Табы (название, cwd)
- ✅ Глобальные заметки проекта
- ✅ Quick Actions

**НЕ сохраняется:**
- ❌ Вывод терминала (scroll buffer)
- ❌ Сессионные заметки (в памяти)
- ❌ Активные процессы (claude CLI, vim)

**Решение для активных процессов:** tmux/screen интеграция (будущая фича)

## Следующие шаги

### Приоритет 1 (легко):
- [ ] Сохранение сессионных заметок в JSON
- [ ] Запоминание активного таба (восстановление последнего)
- [ ] Автооткрытие последнего проекта при запуске

### Приоритет 2 (средне):
- [ ] Scroll buffer persistence (последние 200-500 строк)
- [ ] tmux интеграция для живых сессий
- [ ] История Gemini запросов

### Приоритет 3 (сложно):
- [ ] SQLite вместо JSON (если появится реальная проблема с производительностью)
- [ ] Session recording
- [ ] Replay команд

## Метрики

- **Добавлено строк кода:** ~500
- **Удалено строк кода:** ~200 (старый CSS)
- **Новых зависимостей:** 1 (highlight.js)
- **Багов исправлено:** 8
- **Файлов изменено:** 6 (main.js, renderer.js, project-manager.js, index.html, input.css, output.css)

## Проверка

```bash
# Перед коммитом:
npm start  # Проверить что работает
npx tailwindcss -i ./input.css -o ./output.css --minify  # Пересобрать CSS
```

---

**Статус:** ✅ Все изменения протестированы и работают
**Версия:** v1.1.0 (Tailwind Migration + Tabs Persistence)
