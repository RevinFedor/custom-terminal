'use strict';

// Transactional metadata witnesses, not transcript contents or a second
// projector. Foreign SQLite writers and offline changes participate too.
function installHistoryFreshnessMetadata(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS history_freshness_versions (
    domain TEXT NOT NULL, provider TEXT NOT NULL, owner_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(domain, provider, owner_id)
  );`);
  const bump = (domain, provider, owner, from = '', where = '') => `
    INSERT INTO history_freshness_versions(domain,provider,owner_id,version)
    SELECT DISTINCT '${domain}', ${provider}, ${owner}, 1 ${from}
    WHERE ${owner} IS NOT NULL AND ${owner} != '' ${where ? 'AND ' + where : ''}
    ON CONFLICT(domain,provider,owner_id) DO UPDATE SET version=version+1;`;
  const timing = ref => bump('timing-session', `${ref}.tool_type`, `${ref}.session_id`)
    + bump('timing-tab', `${ref}.tool_type`, `${ref}.tab_id`)
    + bump('timing-session', 'a.tool_type', 'a.session_id', 'FROM history_response_timing_aliases a', `a.interval_id=${ref}.interval_id`);
  const alias = ref => bump('timing-session', `${ref}.tool_type`, `${ref}.session_id`)
    + bump('timing-tab', 't.tool_type', 't.tab_id', 'FROM history_response_timings t', `t.interval_id=${ref}.interval_id`);
  const topology = ref => ['session_id','source_session_id','child_session_id']
    .map(column => bump('topology', "'*'", `${ref}.${column}`)).join('');
  const links = ref => ['parent_session_id','child_session_id']
    .map(column => bump('topology', "'*'", `${ref}.${column}`)).join('');
  const duration = ref => bump('timing-session', 't.tool_type', 't.session_id', 'FROM history_response_timings t', `t.interval_id=${ref}.id`)
    + bump('timing-tab', 't.tool_type', 't.tab_id', 'FROM history_response_timings t', `t.interval_id=${ref}.id`)
    + bump('timing-session', 'a.tool_type', 'a.session_id', 'FROM history_response_timing_aliases a', `a.interval_id=${ref}.id`);
  for (const [table, body] of [['history_response_timings', timing], ['history_response_timing_aliases', alias],
    ['session_history_events', topology], ['session_links', links], ['agent_activity_intervals', duration]]) {
    const changed = db.prepare(`PRAGMA table_info(${table})`).all()
      .map(({ name }) => `OLD."${name}" IS NOT NEW."${name}"`).join(' OR ');
    for (const [action, refs] of [['INSERT', ['NEW']], ['UPDATE', ['OLD','NEW']], ['DELETE', ['OLD']]]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS freshness_${table}_${action.toLowerCase()}
        AFTER ${action} ON ${table} ${action === 'UPDATE' ? 'WHEN ' + changed : ''}
        BEGIN ${refs.map(body).join('')} END;`);
    }
  }
}

const readers = new WeakMap();
function statements(db) {
  let reader = readers.get(db);
  if (!reader) {
    reader = {
      version: db.prepare('SELECT version FROM history_freshness_versions WHERE domain=? AND provider=? AND owner_id=?'),
      prompt: db.prepare('SELECT version FROM history_prompt_revision_versions WHERE tool_type=?'),
    };
    readers.set(db, reader);
  }
  return reader;
}

function readHistoryTimingFreshnessVersion(db, toolType, sessionId, tabId) {
  const read = statements(db).version;
  return [sessionId ? Number(read.get('timing-session', toolType, sessionId)?.version || 0) : 0,
    tabId ? Number(read.get('timing-tab', toolType, tabId)?.version || 0) : 0];
}

function readHistoryFreshnessMetadata(db, { toolType, sessionId, tabId, sourceSessionIds = [] }) {
  const ids = [...new Set([sessionId, ...sourceSessionIds].filter(Boolean))].sort();
  if (ids.length > 16) throw new Error('history_freshness_source_limit');
  const reader = statements(db);
  const version = (domain, provider, owner) => !owner ? 0 : Number(reader.version.get(domain, provider, owner)?.version || 0);
  return {
    prompt: Number(reader.prompt.get(toolType)?.version || 0),
    timing: [version('timing-session', toolType, sessionId), version('timing-tab', toolType, tabId)],
    topology: ids.map(id => [id, version('topology', '*', id)]),
  };
}

module.exports = { installHistoryFreshnessMetadata, readHistoryFreshnessMetadata, readHistoryTimingFreshnessVersion };
