'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAIN_PROCESS_ONLY_ENV_KEYS,
  buildChildProcessEnv,
  getMainProcessEnvValue,
  isolateMainProcessEnv,
} = require('./child-process-env');

test('main-only credentials are removed from process.env but stay available to main', () => {
  const touchedKeys = [...MAIN_PROCESS_ONLY_ENV_KEYS, 'ANTHROPIC_API_KEY', 'CUSTOM_USER_SETTING'];
  const saved = new Map(touchedKeys.map((key) => [
    key,
    {
      present: Object.hasOwn(process.env, key),
      value: process.env[key],
    },
  ]));

  try {
    process.env.ANTHROPIC_ADMIN_API_KEY = 'isolated-admin-api-secret';
    process.env.ANTHROPIC_ADMIN_KEY = 'isolated-admin-secret';
    process.env.ANTHROPIC_API_KEY = 'ordinary-user-key';
    process.env.CUSTOM_USER_SETTING = 'preserved';

    isolateMainProcessEnv();

    assert.equal(Object.hasOwn(process.env, 'ANTHROPIC_ADMIN_API_KEY'), false);
    assert.equal(Object.hasOwn(process.env, 'ANTHROPIC_ADMIN_KEY'), false);
    assert.equal(getMainProcessEnvValue('ANTHROPIC_ADMIN_API_KEY'), 'isolated-admin-api-secret');
    assert.equal(getMainProcessEnvValue('ANTHROPIC_ADMIN_KEY'), 'isolated-admin-secret');
    assert.equal(process.env.ANTHROPIC_API_KEY, 'ordinary-user-key');
    assert.equal(process.env.CUSTOM_USER_SETTING, 'preserved');
    assert.equal(getMainProcessEnvValue('ANTHROPIC_API_KEY'), undefined);
  } finally {
    for (const [key, original] of saved) {
      if (original.present) process.env[key] = original.value;
      else delete process.env[key];
    }
  }
});

test('child process env removes only Anthropic admin credentials', () => {
  const source = {
    ANTHROPIC_ADMIN_API_KEY: 'admin-api-secret',
    ANTHROPIC_ADMIN_KEY: 'admin-secret',
    ANTHROPIC_API_KEY: 'ordinary-user-key',
    HOME: '/tmp/example-home',
    PATH: '/usr/bin',
    CUSTOM_USER_SETTING: 'preserved',
  };

  const childEnv = buildChildProcessEnv({}, source);

  for (const key of MAIN_PROCESS_ONLY_ENV_KEYS) {
    assert.equal(Object.hasOwn(childEnv, key), false);
  }
  assert.equal(childEnv.ANTHROPIC_API_KEY, source.ANTHROPIC_API_KEY);
  assert.equal(childEnv.HOME, source.HOME);
  assert.equal(childEnv.PATH, source.PATH);
  assert.equal(childEnv.CUSTOM_USER_SETTING, source.CUSTOM_USER_SETTING);
  assert.equal(source.ANTHROPIC_ADMIN_API_KEY, 'admin-api-secret');
  assert.equal(source.ANTHROPIC_ADMIN_KEY, 'admin-secret');
});

test('child process env sanitizes overrides after merging them', () => {
  const childEnv = buildChildProcessEnv({
    ANTHROPIC_ADMIN_API_KEY: 'must-not-return',
    ANTHROPIC_ADMIN_KEY: 'must-not-return-either',
    PATH: '/custom/bin',
    ADDED_FOR_CHILD: 'yes',
  }, {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'ordinary-user-key',
  });

  assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_ADMIN_API_KEY'), false);
  assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_ADMIN_KEY'), false);
  assert.equal(childEnv.ANTHROPIC_API_KEY, 'ordinary-user-key');
  assert.equal(childEnv.PATH, '/custom/bin');
  assert.equal(childEnv.ADDED_FOR_CHILD, 'yes');
});
