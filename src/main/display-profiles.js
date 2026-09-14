'use strict';

const CONTEXT_CHANNEL = 'display-profiles:get-context';
const CHANGED_CHANNEL = 'display-profiles:changed';

function displayContext(display) {
  // Electron 28 Display.id is the OS identity; bounds/scale/label are metadata.
  // Never identify a monitor by its resolution or by its position in the list.
  if (!display || !Number.isFinite(display.id) || display.id === -1) return null;
  return {
    key: `display:${display.id}`,
    label: display.label?.trim() || (display.internal ? 'Встроенный экран' : `Монитор ${display.id}`),
    internal: display.internal === true,
    width: display.bounds.width,
    height: display.bounds.height,
    scaleFactor: display.scaleFactor,
  };
}

function attachDisplayProfiles(window, { screen, ipcMain }) {
  const contents = window.webContents;
  let disposed = false;
  let previous = '';
  let ignoringSizeMenuShortcut = false;
  const onBeforeInput = (_event, input) => {
    const ignore = !!input.meta && !input.control && !input.alt && !input.isComposing
      && ['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'].includes(input.code);
    if (ignore === ignoringSizeMenuShortcut) return;
    ignoringSizeMenuShortcut = ignore;
    // Electron's application-menu zoom accelerator runs before DOM keydown.
    // Let the page receive Cmd± while bypassing ONLY its native menu action.
    contents.setIgnoreMenuShortcuts(ignore);
  };
  const snapshot = () => ({
    current: displayContext(screen.getDisplayMatching(window.getBounds())),
    displays: screen.getAllDisplays().map(displayContext).filter(Boolean),
  });
  const publish = (force = false) => {
    if (disposed || window.isDestroyed() || contents.isDestroyed()) return;
    const context = snapshot();
    const fingerprint = JSON.stringify(context);
    if (!force && fingerprint === previous) return;
    previous = fingerprint;
    contents.send(CHANGED_CHANNEL, context);
  };
  const onChange = () => publish();
  const onLoaded = () => publish(true);
  const windowEvents = ['move', 'moved', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen'];
  const screenEvents = ['display-added', 'display-removed', 'display-metrics-changed'];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const event of windowEvents) window.removeListener(event, onChange);
    for (const event of screenEvents) screen.removeListener(event, onChange);
    contents.removeListener('did-finish-load', onLoaded);
    contents.removeListener('before-input-event', onBeforeInput);
    contents.removeListener('destroyed', dispose);
    window.removeListener('closed', dispose);
    ipcMain.removeHandler(CONTEXT_CHANNEL);
    if (ignoringSizeMenuShortcut && !contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false);
  };
  ipcMain.handle(CONTEXT_CHANNEL, (event) => {
    if (disposed || event.sender !== contents || window.isDestroyed()) {
      throw new Error('Display context belongs to the main window');
    }
    return snapshot();
  });
  for (const event of windowEvents) window.on(event, onChange);
  for (const event of screenEvents) screen.on(event, onChange);
  contents.on('did-finish-load', onLoaded);
  contents.on('before-input-event', onBeforeInput);
  contents.on('destroyed', dispose);
  window.on('closed', dispose);
  return dispose;
}

module.exports = { displayContext, attachDisplayProfiles };
