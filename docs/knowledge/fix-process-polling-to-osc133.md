# Fix: Process Status Polling → OSC 133 Event-Driven

## Problem
Noted Terminal was causing extreme CPU load on `sysmond` (334% CPU) due to constant polling for process status.

### Диагностика (как обнаружили)
При работе с несколькими терминалами Activity Monitor показывал `sysmond` на 334% CPU. Диагностика через `sample`:

```bash
sudo sample sysmond 10 -file /tmp/sysmond_dump.txt
```

Анализ показал главные "горячие" функции:
```
4486 samples: _xpc_connection_call_event_handler (XPC запросы)
2053 samples: sysctl (информация о процессах)
211 samples: responsibility_get_uniqueid_responsible_for_pid
204 samples: proc_pidinfo
```

Это означало что кто-то постоянно бомбит sysmond запросами "дай статус процессов".

### Root Cause
Three components were polling `terminal:hasRunningProcess` every 2 seconds:
- `TabBar.tsx` - to show green dot indicator on tabs
- `Dashboard.tsx` - to show process status on project cards
- Each call executed `pgrep -P ${pid}` + `ps -p ${childPid}` via shell

With 6 terminals open:
- 12+ system calls per second
- Each syscall → sysmond XPC request → sysctl
- Result: sysmond overloaded

## Solution
Replace polling with **OSC 133 Shell Integration** (already implemented in main.js).

### How OSC 133 Works
Shell sends escape codes when commands start/finish:
```
\x1b]133;B\x07  → Command started (user pressed Enter)
\x1b]133;D;0\x07 → Command finished with exit code 0
```

Main process parses these and:
1. Stores state in `terminalCommandState` Map (memory)
2. Emits IPC events: `terminal:command-started`, `terminal:command-finished`

### Changes Made

#### TabBar.tsx
```javascript
// BEFORE: Polling every 2 seconds
const interval = setInterval(async () => {
  const result = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId);
}, 2000);

// AFTER: Event-driven
useEffect(() => {
  // Initial load from memory (no syscalls)
  const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);

  // Listen for events (instant, no polling)
  ipcRenderer.on('terminal:command-started', handleStart);
  ipcRenderer.on('terminal:command-finished', handleFinish);
}, []);
```

#### Dashboard.tsx
Same pattern as TabBar.tsx.

#### useWorkspaceStore.ts (closeTab)
```javascript
// BEFORE: Always called pgrep/ps
const { hasProcess } = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId);

// AFTER: First check memory, then syscall only if needed
const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);
if (state.isRunning) {
  // Only now call hasRunningProcess to get process name
  const { processName } = await ipcRenderer.invoke('terminal:hasRunningProcess', tabId);
}
```

## Result
- **0 syscalls** for process status monitoring
- Instant UI updates (no 2-second delay)
- sysmond CPU: 0% (was 334%)

## Files Modified
- `src/renderer/components/Workspace/TabBar.tsx`
- `src/renderer/components/Dashboard/Dashboard.tsx`
- `src/renderer/store/useWorkspaceStore.ts`

## Related
- `fact-shell-integration.md` - OSC 133 protocol specification
- `fact-osc7-cwd.md` - Similar event-driven pattern for CWD tracking
- `fix-ui-stability.md` (section 8) - execSync → execAsync migration

## Критическое правило (см. architecture.md)
**ЗАПРЕЩЁН polling через `pgrep`/`ps`** для определения статуса процесса. Использовать только:
- `terminal:getCommandState` (читает из памяти, 0 syscalls)
- IPC-события `terminal:command-started` / `terminal:command-finished`
