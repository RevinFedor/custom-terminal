# Troubleshooting: Session Item Not Selecting on Click

**Date:** 2026-01-19
**Issue:** Clicking on session item in list doesn't visually select it

---

## Problem

When clicking on a session in the Sessions panel:
- Expected: Border changes to accent color (visual selection)
- Actual: Nothing happens, border stays transparent

**User complaint:**
> "когда я кликаю ничего не происходит то есть у меня активные сессии не выбирается"

---

## Root Cause

**CSS class conflict:**
```javascript
// Initial classes on item:
item.className = '... border border-transparent hover:border-accent ...';

// On click, we added:
item.classList.add('border-accent');

// But border-transparent was still there!
// Result: border-transparent and border-accent both present
// → Tailwind uses last one in CSS file, unpredictable which wins
```

**Problem:** When both `border-transparent` and `border-accent` are present, Tailwind CSS doesn't know which to apply. They have equal specificity, so it depends on order in the CSS file.

---

## Solution

**Explicitly toggle the border classes:**

```javascript
// BEFORE (broken):
item.addEventListener('click', () => {
  // Remove selection from all
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.remove('border-accent');
  });
  // Add selection to clicked
  item.classList.add('border-accent');
});

// AFTER (fixed):
item.addEventListener('click', () => {
  // Remove selection from all
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.remove('border-accent');
    el.classList.add('border-transparent');     // ← Add this!
  });
  // Add selection to clicked
  item.classList.remove('border-transparent');   // ← Add this!
  item.classList.add('border-accent');
});
```

---

## Why This Works

**Tailwind CSS utility classes are atomic:**
- `border-transparent` → `border-color: transparent`
- `border-accent` → `border-color: var(--accent-color)`

When both are present:
- ❌ Unpredictable which wins (depends on CSS file order)

When we explicitly swap them:
- ✅ Only one is present at a time
- ✅ Clear visual state

---

## Visual Result

**Before fix:**
```
[Session Item]  ← Click → [Session Item]  (no visual change)
```

**After fix:**
```
[Session Item]  ← Click → [Session Item] ← accent border visible
```

---

## Affected Code

**Files changed:**
- `renderer.js` (lines ~2462-2472 for Gemini, ~2498-2512 for Claude)

**Both session lists fixed:**
- `#gemini-sessions-list .session-item`
- `#claude-sessions-list .session-item`

---

## Testing

1. Open app → Sessions tab
2. Save a Gemini session (💾 Save & Export)
3. Click on the session in the list
4. ✅ Border should turn accent color
5. Click another session
6. ✅ Previous loses selection, new one gets it

---

## Related Issues

This is a common Tailwind CSS gotcha:
- Always remove conflicting utility classes before adding new ones
- Don't rely on class order in JavaScript
- Be explicit about state changes

---

## Summary

**Problem:** `border-transparent` and `border-accent` both present → unpredictable
**Solution:** Explicitly swap classes → clear visual state
**Result:** Session selection now works visually ✅
