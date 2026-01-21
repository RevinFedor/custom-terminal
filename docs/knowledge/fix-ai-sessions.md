# Сборник решений: AI Сессии и Автоматизация (Gemini/Claude)

Этот файл объединяет все решения, связанные с автоматизацией CLI агентов, восстановлением сессий и методом "Trojan Horse".

---

## 1. Smart Gemini Resume (State Detection)
**Файл-источник:** `fix-smart-gemini-resume.md`

### Problems
1. **Commands sent when Gemini already running**: Redundant `gemini` command breaks session restore.
2. **Commands sent before Gemini ready**: Gemini takes 2-5s to load; immediate commands are lost.

### Solution: New 3-stage approach
1. **Stage 1: Detect Current State**: Use `serializeAddon` to check if Gemini prompt `>` is already visible.
2. **Stage 2: Wait for Ready State**: If starting, wait up to 15s for "Type your message" pattern.
3. **Stage 3: Smart Execution**: Only send `gemini` if needed, then send `/chat resume`.

---

## 2. Silence & Cursor Detection (Automation Stability)
**Файл-источник:** `fix-gemini-cli-automation.md`

### Problems
1. **Fake Prompt**: Gemini CLI (Ink) draws `>` instantly, but internal loop is still busy.
2. **Error "Slash commands cannot be queued"**: Happens if command sent during "Generating" state.

### Solutions
- **Method A: HIDE Cursor Detection (Primary)**: Gemini hides cursor (`\x1b[?25l`) when ready for input. This is the fastest and most accurate method.
- **Method B: Silence Detection (Fallback)**: Wait for 1500-2000ms pause in PTY data stream.

---

## 3. Session Restore: From "Trojan Horse" to Direct Injection
**Файл-источник:** `fix-trojan-horse-replaced.md`

### Problem
Old method was confusing: it created a visible dummy checkpoint `trojan-xxx` in terminal, then renamed it.

### Solution: Direct Injection
Gemini CLI doesn't have an internal registry; it just scans `~/.gemini/tmp/<SHA256_HASH>/checkpoint-*.json`.
**New Strategy:**
1. Calculate SHA256 of the project directory.
2. Manually write the checkpoint JSON file into the correct Gemini temp folder.
3. User runs `/chat resume <name>` directly.
**Benefits:** Faster, invisible background work, no terminal pollution.

---

## 4. Session Item Visual Selection
**Файл-источник:** `fix-session-item-not-selecting.md`

### Problem
Clicking a session didn't show a border because `border-transparent` was still present alongside `border-accent`.

### Solution
Explicitly swap classes:
```javascript
// On click:
el.classList.remove('border-transparent');
el.classList.add('border-accent');
// On deselect:
el.classList.remove('border-accent');
el.classList.add('border-transparent');
```
Tailwind classes are atomic and have equal specificity; order in JS doesn't matter, only the absence of conflict.
