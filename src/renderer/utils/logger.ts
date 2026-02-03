/**
 * Centralized Debug Logger
 *
 * Uses the `debug` npm package for conditional logging.
 *
 * Usage in code:
 *   import { log } from '../utils/logger';
 *   log.claude('Session started:', sessionId);
 *   log.tabs('Color changed:', color);
 *
 * Enable in browser console (then refresh):
 *   localStorage.debug = 'app:*'           // all logs
 *   localStorage.debug = 'app:claude'      // only claude
 *   localStorage.debug = 'app:claude,app:tabs'  // multiple
 *   localStorage.debug = ''                // disable all
 *
 * Or via environment variable (for main process):
 *   DEBUG=app:* npm run dev
 */

import createDebug from 'debug';

// Enable specific categories by default for development
// Change this line to enable/disable debug categories
if (typeof window !== 'undefined') {
  localStorage.debug = 'app:tabs'; // Debug tab rename issue
}

// Define all log categories
export const log = {
  // Claude session handling
  claude: createDebug('app:claude'),

  // Gemini session handling
  gemini: createDebug('app:gemini'),

  // Tab operations (colors, creation, switching)
  tabs: createDebug('app:tabs'),

  // Performance timing
  perf: createDebug('app:perf'),

  // Terminal operations
  terminal: createDebug('app:terminal'),

  // Store actions
  store: createDebug('app:store'),

  // UI interactions (hotkeys, modals)
  ui: createDebug('app:ui'),

  // Research panel
  research: createDebug('app:research'),

  // Command interception (npm, claude, gemini detection)
  commands: createDebug('app:commands'),
};

// Helper to enable/disable in console without remembering localStorage syntax
export const debugHelpers = {
  enable: (categories: string) => {
    localStorage.debug = categories;
    console.log(`Debug enabled: ${categories}`);
    console.log('Refresh page to apply changes');
  },
  disable: () => {
    localStorage.debug = '';
    console.log('Debug disabled. Refresh page to apply.');
  },
  status: () => {
    console.log('Current debug:', localStorage.debug || '(none)');
  },
  help: () => {
    console.log(`
Debug Logger Help:
  debug.enable('app:*')           - Enable all logs
  debug.enable('app:claude')      - Enable claude logs only
  debug.enable('app:tabs,app:perf') - Enable multiple categories
  debug.disable()                 - Disable all logs
  debug.status()                  - Show current setting

Available categories:
  app:claude   - Claude session handling
  app:gemini   - Gemini session handling
  app:tabs     - Tab operations (colors, creation)
  app:perf     - Performance timing
  app:terminal - Terminal operations
  app:store    - Store actions
  app:ui       - UI interactions
  app:research - Research panel
  app:commands - Command detection (npm, claude, gemini)
    `);
  }
};

// Expose helpers globally for console access
if (typeof window !== 'undefined') {
  (window as any).debug = debugHelpers;
}
