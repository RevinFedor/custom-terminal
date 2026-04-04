/**
 * Simple localStorage-based storage for Sidebar settings (icons, sort, expanded state).
 * Async API to match gt-editor's storage interface.
 */
export function getValue(key: string, defaultValue: any = null): any {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

export function setValue(key: string, value: any): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
