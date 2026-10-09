// Diagnostic-only, independent of stores and IPC through Electron main.
// Dropped packets never queue work or affect the gesture they describe.
import { DIAGNOSTIC_COUNTER_LIMIT, getUIActionDiagnosticHealth, summarizeUIAction } from './uiPerformanceDiagnostics.mjs';

type DropReason = 'noConnection' | 'rateLimit' | 'backpressure' | 'writeThrow';
type Packet = Record<string, unknown> & { t: 'incident' | 'hb'; sourceBoot: string; sourceSeq: number; emittedAbs: number };
type Writer = (packet: Packet) => 'accepted' | 'noConnection' | 'backpressure';
type Heartbeat = { abs: number; vis: string; focused: boolean; context: string };
const own = (value: object, field: string) => Object.getOwnPropertyDescriptor(value, field)?.value;

export function addDiagnosticCount(value: number, count = 1): number {
  return Math.min(DIAGNOSTIC_COUNTER_LIMIT, value + (Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0));
}

// One boot/sequence/throttle across reconnects. Sequence counts eligible packet
// attempts, including drops; threshold-filtered observations are not attempts.
// Cumulative health is bounded and never reset on a successful heartbeat.
export function createPerfIncidentChannel({
  now = () => performance.now(),
  emittedNow = () => performance.timeOrigin + performance.now(),
  sourceBoot = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
  readActionHealth = getUIActionDiagnosticHealth,
} = {}) {
  let writer: Writer | null = null;
  let lastSentAt = -Infinity, sourceSeq = 0;
  let actionRingEvicted = 0, actionPhasesDropped = 0;
  const drops = { noConnection: 0, rateLimit: 0, backpressure: 0, writeThrow: 0 };
  const drop = (reason: DropReason) => { drops[reason] = addDiagnosticCount(drops[reason]); return false; };
  const nextSequence = () => (sourceSeq = Math.min(Number.MAX_SAFE_INTEGER, sourceSeq + 1));
  const health = () => {
    const actions = readActionHealth();
    actionRingEvicted = Math.max(actionRingEvicted, addDiagnosticCount(0, actions.actionRingEvicted));
    actionPhasesDropped = Math.max(actionPhasesDropped, addDiagnosticCount(0, actions.actionPhasesDropped));
    return { version: 1, counterLimit: DIAGNOSTIC_COUNTER_LIMIT, drops: { ...drops }, actionRingEvicted, actionPhasesDropped,
      saturated: Object.values(drops).some(n => n === DIAGNOSTIC_COUNTER_LIMIT)
        || actionRingEvicted === DIAGNOSTIC_COUNTER_LIMIT || actionPhasesDropped === DIAGNOSTIC_COUNTER_LIMIT,
      delivery: 'socket-write-only-no-ack' };
  };
  const write = (packet: Packet) => {
    if (!writer) return drop('noConnection');
    try {
      const result = writer(packet);
      if (result === 'accepted') return true;
      return drop(result === 'backpressure' ? 'backpressure' : 'noConnection');
    } catch { return drop('writeThrow'); }
  };
  return {
    setWriter(next: Writer | null) { writer = next; },
    health,
    report(kind: string, startAbs: number, durationMs: number, actionId?: string, summary?: object) {
      if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(kind) || !Number.isFinite(startAbs)
        || !Number.isFinite(durationMs) || durationMs < (kind.startsWith('ui-') ? 120 : 250)) return false;
      const seq = nextSequence();
      if (!writer) return drop('noConnection');
      const at = now();
      if (at - lastSentAt < 1000) return drop('rateLimit');
      // Bound attempts too: transport rejection must not become a retry loop.
      lastSentAt = at;
      let details = {};
      if (summary) {
        const { target, ...fields } = summarizeUIAction(summary, summary);
        details = { ...fields, targetSource: target.source, targetTag: target.tag,
          tabId: target.tab, historyOwner: target.historyOwner };
      }
      return write(Object.assign(Object.create(null), { t: 'incident', kind, startAbs, durationMs,
        ...(typeof actionId === 'string' && /^[\w:.-]{1,90}$/.test(actionId) ? { actionId } : {}),
        ...details,
        sourceBoot, sourceSeq: seq, emittedAbs: emittedNow() }) as Packet);
    },
    heartbeat(fields: Heartbeat) {
      const seq = nextSequence();
      const abs = own(fields, 'abs'), vis = own(fields, 'vis');
      const context = own(fields, 'context');
      return write(Object.assign(Object.create(null), { t: 'hb',
        abs: Number.isFinite(abs) ? abs : emittedNow(),
        vis: vis === 'visible' ? 'visible' : vis === 'hidden' ? 'hidden' : 'unknown',
        focused: own(fields, 'focused') === true,
        context: typeof context === 'string' && !/\w+:\/\/|^(?:data|blob|javascript|mailto|tel):|^\/\/|www\./i.test(context.slice(0, 512))
          ? context.slice(0, 512) : '',
        sourceBoot, sourceSeq: seq, emittedAbs: emittedNow(), diagnosticHealth: health() }) as Packet);
    },
  };
}

// net.Socket.write(false) ACCEPTED this packet, but asks us to stop writing
// until drain. No app queue, write callbacks, retry loop or timer is added.
export function createPerfSocketWriter(socket: any, pid: number): Writer {
  let backpressured = false;
  socket.on('drain', () => { backpressured = false; });
  return (packet) => {
    if (socket.destroyed || !socket.writable) return 'noConnection';
    if (backpressured || socket.writableLength >= 16384) return 'backpressure';
    const line = JSON.stringify(Object.assign(Object.create(null), packet, { proc: 'renderer', pid })) + '\n';
    if (socket.write(line) === false) backpressured = true;
    return 'accepted';
  };
}

const channel = createPerfIncidentChannel();
export const setPerfIncidentWriter = channel.setWriter;
export const reportPerfIncident = channel.report;
export const sendPerfHeartbeat = channel.heartbeat;
