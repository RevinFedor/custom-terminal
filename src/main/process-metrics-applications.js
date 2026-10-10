'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { describeAgent, describeCommand, describeTool } = require('./process-metrics-grouping');

function bundleOf(item) {
  return (item.execPath || '').match(/^(.*?\.app)(?:\/|$)/)?.[1] || null;
}

function processLabel(item) {
  const source = item.commandLine || '';
  if (/Helper \(Renderer\)/.test(item.name) || /--type=renderer\b/.test(source)) return 'Отрисовка';
  if (/Helper \(GPU\)/.test(item.name) || /--type=gpu-process\b/.test(source)) return 'Графика';
  if (/network\.mojom\.NetworkService/.test(source)) return 'Сеть';
  const agent = describeAgent(item);
  if (agent) return agent;
  if (/mcp[-/_.]|[-_]mcp\b|mcp-server|knowledge-server|terminal-server/.test(source)) return 'MCP · ' + describeTool(item);
  if (/Helper/.test(item.name)) return 'Вспомогательные';
  return describeCommand(item) || item.name || 'Процесс';
}

/** One existing native snapshot; every available PID contributes exactly once. */
function groupApplications({ snapshot, cpuByPid = null } = {}) {
  const started = performance.now();
  const byPid = new Map((snapshot?.processes || []).map(p => [p.pid, p]));
  const owners = new Map();
  function owner(pid) {
    if (owners.has(pid)) return owners.get(pid);
    const trail = [], seen = new Set();
    let current = byPid.get(pid), inherited = null;
    while (current && !seen.has(current.pid)) {
      if (owners.has(current.pid)) { inherited = owners.get(current.pid); break; }
      seen.add(current.pid); trail.push(current);
      current = byPid.get(current.ppid);
    }
    // A cycle provides no ancestry proof: keep its members in the unknown group.
    if (current && seen.has(current.pid)) {
      for (const p of trail) owners.set(p.pid, null);
      return null;
    }
    for (let i = trail.length - 1; i >= 0; i--) {
      inherited = inherited || bundleOf(trail[i]);
      owners.set(trail[i].pid, inherited);
    }
    return owners.get(pid) || null;
  }
  const groups = new Map();
  for (const item of byPid.values()) {
    const bundle = owner(item.pid), id = bundle || 'unassigned';
    if (!groups.has(id)) groups.set(id, {
      id, label: bundle ? path.basename(bundle, '.app') : 'Другие процессы пользователя',
      path: bundle, bytes: 0, cpu: null, processCount: 0, rows: new Map(),
    });
    const group = groups.get(id);
    const bytes = Number.isFinite(item.footprintBytes) ? Math.max(0, item.footprintBytes) : 0;
    const cpu = cpuByPid?.get(item.pid);
    group.bytes += bytes; group.processCount++;
    if (typeof cpu === 'number') group.cpu = (group.cpu || 0) + cpu;
    const label = processLabel(item);
    if (!group.rows.has(label)) group.rows.set(label, { label, bytes: 0, cpu: null, count: 0 });
    const row = group.rows.get(label);
    row.bytes += bytes; row.count++;
    if (typeof cpu === 'number') row.cpu = (row.cpu || 0) + cpu;
  }
  const apps = [...groups.values()].map(g => ({ ...g, rows: [...g.rows.values()].sort((a,b) => b.bytes - a.bytes) }))
    .sort((a,b) => b.bytes - a.bytes || a.label.localeCompare(b.label));
  return {
    available: true, scope: 'current-user', metric: 'physical-footprint',
    scannedAt: snapshot?.scannedAt || null, hasCpu: cpuByPid !== null,
    totalBytes: apps.reduce((n,g) => n + g.bytes, 0),
    totalCpu: cpuByPid && apps.some(g => g.cpu !== null) ? apps.reduce((n,g) => n + (g.cpu || 0), 0) : null,
    processCount: byPid.size, skipped: snapshot?.skipped || 0, apps,
    durationMs: performance.now() - started,
  };
}

module.exports = { groupApplications };
