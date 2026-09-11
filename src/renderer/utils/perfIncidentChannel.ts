// Diagnostic-only, independent of stores and IPC through Electron main.
// Dropped packets never queue work or affect the gesture they describe.
type Incident = { kind: string; startAbs: number; durationMs: number };
let writer: ((incident: Incident) => void) | null = null;
let lastSentAt = -Infinity;

export function setPerfIncidentWriter(next: typeof writer) { writer = next; }

export function reportPerfIncident(kind: string, startAbs: number, durationMs: number) {
  if (!writer || !Number.isFinite(durationMs) || durationMs < 250) return;
  const now = performance.now();
  if (now - lastSentAt < 1000) return;
  lastSentAt = now;
  try { writer({ kind: kind.slice(0, 64), startAbs, durationMs }); } catch { /* diagnostics only */ }
}
