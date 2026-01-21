# Feature: Tab Management

## Intro
Система вкладок в стиле VSCode с разделением на основные (Main) и утилитарные (Utils) зоны. Поддерживает персистентность (восстановление после перезапуска) и перемещение между зонами.

## Behavior Specs
- **Main Zone:** Горизонтальные табы сверху.
- **Utils Zone:** Вертикальный список табов в боковой панели.
- **DND:** Перетаскивание таба меняет его позицию. Перетаскивание на кнопку "Utils" переносит таб в утилитарную зону.
- **Persistence:** Порядок и состояние табов сохраняются в `projects.json` при каждом изменении.

## Code Map
- **UI:** `src/renderer/components/Workspace/TabBar.tsx` — основной компонент управления.
- **Logic:** `src/renderer/store/useWorkspaceStore.ts` — экшены `reorderInZone`, `moveTabToZone`.
- **DND Fix:** См. `knowledge/fix-dnd-layout.md` (почему используем Absolute Overlay).
