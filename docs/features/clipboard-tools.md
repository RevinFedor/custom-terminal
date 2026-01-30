# Feature: Clipboard & Pasted Blocks

## Intro
Инструменты для бесшовной передачи данных из буфера обмена в AI-исследователь.

## User Flow
1. Пользователь копирует произвольный текст/код.
2. **AI Research:** В панели Gemini нажимает кнопку **"Буфер"** → Research или Compact. Контент отправляется в чат.
3. **Log Compression:** В `ProjectToolbar` (справа вверху) нажимает кнопку **"Logs"**. 
   - Система читает буфер обмена.
   - Очищает логи (Grafana/Console) от мусора.
   - Записывает результат обратно в буфер.
   - Показывает Toast с информацией о проценте сжатия. См. `knowledge/fact-logs-compression.md`.

## Behavior Specs
- **:::pasted Syntax:** Для вставки в чат используется кастомный разделитель `:::pasted`.
- **Collapsible Blocks:** В чате блоки, помеченные как `pasted`, по умолчанию отображаются в свернутом виде с кнопкой Toggle. Это экономит место при работе с большими дампами кода.
- **Preprocessing:** `MarkdownRenderer` перехватывает `:::pasted` сегменты ДО парсинга основным Markdown-движком.

## Code Map
- `GeminiPanel.tsx`: Кнопка "Буфер" и логика `handleClipboardResearch`.
- `MarkdownRenderer.tsx`: Логика разделения контента на сегменты и рендеринг `CollapsiblePastedBlock`.
- `CollapsiblePastedBlock.tsx`: Компонент с анимацией раскрытия и превью первой строки.
