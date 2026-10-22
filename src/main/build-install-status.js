'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function findVoiceInstallOwner({ directory = path.join(os.homedir(), '.noted-terminal'),
  fetchImpl = fetch, headers, processCommand = async pid => (await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 1000 })).stdout.trim() } = {}) {
  const files = await fs.promises.readdir(directory), owners = [];
  for (const name of files.filter(file => /^voice-web-server-\d+\.json$/.test(file))) {
    let row;
    try { row = JSON.parse(await fs.promises.readFile(path.join(directory, name), 'utf8')); } catch { continue; }
    if (!Number.isInteger(row.pid) || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535) continue;
    try { process.kill(row.pid, 0); } catch { continue; }
    let command;
    try { command = await processCommand(row.pid); } catch { continue; }
    const executable = '/Applications/Voice Record.app/Contents/MacOS/Voice Record';
    if (command !== executable && !command.startsWith(executable + ' ')) continue;
    const baseUrl = 'http://127.0.0.1:' + row.port;
    try {
      const response = await fetchImpl(baseUrl + '/api/me', { headers, signal: AbortSignal.timeout(1500) });
      const info = await response.json();
      if (response.ok && info.application === 'voice-record' && info.pid === row.pid
        && info.capabilities?.terminalBuildInstall?.durableRequests === true) owners.push({ ...row, baseUrl });
    } catch {}
  }
  const unique = [...new Map(owners.map(owner => [owner.pid + ':' + owner.port, owner])).values()];
  if (unique.length !== 1) throw Error('Voice Record installer owner unavailable or ambiguous');
  return unique[0];
}

function createBuildInstallStatus({ token, read = () => null, write = () => {}, changed = () => {},
  selectOwner = findVoiceInstallOwner, fetchImpl = fetch, retryMs = 1500 }) {
  const cache = read();
  const jobs = new Map((cache?.version === 1 && Array.isArray(cache.jobs) ? cache.jobs : []).map(job => [job.id, job]));
  let running = false, connected = false, error = null, owner = null, controller = null, retry = null, generation = 0;
  const epoch = randomUUID(); let publication = 0;
  const headers = () => ({ Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' });
  const snapshot = tabId => ({ version: 1, epoch, publication, known: connected, stale: !connected, error,
    jobs: [...jobs.values()].filter(job => job.returnTo?.tabId === tabId).sort((a, b) => b.startedAt - a.startedAt) });
  const publish = () => changed({ version: 1, epoch, publication: ++publication, known: connected, stale: !connected, error, jobs: [...jobs.values()] });
  const apply = job => {
    if (!job?.id || !job.requestId || !job.returnTo?.tabId) return;
    const previous = jobs.get(job.id);
    if (previous && Number(previous.revision) > Number(job.revision)) return;
    // Source/operation binding cannot be changed by a late status packet.
    if (previous && (previous.requestId !== job.requestId || previous.returnTo.tabId !== job.returnTo.tabId
      || previous.returnTo.sessionId !== job.returnTo.sessionId)) throw Error('installer status source changed');
    const { logTail, ...bounded } = job;
    jobs.set(job.id, bounded);
    const retained = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    for (const row of retained.slice(40)) if (!row.running && !['pending', 'waiting', 'sending', 'confirming', 'sent_unverified'].includes(row.callback?.status)) jobs.delete(row.id);
    try { write({ version: 1, jobs: [...jobs.values()] }); }
    catch (e) { error = 'status cache: ' + e.message; }
    publish();
  };
  const connect = async () => {
    const epoch = ++generation;
    controller?.abort(); controller = new AbortController();
    try {
      owner = await selectOwner({ fetchImpl, headers: headers() });
      if (!running || epoch !== generation) return;
      const response = await fetchImpl(owner.baseUrl + '/api/terminal/build-install', { headers: headers(), signal: controller.signal });
      if (!response.ok) throw Error('installer status HTTP ' + response.status);
      const body = await response.json();
      if (!running || epoch !== generation) return;
      connected = true; error = null; if (body.job) apply(body.job); else publish();
      const stream = await fetchImpl(owner.baseUrl + '/api/events', { headers: headers(), signal: controller.signal });
      if (!stream.ok || !stream.body) throw Error('installer events unavailable');
      let buffer = ''; const decoder = new TextDecoder();
      for await (const chunk of stream.body) {
        if (!running || epoch !== generation) return;
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, index).replace(/\r/g, ''); buffer = buffer.slice(index + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) { const value = JSON.parse(data); if (value.type === 'terminal-build-install') apply(value.job); }
        }
        if (buffer.length > 512000) throw Error('installer event exceeds bounded status limit');
      }
      throw Error('installer event connection ended');
    } catch (e) {
      if (!running || epoch !== generation) return;
      connected = false; error = String(e.message); publish();
      retry = setTimeout(() => { retry = null; if (running) void connect(); }, retryMs);
      retry.unref?.();
    }
  };
  return { snapshot, apply,
    start() { if (!running) { running = true; void connect(); } },
    stop() { running = false; generation++; controller?.abort(); clearTimeout(retry); retry = null; },
    async cancel({ tabId, requestId, id }) {
      const job = jobs.get(id);
      if (!connected || !owner || !job || job.requestId !== requestId || job.returnTo?.tabId !== tabId) throw Error('installer cancel owner unproven');
      const response = await fetchImpl(owner.baseUrl + '/api/terminal/build-install/cancel', { method: 'POST', headers: headers(),
        body: JSON.stringify({ requestId, id, reason: 'cancelled from Noted task dock' }), signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'installer cancel not confirmed');
      if (result.job) apply(result.job); return result;
    },
  };
}

module.exports = { createBuildInstallStatus, findVoiceInstallOwner };
