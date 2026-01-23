/**
 * Default Editor & UI Settings
 * Copied from gt-editor/src/App.jsx DEFAULT_SETTINGS
 */

export interface EditorSettings {
  // Text wrapping
  wordWrap: boolean;

  // Confirmations
  confirmDelete: boolean;

  // Icon theme: 'vscode' for file icons, 'emoji' for emoji icons
  iconTheme: 'vscode' | 'emoji';

  // Font sizes (in pixels)
  editorFontSize: number;
  sidebarFontSize: number;
  tabsFontSize: number;

  // Custom icon rules for file extensions
  // Example: [{ pattern: '*.md', icon: '📝' }]
  customIconRules: Array<{
    pattern: string;
    icon: string;
  }>;
}

/**
 * Default settings from gt-editor
 */
export const DEFAULT_SETTINGS: EditorSettings = {
  wordWrap: true,
  confirmDelete: true,
  iconTheme: 'vscode',
  editorFontSize: 14,
  sidebarFontSize: 13,
  tabsFontSize: 13,
  customIconRules: [],
};

/**
 * Settings constraints
 */
export const SETTINGS_CONSTRAINTS = {
  fontSize: {
    min: 8,
    max: 32,
  },
  sidebarWidth: {
    min: 150,
    max: 500,
    default: 260,
  },
} as const;

/**
 * Storage keys for localStorage
 */
export const STORAGE_KEYS = {
  settings: 'gt-settings',
  session: 'gt-session',
  sidebarWidth: 'gt-sidebar-width',
} as const;

/**
 * Load settings from localStorage with migration support
 */
export function loadSettings(): EditorSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.settings);
    if (saved) {
      const parsed = JSON.parse(saved);

      // Migration: if old fontSize exists, convert to new fields
      if (parsed.fontSize && !parsed.editorFontSize) {
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          editorFontSize: parsed.fontSize,
          sidebarFontSize: parsed.fontSize - 1,
          tabsFontSize: parsed.fontSize - 1,
        };
      }

      // Fill in missing fields with defaults
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (error) {
    console.error('[Settings] Failed to load settings:', error);
  }

  return DEFAULT_SETTINGS;
}

/**
 * Save settings to localStorage
 */
export function saveSettings(settings: EditorSettings): void {
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  } catch (error) {
    console.error('[Settings] Failed to save settings:', error);
  }
}

/**
 * Adjust all font sizes by delta (for Cmd+/Cmd-)
 */
export function adjustFontSizes(
  settings: EditorSettings,
  delta: number
): EditorSettings {
  const { min, max } = SETTINGS_CONSTRAINTS.fontSize;

  return {
    ...settings,
    editorFontSize: Math.min(max, Math.max(min, settings.editorFontSize + delta)),
    sidebarFontSize: Math.min(max, Math.max(min, settings.sidebarFontSize + delta)),
    tabsFontSize: Math.min(max, Math.max(min, settings.tabsFontSize + delta)),
  };
}
