// WHICH control is busy, not merely THAT something is.
//
// The bar raises a busy flag with a reason string ("claude-model:opus",
// "codex-effort:high", "provider:zen", …). The old presentation threw that
// detail away: the whole right cluster got a shimmer sweeping across it, so a
// change of one value lit up a strip the width of the window, and while the
// sweep was between passes there was no visible sign of anything happening at
// all. The user could not tell what was being applied, or whether it still was.
//
// Keeping the reason lets the spinner sit on the ONE control being changed,
// while its neighbours simply become unavailable — the ordinary way a UI says
// "this is in flight, that is blocked meanwhile".

/** @typedef {'model'|'effort'|'provider'|'think'|'fast'|'quick'|'session'|null} ControlBarBusyTarget */

/**
 * @param {string|null|undefined} reason
 * @returns {ControlBarBusyTarget} which control the spinner belongs on, or null
 *          when the reason names none of them (then nothing spins and the
 *          cluster is simply unavailable).
 */
export function controlBarBusyTarget(reason) {
  const value = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  if (!value) return null;
  // Order matters: a combined model+effort application is ONE gesture the user
  // started on the model row, so it belongs on the model control — checking
  // "effort" first would move the spinner to a control they never touched.
  if (value.startsWith('provider-model:')) return 'model';
  if (value.startsWith('provider')) return 'provider';
  if (value.includes('model')) return 'model';
  if (value.includes('think')) return 'think';
  if (value.includes('fast')) return 'fast';
  if (value.includes('quick')) return 'quick';
  if (value.includes('effort')) return 'effort';
  if (
    value.includes('start')
    || value.includes('continue')
    || value.includes('resume')
    || value.includes('stop')
    || value.includes('session')
  ) return 'session';
  return null;
}

/**
 * Is THIS control the one that should show the spinner?
 *
 * @param {object} args
 * @param {boolean} args.busy      is any local control operation in flight
 * @param {string|null} args.reason the reason that raised it
 * @param {ControlBarBusyTarget} args.control which control is asking
 * @returns {boolean}
 */
export function isControlBarBusyTarget({ busy, reason, control }) {
  if (!busy || !control) return false;
  return controlBarBusyTarget(reason) === control;
}

/**
 * Should THIS control be blocked while another one is being applied?
 *
 * Everything is blocked during a write — the CLI applies one setting at a time —
 * but the control that owns the spinner is NOT "disabled": it stays clickable so
 * the gesture can be cancelled. That is the whole difference between "waiting"
 * and "unavailable", and it has to be visible.
 *
 * @param {object} args
 * @param {boolean} args.busy
 * @param {string|null} args.reason
 * @param {ControlBarBusyTarget} args.control
 * @returns {boolean}
 */
export function isControlBarBusyBlocked({ busy, reason, control }) {
  if (!busy) return false;
  if (!control) return true;
  return controlBarBusyTarget(reason) !== control;
}
