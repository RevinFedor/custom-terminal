'use strict';

async function replaceAgentInputIfUnchangedAtBoundary({
  expectedText,
  replacementText,
  capture,
  restore,
  isCurrent = () => true,
} = {}) {
  if (
    typeof expectedText !== 'string'
    || typeof replacementText !== 'string'
    || typeof capture !== 'function'
    || typeof restore !== 'function'
  ) {
    return { success: false, replaced: false, error: 'invalid_arguments' };
  }

  const captured = await capture();
  if (captured?.success !== true || typeof captured.text !== 'string') {
    return {
      success: false,
      replaced: false,
      error: captured?.error || 'copy_input_failed',
    };
  }
  if (!isCurrent(captured)) {
    return { success: false, replaced: false, error: 'terminal_generation_changed' };
  }
  if (captured.text !== expectedText) {
    return {
      success: true,
      replaced: false,
      reason: 'input_changed',
      actualText: captured.text,
    };
  }

  const restored = await restore(replacementText);
  if (restored?.success !== true) {
    return {
      success: false,
      replaced: false,
      error: restored?.error || 'restore_input_failed',
    };
  }
  if (!isCurrent(restored)) {
    return { success: false, replaced: false, error: 'terminal_generation_changed' };
  }
  return { success: true, replaced: true };
}

module.exports = {
  replaceAgentInputIfUnchangedAtBoundary,
};
