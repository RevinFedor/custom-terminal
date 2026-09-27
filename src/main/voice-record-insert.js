const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

async function insertTabIdsInVoiceRecord(tabIds, {
  timestamp, directory = path.join(os.homedir(), '.noted-terminal'), fetchImpl = fetch,
} = {}) {
  if (!Array.isArray(tabIds) || !tabIds.length || tabIds.length > 100
    || tabIds.some(id => typeof id !== 'string' || !/^(?:[A-Za-z0-9_+=/\-]+-)?tab-[0-9]+$/.test(id))) {
    return { ok: false, error: 'Некорректный ID вкладки' };
  }
  try {
    const token = fs.readFileSync(path.join(directory, 'web-token.txt'), 'utf8').trim();
    const rows = fs.readdirSync(directory).filter(name => /^voice-web-server-\d+\.json$/.test(name))
      .flatMap(name => { try { return [JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))]; } catch { return []; } })
      .filter(row => Number.isInteger(row.port) && row.port > 0 && row.port < 65536 && Number.isInteger(row.pid))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const visitedPorts = new Set();
    let outdated = false;
    for (const row of rows) {
      if (visitedPorts.has(row.port)) continue;
      visitedPorts.add(row.port);
      const base = 'http://127.0.0.1:' + row.port;
      let info;
      try {
        const res = await fetchImpl(base + '/api/me', { headers, signal: AbortSignal.timeout(1200) });
        if (res.ok) info = await res.json();
      } catch { continue; }
      if (!info?.ok) continue;
      // An alive/reused PID or discovery file is not process identity. The
      // authenticated running server proves it; POST is pinned to that PID.
      if (info.application !== 'voice-record' || !rows.some(candidate => candidate.port === row.port && candidate.pid === info.pid)) continue;
      if (!(info.capabilities?.recordingInsert?.version >= 2)) { outdated = true; continue; }
      const res = await fetchImpl(base + '/api/desktop/recording/insert-tab-ids', {
        method: 'POST', headers, body: JSON.stringify({ tabIds, targetPid: info.pid,
          ...(timestamp == null ? {} : { timestamp }), expiresAt: Date.now() + 20000 }),
        signal: AbortSignal.timeout(21000),
      });
      const result = await res.json().catch(() => null);
      if (!res.ok || !result?.ok) return { ok: false, error: result?.error || 'Voice Record не подтвердил вставку ID' };
      console.log('[VoiceRecord:InsertId] accepted count=' + tabIds.length + ' pid=' + info.pid);
      return { ok: true };
    }
    return { ok: false, error: outdated ? 'Обновите Voice Record для вставки ID в запись' : 'Voice Record не запущен' };
  } catch (error) {
    return { ok: false, error: error?.name === 'TimeoutError'
      ? 'Voice Record не подтвердил вставку. Проверьте окно записи перед повтором.'
      : 'Не удалось вставить ID в Voice Record: ' + String(error?.message || error) };
  }
}
module.exports = { insertTabIdsInVoiceRecord };
