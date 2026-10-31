'use strict';

// The same issue/settled rule as input-preroll: observe a deadline without
// replacing the original operation. Only raw settlement advances cleanup.
function issue(method, invoke, { now, allowed = () => true, onIssue = () => {}, onSettle = () => {} }) {
  const op = { method, state: 'pending', sent: false, expired: false, value: null,
    issuedMonoMs: null, settledMonoMs: null };
  op.promise = Promise.resolve().then(() => {
    if (!allowed()) throw Object.assign(new Error('profile-cleanup-authority-lost'), { notSent: true });
    op.issuedMonoMs = now(); op.sent = true; onIssue(op);
    return invoke();
  }).then(value => {
    op.state = 'ok'; op.value = value;
  }, error => {
    // Only explicit no-effect evidence permits retirement of an unknown START.
    op.state = error?.notSent === true || (method === 'Tracing.start'
      && (error?.code === 'TRACING_ALREADY_STARTED'
        || /^Tracing (?:already started|is already started|has already been started)\.?$/i.test(error?.message)))
      ? 'refused' : 'unknown';
    op.error = String(error?.message || error).slice(0, 180);
  }).then(() => {
    op.settledMonoMs = now();
    try { onSettle(op); } catch {} // diagnostics must not reject the raw observer
    return op;
  });
  return op;
}

async function settled(op, { commandDeadline, until, now, commandMs = 3000 }) {
  if (!op) return true;
  if (op.state === 'pending' && !op.expired) {
    const remaining = Math.min(commandMs, until - now());
    if (remaining > 0) {
      try { await commandDeadline(op.promise, op.method, remaining); }
      catch { if (op.state === 'pending') op.expired = true; }
    } else op.expired = true;
  }
  return op.state === 'ok';
}

function timing(op) {
  return op ? { state: op.state, sent: op.sent, expired: op.expired,
    issuedMonoMs: op.issuedMonoMs, settledMonoMs: op.settledMonoMs,
    ...(op.method === 'Profiler.stop' ? { profileStartTimeUs: op.profileStartTimeUs ?? null,
      profileEndTimeUs: op.profileEndTimeUs ?? null } : {}) } : null;
}

module.exports = { issue, settled, timing };
