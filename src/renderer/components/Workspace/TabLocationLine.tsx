// WHERE a pane's tab is — its working directory, said out loud.
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
// Now it is a second line inside each pane's own header, directly under the tab
// chip: the path belongs to the tab, so it belongs where the tab is named, and
// every pane answers for itself.

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
 * The path line of one pane's header.
 *
 * Colour sits deliberately between the two neighbours: brighter than the muted
 * grey it used to be (unreadable at a glance), dimmer than the tab name above it
 * (which must stay the loudest thing in the header). Юзер: *«сделай свет более
 * белым — не таким белым, как у заголовка, но не таким серым, как сейчас»*.
 */
export function TabLocationLine({ projectId, tabId }: { projectId: string; tabId: string }) {
  // Fingerprint selector: a string, never the tab object. The line re-renders on
  // an actual change of the path, not on every store write.
  const cwd = useWorkspaceStore((s) => (
    s.openProjects.get(projectId)?.tabs.get(tabId)?.cwd || ''
  ));

  const display = shortenHome(cwd);
  if (!display) return null;

  return (
    <div
      data-tab-location-line
      title={`${cwd}\nКлик — открыть в Finder`}
      onClick={(e) => { e.stopPropagation(); shell.openPath(cwd); }}
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
