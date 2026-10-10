import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/** Test the actual existing Main handlers. Only native Menu/OS/clipboard
 * effects are replaced; local-path parsing and the real filesystem stay real. */
export function historyFileMenuHarness(source) {
  const start = source.indexOf('function localPathFromMarkdownLink(');
  const end = source.indexOf("ipcMain.on('show-history-entry-context-menu'", start);
  if (start < 0 || end < start) throw Error('Main Markdown menu source boundary missing');
  const handlers = new Map(), calls = [], menus = [], logs = [];
  const context = {
    fs, path, fileURLToPath, URL, URLSearchParams,
    ipcMain: { on: (name, callback) => handlers.set(name, callback) },
    shell: {
      openExternal: async url => { calls.push({ kind: 'gt', url }); },
      showItemInFolder: file => calls.push({ kind: 'finder', file }),
    },
    openFileInSublime: async file => { calls.push({ kind: 'sublime', file }); return { success: true }; },
    clipboard: { writeText: () => { throw Error('OS clipboard forbidden in this test'); } },
    BrowserWindow: { fromWebContents: sender => sender.window },
    Menu: { buildFromTemplate: template => {
      const menu = { template, popup: options => { menu.options = options; } };
      menus.push(menu); return menu;
    } },
    console: Object.fromEntries(['log', 'warn', 'error'].map(key => [key, (...args) => logs.push({ key, args })])),
  };
  vm.runInNewContext(source.slice(start, end), context, { filename: 'actual-main-markdown-file-menu.js' });
  return {
    calls, menus, logs, source: source.slice(start, end),
    show: payload => {
      const count = menus.length;
      handlers.get('show-markdown-link-context-menu')({ sender: { window: { fixture: 'owned-menu-test' } } }, payload);
      return menus.length > count ? menus.at(-1) : null;
    },
  };
}
