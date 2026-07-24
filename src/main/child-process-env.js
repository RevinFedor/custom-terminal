'use strict';

const MAIN_PROCESS_ONLY_ENV_KEYS = Object.freeze([
  'ANTHROPIC_ADMIN_API_KEY',
  'ANTHROPIC_ADMIN_KEY',
]);
const mainProcessOnlyEnv = Object.create(null);

/**
 * Move privileged values out of process.env before Electron creates a renderer
 * or any other OS child. The values remain available to trusted main modules
 * through getMainProcessEnvValue().
 */
function isolateMainProcessEnv(sourceEnv = process.env) {
  if (!sourceEnv || typeof sourceEnv !== 'object') return;

  for (const key of MAIN_PROCESS_ONLY_ENV_KEYS) {
    if (Object.hasOwn(sourceEnv, key)) {
      mainProcessOnlyEnv[key] = sourceEnv[key];
      delete sourceEnv[key];
    }
  }
}

function getMainProcessEnvValue(key) {
  if (!MAIN_PROCESS_ONLY_ENV_KEYS.includes(key)) return undefined;
  return mainProcessOnlyEnv[key];
}

/**
 * Build the environment for any process outside the trusted Electron main
 * process. Admin reporting credentials stay in main; ordinary user credentials
 * and unrelated environment variables keep their existing behavior.
 */
function buildChildProcessEnv(overrides = {}, sourceEnv = process.env) {
  const childEnv = {
    ...(sourceEnv || {}),
    ...(overrides || {}),
  };

  for (const key of MAIN_PROCESS_ONLY_ENV_KEYS) {
    delete childEnv[key];
  }

  return childEnv;
}

module.exports = {
  MAIN_PROCESS_ONLY_ENV_KEYS,
  buildChildProcessEnv,
  getMainProcessEnvValue,
  isolateMainProcessEnv,
};
