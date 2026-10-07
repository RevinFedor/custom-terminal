'use strict';

// Organization metadata only. No legacy project/tab writer, terminal or input
// dependency. Construct before migration; seedLegacy runs in its caller's
// activation transaction on the SAME better-sqlite3 connection.
const crypto = require('node:crypto');
const VERSION = 1;
const copy = value => JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, statusCode: 409, ...details }); };
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const json = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(json(value)).digest('hex');
const requireId = value => { if (!validId(value)) fail('workflow_group_id_required'); return value; };
const sync = value => { if (value?.then) fail('workflow_group_sync_required'); return value; };
const legacyGroupId = (namespace, groupId) => 'wg1:' + hash([requireId(namespace), requireId(groupId)]);

class WorkflowGroups {
  constructor({ database, resolveTab, publish = () => {} }) {
    this.db = database?.db || database;
    if (!this.db?.prepare || !this.db?.transaction) fail('workflow_group_database_required');
    this.resolveTab = resolveTab || (tabId => {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_org_tabs' AND type='table'").get();
      return exists ? this.db.prepare('SELECT tab_id FROM workflow_org_tabs WHERE tab_id=?').get(tabId) : null;
    });
    this.publish = publish;
    this.init();
  }
  init() {
    if (this.db.inTransaction) fail('workflow_group_init_outside_activation_required');
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_group_meta' AND type='table'").get();
    if (exists) {
      const meta = this.meta();
      if (meta.version !== VERSION) return; // never initialize/repair a future store
    }
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_group_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
          revision INTEGER NOT NULL, seed_hash TEXT, seed_generation INTEGER,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS workflow_global_groups (
          group_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_group_aliases (
          legacy_namespace TEXT NOT NULL, legacy_group_id TEXT NOT NULL,
          group_id TEXT NOT NULL REFERENCES workflow_global_groups(group_id) ON DELETE RESTRICT,
          provenance_json TEXT NOT NULL, PRIMARY KEY(legacy_namespace,legacy_group_id)
        );
        CREATE TABLE IF NOT EXISTS workflow_group_memberships (
          tab_id TEXT PRIMARY KEY, group_id TEXT REFERENCES workflow_global_groups(group_id) ON DELETE RESTRICT,
          revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_group_contexts (
          legacy_namespace TEXT NOT NULL, tab_id TEXT NOT NULL, context_key TEXT NOT NULL,
          group_id TEXT NOT NULL REFERENCES workflow_global_groups(group_id) ON DELETE RESTRICT,
          archived INTEGER NOT NULL, record_json TEXT NOT NULL,
          PRIMARY KEY(legacy_namespace,tab_id,context_key)
        );
        CREATE TABLE IF NOT EXISTS workflow_group_mutations (
          mutation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL
        );
      `);
      this.db.prepare('INSERT OR IGNORE INTO workflow_group_meta(singleton,version,revision) VALUES(1,?,0)').run(VERSION);
    }).immediate();
  }
  meta() {
    const row = this.db.prepare('SELECT * FROM workflow_group_meta WHERE singleton=1').get();
    if (!row) fail('workflow_group_publication_missing');
    return { version: row.version, revision: row.revision, seedHash: row.seed_hash,
      seedGeneration: row.seed_generation, metadata: JSON.parse(row.metadata_json) };
  }
  writable() { if (this.meta().version !== VERSION) fail('workflow_group_version_unsupported'); }
  read() {
    const read = () => {
      const meta = this.meta();
      const groups = this.db.prepare('SELECT * FROM workflow_global_groups WHERE deleted=0 ORDER BY group_id').all()
        .map(row => ({ ...JSON.parse(row.metadata_json), id: row.group_id, revision: row.revision }));
      groups.sort((a, b) => (a.globalOrder ?? a.order ?? Infinity) - (b.globalOrder ?? b.order ?? Infinity) || a.id.localeCompare(b.id));
      const tabGroups = Object.fromEntries(this.db.prepare('SELECT tab_id,group_id FROM workflow_group_memberships WHERE group_id IS NOT NULL ORDER BY tab_id').all()
        .map(row => [row.tab_id, row.group_id]));
      const membershipRevisions = Object.fromEntries(this.db.prepare('SELECT tab_id,revision FROM workflow_group_memberships ORDER BY tab_id').all()
        .map(row => [row.tab_id, row.revision]));
      // Read publication never drags whole legacy tab/archival records into
      // renderer state. Their complete provenance remains addressable below.
      const contexts = this.db.prepare('SELECT legacy_namespace,tab_id,context_key,group_id,archived FROM workflow_group_contexts ORDER BY legacy_namespace,tab_id,context_key').all()
        .map(row => ({ namespace: row.legacy_namespace, tabId: row.tab_id, contextKey: row.context_key,
          groupId: row.group_id, archived: !!row.archived }));
      return { ...meta, groups, tabGroups, membershipRevisions, contexts };
    };
    return this.db.inTransaction ? read() : this.db.transaction(read)();
  }
  group(groupId) {
    const row = this.db.prepare('SELECT * FROM workflow_global_groups WHERE group_id=? AND deleted=0').get(requireId(groupId));
    if (!row) fail('workflow_group_missing');
    return { ...JSON.parse(row.metadata_json), id: row.group_id, revision: row.revision };
  }
  resolveLegacy(namespace, groupId) {
    const row = this.db.prepare(`SELECT a.group_id FROM workflow_group_aliases a JOIN workflow_global_groups g
      ON g.group_id=a.group_id WHERE a.legacy_namespace=? AND a.legacy_group_id=? AND g.deleted=0`)
      .get(requireId(namespace), requireId(groupId));
    return row?.group_id || null;
  }
  legacyContext(namespace, tabId, contextKey) {
    const row = this.db.prepare('SELECT * FROM workflow_group_contexts WHERE legacy_namespace=? AND tab_id=? AND context_key=?')
      .get(requireId(namespace), requireId(tabId), requireId(contextKey));
    return row ? { namespace, tabId, contextKey, groupId: row.group_id, archived: !!row.archived, record: JSON.parse(row.record_json) } : null;
  }
  assertAlias(request, groupId) {
    if (request.legacyNamespace === undefined && request.legacyGroupId === undefined) return;
    if (this.resolveLegacy(request.legacyNamespace, request.legacyGroupId) !== groupId) fail('workflow_group_alias_mismatch');
  }
  // Parent: activateArtifacts(plan,generation) => groups.seedLegacy(plan,{generation}).
  // No nested commit/publication: exceptions roll back organization + groups.
  seedLegacy(plan, { generation } = {}) {
    if (!this.db.inTransaction) fail('workflow_group_activation_transaction_required');
    this.writable();
    if (plan?.version !== VERSION || !Number.isSafeInteger(generation) || generation < 1) fail('workflow_group_seed_invalid');
    const tables = plan.artifacts?.legacy?.tables;
    if (!object(tables)) fail('workflow_group_seed_source_required');
    const source = { projects: tables.projects || [], tabs: tables.tabs || [], tab_history: tables.tab_history || [] };
    const seedHash = hash(source), meta = this.meta();
    if (meta.seedHash) {
      if (meta.seedHash !== seedHash || meta.seedGeneration !== generation) fail('workflow_group_seed_conflict');
      return this.read(); // never undo moves/renames after activation
    }
    if (meta.revision !== 0) fail('workflow_group_seed_nonempty');
    let globalOrder = 0;
    const define = (namespace, originalId, metadata, provenance) => {
      const groupId = legacyGroupId(namespace, originalId);
      if (this.db.prepare('SELECT 1 FROM workflow_global_groups WHERE group_id=?').get(groupId)) fail('workflow_group_duplicate_legacy_definition');
      this.db.prepare('INSERT INTO workflow_global_groups(group_id,revision,metadata_json) VALUES(?,1,?)').run(groupId,
        json({ ...metadata, id: groupId, globalOrder: globalOrder++, legacyNamespace: namespace, legacyGroupId: originalId }));
      this.db.prepare('INSERT INTO workflow_group_aliases VALUES(?,?,?,?)').run(namespace, originalId, groupId, json(provenance));
      return groupId;
    };
    for (const project of [...source.projects].sort((a,b) => String(a.id).localeCompare(String(b.id)))) {
      if (!project.tab_groups) continue;
      let groups;
      try { groups = typeof project.tab_groups === 'string' ? JSON.parse(project.tab_groups) : copy(project.tab_groups); }
      catch { fail('workflow_group_legacy_json_invalid'); }
      if (!Array.isArray(groups)) fail('workflow_group_legacy_json_invalid');
      groups.forEach((group, index) => {
        if (!object(group)) fail('workflow_group_legacy_definition_invalid');
        define(project.id, group.id, group, { original: group, index, namespace: project.id });
      });
    }
    const candidates = new Map();
    for (const [table, archived] of [['tabs', false], ['tab_history', true]]) {
      for (const record of source[table]) {
        const originalId = table === 'tabs' ? record.tab_group_id : record.group_id;
        const isArchived = archived || record.execution_archived === 1;
        if (originalId == null || originalId === '') {
          // An active ungrouped tab wins over its older archived group too.
          if (!isArchived && validId(record.tab_id)) {
            const entries = candidates.get(record.tab_id) || [];
            entries.push({ groupId: null, archived: false }); candidates.set(record.tab_id, entries);
          }
          continue;
        }
        const namespace = record.project_id || record.execution_namespace;
        let groupId = this.resolveLegacy(namespace, originalId);
        if (!groupId) groupId = define(namespace, originalId, { name: originalId, missingLegacyDefinition: true }, { missingDefinition: true });
        // Archives created before opaque tab IDs stay in provenance, addressed
        // by their exact storage PK. They are never synthesized into live tabs.
        const tabId = record.tab_id || 'legacy-archive:' + json([namespace, record.id]);
        if (!validId(tabId)) fail('workflow_group_legacy_tab_invalid');
        if (record.id == null) fail('workflow_group_legacy_storage_id_required');
        const contextKey = table + ':' + requireId(String(record.id));
        this.db.prepare('INSERT INTO workflow_group_contexts VALUES(?,?,?,?,?,?)')
          .run(namespace, tabId, contextKey, groupId, isArchived ? 1 : 0, json(record));
        if (!record.tab_id) continue;
        const entries = candidates.get(tabId) || [];
        entries.push({ groupId, archived: isArchived }); candidates.set(tabId, entries);
      }
    }
    for (const [tabId, entries] of candidates) {
      const active = entries.filter(entry => !entry.archived);
      const ids = [...new Set((active.length ? active : entries).map(entry => entry.groupId))];
      if (active.length && ids.length !== 1) fail('workflow_group_active_membership_conflict', { tabId });
      // Multiple historical groups for one archived ID remain exact contexts;
      // do not pick an arbitrary archive as present-day membership.
      if (ids.length === 1) this.db.prepare('INSERT INTO workflow_group_memberships VALUES(?,?,1)').run(tabId, ids[0]);
    }
    this.db.prepare('UPDATE workflow_group_meta SET revision=1,seed_hash=?,seed_generation=? WHERE singleton=1').run(seedHash, generation);
    return this.read();
  }
  mutate(kind, request) {
    if (!object(request) || request.version !== VERSION) fail('workflow_group_request_version_required');
    requireId(request.mutationId);
    if (this.db.inTransaction) fail('workflow_group_transaction_owner_required');
    const requestHash = hash({ kind, request });
    let replay = false;
    const result = this.db.transaction(() => {
      this.writable();
      const old = this.db.prepare('SELECT * FROM workflow_group_mutations WHERE mutation_id=?').get(request.mutationId);
      if (old) {
        if (old.request_hash !== requestHash) fail('workflow_group_mutation_id_conflict');
        replay = true; return JSON.parse(old.response_json);
      }
      const meta = this.meta();
      if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== meta.revision) fail('workflow_group_revision_changed', { currentRevision: meta.revision });
      let groupId = request.groupId;
      if (kind === 'create') {
        if (!object(request.metadata) || typeof request.metadata.name !== 'string' || !request.metadata.name.trim()) fail('workflow_group_name_required');
        groupId = 'wg2:' + hash(request.mutationId);
        const max = this.read().groups.reduce((n,g) => Math.max(n, Number.isFinite(g.globalOrder) ? g.globalOrder : 0), -1);
        const metadata = { ...request.metadata, id: groupId, name: request.metadata.name.trim(), globalOrder: max + 1 };
        if (metadata.version !== undefined && metadata.version !== VERSION) fail('workflow_group_metadata_version_unsupported');
        delete metadata.legacyNamespace; delete metadata.legacyGroupId;
        this.db.prepare('INSERT INTO workflow_global_groups(group_id,revision,metadata_json) VALUES(?,1,?)').run(groupId, json(metadata));
      } else if (kind === 'assign') {
        if (groupId !== null) {
          const target = this.group(groupId); this.assertAlias(request, groupId);
          if (target.version !== undefined && target.version !== VERSION) fail('workflow_group_metadata_version_unsupported');
        } else if (request.legacyNamespace !== undefined || request.legacyGroupId !== undefined) fail('workflow_group_alias_mismatch');
        if (!Array.isArray(request.tabIds) || request.tabIds.length === 0 || new Set(request.tabIds).size !== request.tabIds.length
          || !object(request.expectedTabGroups)) fail('workflow_group_assignment_invalid');
        if (Object.keys(request.expectedTabGroups).length !== request.tabIds.length) fail('workflow_group_previous_membership_required');
        for (const tabId of request.tabIds) {
          requireId(tabId);
          if (!sync(this.resolveTab(tabId))) fail('workflow_group_tab_missing', { tabId });
          const current = this.db.prepare('SELECT group_id FROM workflow_group_memberships WHERE tab_id=?').get(tabId)?.group_id ?? null;
          if (!Object.hasOwn(request.expectedTabGroups, tabId) || request.expectedTabGroups[tabId] !== current) fail('workflow_group_membership_changed', { tabId });
        }
        for (const tabId of request.tabIds) this.db.prepare(`INSERT INTO workflow_group_memberships VALUES(?,?,1)
          ON CONFLICT(tab_id) DO UPDATE SET group_id=excluded.group_id,revision=workflow_group_memberships.revision+1`).run(tabId, groupId);
      } else {
        const group = this.group(groupId);
        this.assertAlias(request, groupId);
        if (group.version !== undefined && group.version !== VERSION) fail('workflow_group_metadata_version_unsupported');
        if (request.expectedGroupRevision !== group.revision) fail('workflow_group_definition_changed');
        if (kind === 'delete') {
          this.db.prepare('UPDATE workflow_global_groups SET deleted=1,revision=revision+1 WHERE group_id=?').run(groupId);
          this.db.prepare('UPDATE workflow_group_memberships SET group_id=NULL,revision=revision+1 WHERE group_id=?').run(groupId);
        } else {
          let patch;
          switch (kind) {
            case 'rename':
              if (typeof request.name !== 'string' || !request.name.trim()) fail('workflow_group_name_required');
              patch = { name: request.name.trim() }; break;
            case 'color':
              if (request.color !== null && (!validId(request.color) || request.color.length > 128)) fail('workflow_group_color_invalid');
              patch = { color: request.color }; break;
            case 'status':
              if (request.status !== null && (!validId(request.status) || request.status.length > 128)) fail('workflow_group_status_invalid');
              patch = { sessionStatus: request.status }; break;
            case 'collapse':
              if (typeof request.collapsed !== 'boolean') fail('workflow_group_collapse_invalid');
              patch = { collapsed: request.collapsed }; break;
            default: fail('workflow_group_mutation_invalid');
          }
          this.db.prepare('UPDATE workflow_global_groups SET metadata_json=?,revision=revision+1 WHERE group_id=?')
            .run(json({ ...group, ...patch }), groupId);
        }
      }
      this.db.prepare('UPDATE workflow_group_meta SET revision=revision+1 WHERE singleton=1').run();
      const response = { success: true, mutationId: request.mutationId, groupId, ...this.read() };
      this.db.prepare('INSERT INTO workflow_group_mutations VALUES(?,?,?)').run(request.mutationId, requestHash, json(response));
      return response;
    }).immediate();
    if (!replay) { try { this.publish(copy(result)); } catch { /* committed; recover by read or exact retry */ } }
    return result;
  }
}

module.exports = { WorkflowGroups, legacyGroupId, WORKFLOW_GROUP_VERSION: VERSION };
