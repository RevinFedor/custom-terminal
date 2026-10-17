#!/usr/bin/env node
// Application API only. Default is a dry-run; never opens a live SQLite file.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const option = key => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
const base = new URL(option('--base') || 'http://127.0.0.1:7878');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Local Application API required; refusing to send credentials elsewhere');
const token = (await fs.readFile(option('--token-file') || path.join(os.homedir(), '.noted-terminal', 'web-token.txt'), 'utf8')).trim();
const request = async (route, body) => {
  const response = await fetch(new URL(route, base), { headers: { Authorization: 'Bearer ' + token,
    ...(body ? { 'Content-Type': 'application/json' } : {}) }, method: body ? 'POST' : 'GET',
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'storage_api_request_failed');
  return value;
};
const me = await request('/api/me');
if (me.capabilities?.storageMaintenance?.version !== 1) {
  console.error('storage_app_update_required: running Noted has no safe closed-History maintenance API. No deletion or database access performed.');
  process.exitCode = 2;
} else {
  const operationId = option('--operation-id');
  let result;
  if (args.includes('--receipt')) {
    if (!operationId) throw new Error('--operation-id required');
    result = await request('/api/storage/cleanup/' + encodeURIComponent(operationId));
  } else if (args.includes('--apply')) {
    if (!operationId) throw new Error('Choose --operation-id before apply; recover unknown delivery with --receipt, never another blind apply');
    console.log('operationId=' + operationId);
    result = await request('/api/storage/cleanup', { operationId, maxItems: Number(option('--max-items')) || 250 });
  } else {
    result = { dryRun: true, instance: me.service, database: await request('/api/storage/database-space'),
      plan: await request('/api/storage/plan?maxItems=' + (Number(option('--max-items')) || 250)) };
  }
  const output = JSON.stringify(result, null, 2);
  console.log(output);
  if (option('--output')) {
    try { await fs.writeFile(option('--output'), output + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      console.error('Result printed above; report-file save failed: ' + error.code + '. Do not repeat an applied cleanup; use its receipt.');
      process.exitCode = 1;
    }
  }
}
