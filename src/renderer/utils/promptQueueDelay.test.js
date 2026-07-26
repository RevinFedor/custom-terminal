const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

test('Run after delay supports hours and keeps minute/second fields bounded', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'prompt-queue-delay-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, 'promptQueueDelay.cjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'promptQueueDelay.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });

  const delay = require(outfile);
  assert.ok(delay.MAX_FIRST_DELAY_SECONDS > 3600);
  assert.equal(delay.normalizeFirstDelaySeconds(7205.9), 7205);
  assert.equal(delay.normalizeFirstDelaySeconds(-1), 0);
  assert.equal(delay.combineFirstDelayParts(2, 3, 4), 7384);
  assert.equal(delay.combineFirstDelayParts(1, 90, 90), 7199);
  assert.deepEqual(delay.splitFirstDelaySeconds(90061), {
    hours: 25,
    minutes: 1,
    seconds: 1,
  });
  assert.equal(delay.formatFirstDelayCountdown(65), '1:05');
  assert.equal(delay.formatFirstDelayCountdown(3661), '1:01:01');
  assert.equal(delay.getFirstDelayRemainingSeconds(3600, 10_000, 10_999), 3600);
  assert.equal(delay.getFirstDelayRemainingSeconds(3600, 10_000, 11_000), 3599);
  assert.deepEqual(delay.splitFirstDelaySeconds(
    delay.getFirstDelayRemainingSeconds(3600, 10_000, 11_000),
  ), {
    hours: 0,
    minutes: 59,
    seconds: 59,
  });
  assert.equal(delay.getFirstDelayRemainingSeconds(3600, 10_000, 3_610_000), 0);
});
