// Real Main/controller-generated DTOs, replayed into the actual HistoryPanel.
// The transport, writer-admission maps and initial transcript are fixtures;
// this is a component integration control, NOT native/provider E2E.
import { ipcRenderer } from 'electron';
import '@noted/claude-blocks/styles.css';
import { mountHistoryPreviewFixture } from './history-preview-reading';

async function setup() {
  const events = await fetch('/events.json').then(response => response.json());
  const f = mountHistoryPreviewFixture({ provider: 'codex', tabId: events.tabId, sessionId: events.sessionId });
  const emit = (stage: string) => {
    for (const event of events[stage]) ipcRenderer.emit(event.channel, {}, event.detail);
  };
  (window as any).fixture = { ...f, text: events.text, identity: events.identity,
    itemId: events.itemId, stages: { live: events.live.length, held: events.held.length,
      released: events.released.length },
    live: () => emit('live'), held: () => emit('held'), release: () => emit('released'), ready: true };
}
void setup();
