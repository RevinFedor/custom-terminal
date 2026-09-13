'use strict';

/**
 * Keep local-command observation outside the PTY admission boundary.
 *
 * `prepare` may capture a transcript offset, but it must not publish busy state
 * or register an active watcher. Only a result with `submitted === true`
 * proves that Enter crossed the PTY write boundary and may activate the
 * observer. A refusal before Enter discards the inert preparation.
 */
async function submitWithClaudeLocalCommandLifecycle({
  command,
  prepare,
  submit,
  activate,
  discard,
}) {
  if (typeof submit !== 'function') {
    throw new TypeError('submit must be a function');
  }

  const preparation = typeof prepare === 'function'
    ? prepare(command)
    : null;

  let result;
  try {
    result = await submit(preparation);
  } catch (error) {
    if (preparation && typeof discard === 'function') {
      discard(preparation, {
        reason: 'submit-threw-before-proof',
        error,
      });
    }
    throw error;
  }

  if (!preparation) return result;

  if (result?.submitted === true) {
    if (typeof activate === 'function') {
      activate(preparation, result);
    }
  } else if (typeof discard === 'function') {
    discard(preparation, {
      reason: result?.deferred === true
        ? 'submit-deferred-before-enter'
        : 'submit-not-proven',
      result,
    });
  }

  return result;
}

module.exports = {
  submitWithClaudeLocalCommandLifecycle,
};
