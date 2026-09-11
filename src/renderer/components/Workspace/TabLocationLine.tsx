// WHERE the current work will run — its working directory, said out loud.
//
// The directory belongs to the TAB, not to the project: every tab carries its
// own cwd (a `cd` in the terminal moves it, a tab can sit in a worktree while
// its project points at the main checkout). The project only supplies the
// DEFAULT for new tabs. Nothing on screen said this, so "which folder am I in"
// was answerable only by reading the shell prompt — and the Git button, which
// used the PROJECT path, quietly answered about a different folder than the one
// the user was working in.
//
// WHERE IT LIVES, and why it moved (2026-08-17). This started as a full-width
// row under the toolbar. Two things were wrong with that, and they are the same
// mistake seen from two sides:
//   • a screen-wide line spent on one short label is out of proportion to what
//     it says — юзер: *«это нахуя кусок ради вот этого вот показа? выделил
//     целую строку»*;
//   • being screen-wide, it could only speak about ONE tab (the active one), so
//     in a split the other panes' paths were not shown at all.
// It now lives once above the project's tab list. A real tab uses it as a
// reveal-in-Finder link. The pre-tab chooser reuses the exact same visual line
// for its future cwd, but clicking it selects a directory instead.

import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

// Same access path the tab list and the help modal use for "reveal in Finder".
const { shell } = window.require('electron');

const HOME = (typeof process !== 'undefined' && process.env.HOME) || '';

/** `/Users/fedor/x` → `~/x`. The home prefix is noise on every single path. */
export function shortenHome(fullPath: string, home = HOME): string {
  const value = String(fullPath || '');
  if (!home || !value.startsWith(home)) return value;
  const rest = value.slice(home.length);
  if (rest === '') return '~';
  if (rest.startsWith('/')) return '~' + rest;
  return value;
}

/**
 * The existing compact path line, with an optional pre-tab selection action.
 *
 * Colour sits deliberately between the two neighbours: brighter than the muted
 * grey it used to be (unreadable at a glance), dimmer than the tab name above it
 * (which must stay the loudest thing in the header). Юзер: *«сделай свет более
 * белым — не таким белым, как у заголовка, но не таким серым, как сейчас»*.
 */
export function TabLocationLine({
  projectId = '',
  tabId = '',
  cwd: explicitCwd,
  onSelectDirectory,
}: {
  projectId?: string;
  tabId?: string;
  cwd?: string;
  onSelectDirectory?: () => void | Promise<void>;
}) {
  // Fingerprint selector: a string, never the tab object. The line re-renders on
  // an actual change of the path, not on every store write.
  const tabCwd = useWorkspaceStore((s) => (
    s.openProjects.get(projectId)?.tabs.get(tabId)?.cwd || ''
  ));
  const cwd = explicitCwd === undefined ? tabCwd : explicitCwd;

  const display = shortenHome(cwd);
  if (!display) return null;

  return (
    <div
      data-tab-location-line
      data-window-chooser-location={onSelectDirectory ? 'true' : undefined}
      title={`${cwd}\nКлик — ${onSelectDirectory ? 'выбрать директорию' : 'открыть в Finder'}`}
      onClick={(e) => {
        e.stopPropagation();
        if (onSelectDirectory) void onSelectDirectory();
        else void shell.openPath(cwd);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        display: 'flex',
        alignItems: 'center',
        minWidth: 0,
        fontSize: 10,
        lineHeight: 1.1,
        // Zero vertical padding, by request: the header reserves this line's
        // height itself (SPLIT_ATTACH_PATH_LINE_H), so padding here would add a
        // second, invisible source of the same number — and the two would then
        // have to agree forever.
        padding: 0,
        margin: 0,
        color: '#a8a8ae',
        cursor: 'pointer',
        userSelect: 'none',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#dcdce1'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#a8a8ae'; }}
    >
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          direction: 'rtl',
          textAlign: 'left',
        }}
      >
        {/* RTL direction clips the START of a long path (…/src/renderer) —
            the tail is what identifies a folder; the prefix is the same for
            every project. The bidi isolate keeps the slashes in order. */}
        &#x2066;{display}&#x2069;
      </span>
    </div>
  );
}
