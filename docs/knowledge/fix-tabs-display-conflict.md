# Tabs Display Conflict (Cross-Project Tab Visibility)

## Problem
When switching between open projects (Level 1 tabs), tabs from ALL projects (Level 2 tabs) remain visible instead of showing only the active project's tabs.

## Symptoms
- Project chips in title bar switch correctly (Level 1 tabs work fine)
- All terminal tabs from all open projects appear simultaneously in the tabs bar
- Example: Project A has 1 tab, Project B has 1 tab → both tabs visible regardless of which project is active
- Console shows correct hiding logic:
  ```
  [renderTabsForProject] Hidden 2 tabs total
  [renderTabsForProject] Shown 1 tabs for current project
  ```
- Despite "hidden" message, tabs remain visible

## Root Cause
**CSS Specificity Conflict**: The `.active` class rule with `!important` overrides inline styles.

```css
/* output.css:1068-1070 */
.active {
  display: flex !important;
}
```

When `renderTabsForProject()` tries to hide tabs:
```javascript
tabData.element.style.display = 'none'; // ❌ IGNORED by CSS !important
```

Sequence of events:
1. User switches from Project A to Project B
2. `renderTabsForProject()` runs to hide all tabs
3. Code sets `style.display = 'none'` on tab elements
4. Active tab from Project A still has `.active` class
5. CSS rule `.active { display: flex !important; }` wins
6. Result: Project A's active tab remains visible

## Why Project Chips (Level 1) Work Fine
The code properly removes the `.active` class from project chips:
```javascript
projectChipsContainer.querySelectorAll('.project-chip').forEach(chip => {
  chip.classList.remove('active', '!bg-accent', '!border-accent', '!text-white');
});
```

But for Level 2 tabs, the code **forgot** to remove the class:
```javascript
// ❌ BEFORE (renderer.js:499-509)
openProjects.forEach((pd, pdId) => {
  pd.tabs.forEach(tabData => {
    tabData.element.style.display = 'none';  // Doesn't work with .active class!
    tabData.wrapper.style.display = 'none';
    tabData.wrapper.classList.remove('active'); // Only wrapper, not element!
    hiddenCount++;
  });
});
```

## Solution
Remove the `.active` class from **both** the tab element and wrapper:

```javascript
// ✅ AFTER (renderer.js:499-509)
openProjects.forEach((pd, pdId) => {
  pd.tabs.forEach(tabData => {
    tabData.element.style.display = 'none';
    tabData.element.classList.remove('active'); // ← ADD THIS LINE
    tabData.wrapper.style.display = 'none';
    tabData.wrapper.classList.remove('active');
    hiddenCount++;
  });
});
```

## Why This Bug is Subtle
1. **CSS `!important` is invisible** - Developer Console shows `display: none` in inline styles, but computed style shows `display: flex`
2. **Inconsistent pattern** - Other parts of the codebase correctly remove `.active` class, creating false pattern
3. **Console logs lie** - Logs say "Hidden 2 tabs" because code ran, but CSS silently overrides it
4. **Works on first load** - Tabs without `.active` class hide correctly, problem only appears after switching

## Debugging Tips
When inline styles don't work:
1. Check DevTools → Computed tab, not Styles tab
2. Look for `!important` rules in CSS
3. Search codebase for `.active` class usages
4. Compare working code (project chips) vs broken code (tabs)

## Files Involved
- `renderer.js:503-504` - Fix location (add classList.remove)
- `output.css:1068-1070` - CSS rule with !important
- `renderer.js:340-366` - Project chips (working example)

## Prevention
**Code Review Checklist**:
- [ ] When hiding elements with inline styles, first remove conflicting classes
- [ ] Search for `!important` in CSS before assuming inline styles will work
- [ ] Apply consistent patterns: if one code path removes `.active`, all should
- [ ] Test element hiding after it's been shown (not just initial state)
