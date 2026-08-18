// Pull a session UUID out of the clipboard.
//
// The clipboard rarely holds a bare id: it might be raw whitespace ("  uuid \n"),
// a TUI bracketed-paste echo, or a whole "/resume <uuid>" line the user copied
// out of Timeline or a chat. So this SEARCHES for a uuid rather than validating
// the whole string — the alternative refuses perfectly good clipboards for
// having a space in them.
//
// Lives here rather than inside a component because two surfaces launch clipboard
// forks now: the control bar of an empty tab, and the header of an empty
// workspace pane (AiLaunchStrip is shared between them). Two copies of a regex
// is exactly how one surface ends up accepting an id the other rejects.

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The first uuid in the clipboard text, or null when there is none. */
export function readSessionIdFromClipboard(): string | null {
  try {
    const { clipboard } = window.require('electron');
    const raw = String(clipboard.readText() || '').trim();
    const match = raw.match(UUID_ANYWHERE);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}
