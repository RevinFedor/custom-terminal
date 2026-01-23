# Feature: Workspace & Tools

## Intro
Инструменты для работы с кодом внутри терминала: навигация по файлам, быстрый просмотр и поиск через AI.

## Behavior Specs
- **File Explorer (Overlay):**
    - Сайдбар больше не сдвигает терминал. Он открывается поверх через **React Portal**.
    - Анимация появления стала быстрее (150ms) и плавнее через `framer-motion`.
    - При открытии Explorer, FilePreview (если активен) автоматически смещается вправо на 250px.
- **Smart Opening (CWD Aware):** Explorer открывается в директории текущей активной вкладки. Если вкладок нет — в корне проекта.
- **Cmd + Click (Terminal Links):**
    - `Cmd+Click` по URL типа `localhost` или `http://` открывает их во внешнем браузере.
    - `Cmd+Click` по путям файлов (`/Users/...`, `./src/...`) открывает их в **File Preview**.
- **Project Notes (InfoPanel):**
    - Блок заметок в правой панели.
    - Дизайн: прозрачная textarea, которая становится активной при фокусе.
    - **Сохранение:** По `blur` (уход фокуса) или по `Cmd+Enter`.
    - Заметки привязаны к проекту и сохраняются в `projects.json` через IPC.
- **Empty Terminal State:** 
    - Если в проекте нет вкладок, отображается "Empty State" с быстрыми кнопками (New Tab, Claude, Gemini).
- **Gemini Search:** Поиск по файлам проекта через встроенную панель.

## Code Map
- **Explorer:** `src/renderer/components/Workspace/FileExplorer.tsx` — рендеринг через Portal.
- **Notes:** `src/renderer/components/Workspace/panels/InfoPanel.tsx` — логика `saveNotes` и обработка `Cmd+Enter`.
- **Links:** `src/renderer/components/Workspace/Terminal.tsx` — хендлер `handleLinkActivation` для `WebLinksAddon`.
- **Search:** `src/renderer/components/Workspace/panels/GeminiPanel.tsx`.
