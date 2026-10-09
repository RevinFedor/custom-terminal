'use strict';
const { randomUUID } = require('node:crypto');
const { normalizeSwitcherRequest, switcherRequestKey } = require('../shared/workspace-switcher-contract.cjs');
const CAPABILITY = Object.freeze({ version: 1, iconCatalogVersion: 1, endpoint: '/api/workspace/switcher',
  scopes: ['desktop', 'native'], event: 'project-activity', wakeField: 'workspaceSwitcher',
  ordering: 'epoch-revision', completeCatalog: true });
const fail = (code, statusCode = 503) => { throw Object.assign(new Error(code), { code, statusCode }); };
const frameKey = frame => frame && Number.isInteger(frame.processId) && Number.isInteger(frame.routingId)
  ? frame.processId + ':' + frame.routingId : null;

// A lease for read replies, not a workspace owner or executor. Epochs are issued
// by Main so an old async renderer/StrictMode instance cannot resurrect itself.
class WorkspaceSwitcherReadProjection {
  constructor({ preferredRenderer, bridgeRead, onChanged = () => {}, uuid = randomUUID }) {
    Object.assign(this, { preferredRenderer, bridgeRead, onChanged, uuid });
    this.source = null; this.epoch = uuid(); this.revision = 0;
  }
  current(source) {
    try {
      const sender = this.preferredRenderer();
      return source && this.source === source && sender === source.sender && !sender.isDestroyed()
        && frameKey(sender.mainFrame) === source.frame;
    } catch { return false; }
  }
  retire(source = this.source, reason = 'retired') {
    if (source !== this.source) return;
    source?.cleanup?.(); this.source = null; this.epoch = this.uuid(); this.revision = 0;
    if (source) console.log('[WorkspaceSwitcher] lease-retired reason=' + reason
      + ' wc=' + source.sender.id + ' frame=' + source.frame + ' epoch=' + source.epoch + ' nextEpoch=' + this.epoch);
    this.onChanged();
  }
  register(event) {
    const sender = this.preferredRenderer();
    if (!sender || sender.isDestroyed() || event.sender !== sender
      || !frameKey(event.senderFrame) || frameKey(event.senderFrame) !== frameKey(sender.mainFrame)) fail('switcher_renderer_unavailable');
    this.source?.cleanup?.();
    const source = { sender, frame: frameKey(event.senderFrame), epoch: this.uuid(), revision: 0, available: false };
    this.source = source; this.epoch = source.epoch; this.revision = 0;
    const destroyed = () => this.retire(source, 'destroyed');
    const processGone = () => this.retire(source, 'render-process-gone');
    // A navigation attempt can be cancelled by the window's will-navigate
    // policy (external links). That leaves the same App mounted, with no new
    // registration. Retire only after main-document navigation commits;
    // current() still rejects a replaced frame before an async read publishes.
    const navigate = () => this.retire(source, 'main-document-navigated');
    sender.on('destroyed', destroyed); sender.on('render-process-gone', processGone); sender.on('did-navigate', navigate);
    source.cleanup = () => { sender.removeListener('destroyed', destroyed); sender.removeListener('render-process-gone', processGone);
      sender.removeListener('did-navigate', navigate); };
    console.log('[WorkspaceSwitcher] lease-registered wc=' + sender.id + ' frame=' + source.frame + ' epoch=' + source.epoch);
    this.onChanged(); return { version: 1, epoch: source.epoch };
  }
  changed(event, value) {
    const source = this.source;
    if (!this.current(source) || event.sender !== source.sender || frameKey(event.senderFrame) !== source.frame
      || value?.version !== 1 || value.epoch !== source.epoch
      || !Number.isSafeInteger(value.revision) || value.revision <= source.revision || typeof value.available !== 'boolean') return false;
    if (source.available !== value.available) console.log('[WorkspaceSwitcher] availability wc=' + source.sender.id
      + ' epoch=' + source.epoch + ' revision=' + value.revision + ' available=' + value.available);
    source.revision = value.revision; source.available = value.available;
    this.revision = source.revision; this.onChanged(); return true;
  }
  unregister(event, value) {
    const source = this.source;
    if (this.current(source) && source.sender === event.sender && source.frame === frameKey(event.senderFrame)
      && source.epoch === value?.epoch) this.retire(source, 'renderer-unregister');
  }
  wake() {
    return { version: 1, epoch: this.epoch, revision: this.revision,
      available: !!(this.current(this.source) && this.source.available), scopes: ['desktop', 'native'] };
  }
  async read(raw) {
    const request = normalizeSwitcherRequest(raw), source = this.source;
    if (!this.current(source) || !source.available) fail('switcher_renderer_unavailable');
    const result = await this.bridgeRead({ ...request, epoch: source.epoch });
    if (!this.current(source)) fail('switcher_snapshot_superseded', 409);
    if (result?.error) fail(result.error, result.statusCode === 409 || result.statusCode === 400 ? result.statusCode : 503);
    if (result?.version !== 1 || result.iconCatalogVersion !== 1 || !result.icons || typeof result.icons !== 'object' || Array.isArray(result.icons)
      || result.known !== true || result.epoch !== source.epoch
      || result.requestKey !== switcherRequestKey(request) || !Array.isArray(result.rows)
      || !Number.isSafeInteger(result.revision)) fail('switcher_snapshot_invalid', 502);
    if (result.revision < source.revision) fail('switcher_snapshot_superseded', 409);
    if (result.revision > source.revision || !source.available) {
      source.revision = result.revision; source.available = true;
      this.revision = result.revision; this.onChanged();
    }
    return { ok: true, ...result, rendererOwner: { webContentsId: source.sender.id, frame: source.frame } };
  }
}
module.exports = { WorkspaceSwitcherReadProjection, WORKSPACE_SWITCHER_CAPABILITY: CAPABILITY, frameKey };
