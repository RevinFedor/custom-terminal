# Fix: Claude CLI Accidental Exit (Ctrl-C Danger Zone)

### Симптомы
При быстром клике на кнопки в интерфейсе (например, смена модели Sonnet/Haiku или переключение Think mode) терминал с Claude внезапно закрывается (процесс завершается), вместо того чтобы просто выполнить команду.

## Problem (The Double Ctrl-C Trap)
In Claude Code CLI, pressing **Ctrl+C** once triggers a confirmation message: `"Press Ctrl-C again to exit"`.
If the user immediately clicks a Model switch button (sonnet/opus/haiku) or Think toggle, the app sends another `\x03` (Ctrl+C) to clear the input before sending the command (the `ctrlCFirst` strategy).

**Result:** Two Ctrl+C signals arrive in quick succession, causing Claude to exit completely instead of switching models.

## The Detection Strategy
The system monitors the PTY data stream for the specific marker `"again to exit"`.

### 1. Robust Matching
Claude's Ink-based TUI uses cursor motion codes (`\x1b[nC`) between words. When stripped via `stripVTControlCharacters()`, the text might appear as:
- `"PresCtrl-C again to exit"` (if from programmatic `ctrlCFirst`)
- `"Press Ctrl-Cagain to exit"` (if from user keyboard)

The substring `"again to exit"` is the most stable anchor across different terminal widths and render passes.

### 2. Minimum Hold (False Release Protection)
Claude re-renders the prompt symbol (`⏵`) **immediately** after displaying the warning message.
- **Trap:** A simple "ON when marker seen, OFF when prompt seen" logic fails because both arrive within milliseconds. The Danger Zone is cleared before it can protect anything.
- **Solution:** A **3-second Minimum Hold**. The Danger Zone flag is only eligible for removal after 3 seconds have passed since the marker was detected.

## Protection Logic: Multiple Layers

### Layer 1: PTY-level Detection & Hold
When the Danger Zone is active, the first Ctrl+C **already cleared the input line**. Sending another `\x03` via `ctrlCFirst` would exit Claude. So the strategy is:

1. **Detection:** When `"again to exit"` is seen in PTY → `claudeCtrlCDangerZone` flag is set (ON).
2. **Command Interception (`claude:send-command`):**
   - If flag is ON → **Skip `ctrlCFirst`**, clear DZ, send command directly (input is already empty).
   - If flag is OFF → Proceed normally with `ctrlCFirst: true`.
3. **Think Toggle (`claude:toggle-thinking`):**
   - If flag is ON → **Wait** for DZ to expire (toggle uses Escape, not Ctrl+C, so it's safe to wait).
   - If flag is OFF → Proceed normally.
4. **TTL Fallback (4s):** If no prompt is detected after 3s hold, DZ auto-clears to prevent permanent lock.

### Layer 2: UI-level Prevention (Command Guard)
В дополнение к PTY-уровню защиты, интерфейс **физически блокирует** кнопки управления (Model, Effort, Think) на время выполнения команды через флаг `isCommandRunning`.

**Процесс:**
1. Пользователь кликает кнопку Model/Effort/Think.
2. UI устанавливает `isCommandRunning = true` → кнопки становятся disabled.
3. Отправляется синхронный IPC-вызов `ipcRenderer.invoke('claude:send-command')`.
4. Main process выполняет `safePasteAndSubmit` и дожидается завершения `term.write()`.
5. IPC возвращает контроль → UI устанавливает `isCommandRunning = false` → кнопки вновь enabled.

**Мотивация:** Это исключает человеческий фактор — невозможно нажать кнопку дважды за 100ms, даже если пользователь быстро кликает. Вместе с PTY-уровнем защитой это обеспечивает надежную защиту от двойного Ctrl+C.

## Production Safety
- **TTL Fallback:** If no prompt is detected, the Danger Zone automatically clears after 4 seconds to prevent permanent locking of UI buttons.
- **IPC Feedback:** The status is synced to the Renderer via `claude:ctrlc-danger-zone` for potential UI feedback (e.g., disabling buttons).

## Related Files
- `src/main/main.js`: `claudeCtrlCDangerZone` Map and `onData` detection logic.
- `src/main/main.js`: `claude:send-command` and `claude:toggle-thinking` handlers.
- `auto/stable/test-ctrlc-danger-zone.js`: Automated verification of this logic.
