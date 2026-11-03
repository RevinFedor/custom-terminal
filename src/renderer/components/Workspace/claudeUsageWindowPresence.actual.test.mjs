import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCodexMainUsageView } from '../../utils/codexUsagePresentation.mjs';

// Anthropic removed the 5-hour window from this plan and the statusline source
// answers it as unknown. The chip rendered a trailing "/ —" and the popover an
// empty "5-hour left" bar. Both halves now share one presence model.
const source = fs.readFileSync(new URL('./ClaudeUsageButton.tsx', import.meta.url), 'utf8');

test('the Claude half derives window presence from the shared view', () => {
  const chip = source.slice(source.indexOf('function ClaudeUsageChip('), source.indexOf('function CodexUsageChip('));
  assert.match(chip, /const detailUsageView = buildCodexMainUsageView\(detailData\)/);
  assert.match(chip, /const compactUsageView = buildCodexMainUsageView\(compactData\)/);
  // The regression: reading utilization straight off the payload treats a
  // missing window as a value and renders a dash for it.
  assert.doesNotMatch(chip, /const fiveHourUsedPct = detailData\?\.five_hour/);
  assert.doesNotMatch(chip, /const compactFiveHourUsedPct = compactData\?\.five_hour/);
});

test('an absent 5-hour window renders neither the popover row nor the chip tail', () => {
  const chip = source.slice(source.indexOf('function ClaudeUsageChip('), source.indexOf('function CodexUsageChip('));
  assert.match(chip, /\{hasFiveHourWindow && \(\s*<ProgressRow/, 'popover row is conditional');
  assert.match(chip, /\{hasWeeklyWindow && \(\s*<ProgressRow/, 'weekly row is conditional too');
  assert.match(chip, /\{compactHasFiveHour && \(/, 'chip divider+value are conditional');
  // The dash fallback for the compact value is gone: an absent window is not a value.
  assert.doesNotMatch(chip, /compactFiveHourUsedPct != null \? compactFiveHourColor : '#6b7280'/);
});

test('spoken and hover text omit a window the provider did not return', () => {
  const chip = source.slice(source.indexOf('function ClaudeUsageChip('), source.indexOf('function CodexUsageChip('));
  assert.match(chip, /claudeAriaMetrics/, 'aria label is built from present windows');
  assert.match(chip, /claudeTitleMetrics/, 'hover title is built from present windows');
  assert.match(chip, /compactHasWeekly && resetShort/, 'weekly reset hint follows its window');
  assert.match(chip, /compactHasFiveHour && fiveHourResetShort/, '5-hour reset hint follows its window');
});

test('presence model: the live payload shape from this plan', () => {
  // Exactly what /api/agent-usage returned: weekly known, five-hour unknown.
  const live = buildCodexMainUsageView({ seven_day: { utilization: 63 }, five_hour: null });
  assert.equal(live.hasWeekly, true);
  assert.equal(live.hasFiveHour, false);
  assert.equal(live.showDivider, false, 'no divider means no "/ —" tail');

  const both = buildCodexMainUsageView({ seven_day: { utilization: 63 }, five_hour: { utilization: 54 } });
  assert.equal(both.hasFiveHour, true, 'a real window comes back on its own');
  assert.equal(both.showDivider, true);

  const empty = buildCodexMainUsageView({ seven_day: null, five_hour: null });
  assert.deepEqual(empty.metricKeys, [], 'nothing known renders no metrics');
});
