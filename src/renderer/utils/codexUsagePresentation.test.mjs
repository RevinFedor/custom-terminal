import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexAdditionalLimitRows,
  buildCodexMainUsageView,
  visibleCodexResetCredits,
  codexCreditExpirySummary,
} from './codexUsagePresentation.mjs';

test('credit expiry describes the full balance only when every credit has that date', () => {
  const now = Date.parse('2026-09-30T00:00:00Z');
  const snapshot = { balance: 62500, fetchedAt: new Date(now).toISOString(),
    expirations: [{ amount: 62500, expiresAt: '2027-01-01T00:00:00Z' }] };
  assert.equal(codexCreditExpirySummary({ balance: 62500 }, snapshot, now).allCredits, true);
  const mixed = { ...snapshot, expirations: [{ amount: 10000, expiresAt: '2026-12-01T00:00:00Z' }, ...snapshot.expirations] };
  const partial = codexCreditExpirySummary({ balance: 62500 }, mixed, now);
  assert.equal(partial.allCredits, false);
  assert.equal(partial.amount, 10000);
});

test('a date cannot be borrowed from a different balance, an old snapshot, or an expired package', () => {
  const now = Date.parse('2026-09-30T00:00:00Z');
  const snapshot = { balance: 62500, fetchedAt: new Date(now).toISOString(),
    expirations: [{ amount: 62500, expiresAt: '2027-01-01T00:00:00Z' }] };
  assert.equal(codexCreditExpirySummary({ balance: 60000 }, snapshot, now), null);
  assert.equal(codexCreditExpirySummary({ balance: 62500 }, snapshot, now + 400000), null);
  assert.equal(codexCreditExpirySummary({ balance: 62500, unlimited: true }, snapshot, now), null);
  assert.equal(codexCreditExpirySummary({ balance: 62500 }, { ...snapshot,
    expirations: [{ amount: 62500, expiresAt: '2026-09-29T00:00:00Z' }] }, now), null);
});

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
