import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexAdditionalLimitRows,
  buildCodexMainUsageView,
  visibleCodexResetCredits,
} from './codexUsagePresentation.mjs';

test('weekly-only Codex usage has no five-hour metric or compact divider', () => {
  assert.deepEqual(buildCodexMainUsageView({
    seven_day: { utilization: 54 },
    five_hour: null,
  }), {
    weeklyUsed: 54,
    fiveHourUsed: null,
    hasWeekly: true,
    hasFiveHour: false,
    showDivider: false,
    metricKeys: ['weekly'],
  });
});

test('a returned five-hour window restores the metric and divider', () => {
  const view = buildCodexMainUsageView({
    seven_day: { utilization: 55 },
    five_hour: { utilization: 8 },
  });
  assert.equal(view.hasFiveHour, true);
  assert.equal(view.showDivider, true);
  assert.deepEqual(view.metricKeys, ['weekly', 'five-hour']);
});

test('model-specific windows become independent rows in weekly then five-hour order', () => {
  assert.deepEqual(buildCodexAdditionalLimitRows([{
    key: 'spark',
    label: 'GPT-5.3-Codex-Spark',
    five_hour: { utilization: 10, resets_at: '2030-01-01T01:00:00Z' },
    seven_day: { utilization: 6, resets_at: '2030-01-07T01:00:00Z' },
  }]).map((row) => [row.key, row.kind, row.usedPercent]), [
    ['spark:weekly', 'weekly', 6],
    ['spark:five-hour', 'five-hour', 10],
  ]);
});

test('reset inventory exposes only future items in expiry order', () => {
  const credits = visibleCodexResetCredits({ credits: [
    { title: 'Later', expires_at: '2030-08-12T18:11:58Z', id: 'secret-b' },
    { title: 'Expired', expires_at: '2020-01-01T00:00:00Z' },
    { title: 'Sooner', expires_at: '2030-07-31T19:10:31Z', description: 'not for UI' },
  ] }, Date.parse('2027-01-01T00:00:00Z'));
  assert.deepEqual(credits.map((credit) => credit.title), ['Sooner', 'Later']);
  assert.deepEqual(Object.keys(credits[0]).sort(), ['expires_at', 'title']);
});
