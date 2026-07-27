import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planAgentSettingsAvailability,
} from './agentSettingsAvailability.mjs';

test('new and stopped typed Claude/Codex tabs keep model and effort available', () => {
  for (const commandType of ['claude', 'codex']) {
    assert.deepEqual(planAgentSettingsAvailability({
      supportsKnobs: true,
      isSDKTab: false,
      hasAnySession: false,
      isCommandRunning: false,
      commandType,
    }), {
      showRightCluster: true,
      modelEffortInteractive: true,
      liveOnlyControlsDisabled: true,
    });

    assert.equal(planAgentSettingsAvailability({
      supportsKnobs: true,
      hasAnySession: true,
      isCommandRunning: false,
      commandType,
    }).showRightCluster, true);
  }
});

test('a generic empty shell does not acquire Claude controls from fallback labelling', () => {
  assert.deepEqual(planAgentSettingsAvailability({
    supportsKnobs: true,
    isSDKTab: false,
    hasAnySession: false,
    isCommandRunning: false,
    commandType: null,
  }), {
    showRightCluster: false,
    modelEffortInteractive: false,
    liveOnlyControlsDisabled: true,
  });
});
