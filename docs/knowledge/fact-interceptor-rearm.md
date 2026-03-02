# Feature: Interceptor Re-arm (Manual Intervention Flow)

## Intro
Когда пользователь вручную прерывает Claude sub-agent (Escape/Ctrl+C) и пишет свой промпт,
система MCP-делегации ранее теряла связь. Interceptor state machine решает эту проблему,
позволяя пользователю контролировать, будет ли ответ Claude автоматически доставлен в Gemini.

## Interceptor State Machine

Для каждого sub-agent таба существует состояние **interceptor** (`subAgentInterceptor` Map в main.js):

| State | Визуал | Поведение |
|-------|--------|-----------|
| `armed` | Purple ● (пульс) | Ответ БУДЕТ доставлен в Gemini |
| `disarmed` | Red ● (пульс) | Ответ НЕ будет доставлен |
| (отсутствует) | Hidden | Обычный таб или Claude IDLE |

### Видимость
Badge и цветные индикаторы видны **только** когда Claude BUSY (spinner активен).
Когда Claude IDLE — badge скрыт, чип показывает green ● (alive) или gray ◌ (dead).

## Lifecycle

### Автоматические переходы
1. `delegate_to_claude` / `continue_claude` → `armed`
2. `handleSubAgentCompletion` (доставка ответа) → `disarmed`
3. PTY exit / terminal:kill → удаляется из Map

### Ручные переходы (пользователь)
- **Клик по badge** на терминале sub-agent'а → toggle `armed ↔ disarmed`
- **ПКМ на чипе** в SubAgentBar → "Arm interceptor" / "Disarm interceptor"
- **ПКМ → "Deliver last response"** (когда IDLE + disarmed) → ручная доставка последнего ответа

## Ключевые сценарии

### 1. Нормальная делегация
`delegate → armed → Claude работает → IDLE → handleSubAgentCompletion → доставка → disarmed`

### 2. Пользователь прерывает (Escape)
`armed → Escape → IDLE → completion → Gemini получает "[Interrupted by user]..." → disarmed`

### 3. Пользователь пишет свой промпт
`disarmed → пользователь набирает → Claude BUSY [RED badge] → Claude IDLE → ответ НЕ доставлен`

### 4. Re-arm (пользователь хочет доставить ответ)
`disarmed → пользователь набирает → Claude BUSY [RED] → клик badge → armed [PURPLE] → IDLE → доставка → disarmed`

### 5. Disarm (пользователь НЕ хочет доставлять)
`armed → Claude работает [PURPLE] → клик badge → disarmed [RED] → IDLE → Gemini получает "[Interceptor disarmed by user]"`

## Реализация

### Main Process (main.js)
- **Map:** `subAgentInterceptor` — `claudeTabId → 'armed' | 'disarmed'`
- **Spinner IDLE handler:** Проверяет `interceptorVal` перед вызовом completion
  - `armed + running task` → `handleSubAgentCompletion()` (нормальная доставка)
  - `disarmed + running task` → `handleSubAgentCompletionDisarmed()` (уведомление Gemini о disarm)
  - `armed + no running task` → `handleReArmedDelivery()` (ручная доставка)
- **IPC:** `mcp:toggle-interceptor`, `mcp:get-interceptor-state`, `mcp:deliver-last-response`
- **Context menu:** "Arm interceptor" / "Disarm interceptor" / "Deliver last response"
- **Cleanup:** Удаляется при PTY exit и terminal:kill

### Renderer
- **Store:** `Tab.interceptorState: 'armed' | 'disarmed' | null`
- **App.tsx:** IPC listener `mcp:interceptor-state`
- **SubAgentBar:** Chip ● цвет зависит от interceptor + busy
- **TerminalArea:** `InterceptorBadge` компонент — overlay на sub-agent viewport

## Edge Cases
- **E1:** `continue_claude` при disarmed → interceptor автоматически = `armed` (MCP flow восстановлен)
- **E6:** Ответ уже в queue (был armed) → доставится, disarm влияет только на будущие
- **E7:** PTY exit → interceptor удаляется, Gemini получает error notification (существующий код)

## Связанные файлы
- `src/main/main.js` — `subAgentInterceptor` Map, completion handlers, IPC
- `src/renderer/store/useWorkspaceStore.ts` — `interceptorState` field + `setInterceptorState`
- `src/renderer/components/Workspace/SubAgentBar.tsx` — chip colors
- `src/renderer/components/Workspace/TerminalArea.tsx` — `InterceptorBadge` component
- `src/renderer/App.tsx` — `mcp:interceptor-state` IPC listener
