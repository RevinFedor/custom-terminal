'use strict';

const crypto = require('node:crypto');
const {
  ORGANIZATION_VERSION, EXECUTION_SUBJECT_VERSION, INBOX_WORKFLOW_ID,
  clone, fail, id, stableJson, supported, supportedLayout, mergeLayout, layoutReferences, removeLayoutTabs, planMigration,
  GLOBAL_EXECUTION_NAMESPACE, executionScopeForRow,
} = require('../shared/workflow-organization.cjs');

const LEGACY_TABLES = Object.freeze(['projects', 'tabs', 'tab_history', 'favorites',
  'ai_sessions', 'gemini_history', 'project_prompt_sources', 'quick_actions', 'app_state', 'workflow_execution_scopes']);
const fingerprint = value => crypto.createHash('sha256').update(stableJson(value)).digest('hex');
const parse = raw => JSON.parse(raw);
const requireId = value => { if (!id(value)) fail('workflow_id_required'); return value; };
const syncValue = value => { if (value?.then) fail('workflow_synchronous_capture_required'); return value; };

/**
 * Main-owned organization storage. Accepts an actual DatabaseManager OR its
 * better-sqlite3 connection. It never updates a legacy execution/history row.
 * captureSource is synchronous: parent provides its complete committed live
 * workspace, sourceRevisions and address-scoped policy/group/root artifacts.
 * Main must read this publication instead of treating workspace-session as
 * organization authority. That old writer cannot write any of these tables.
 */
class WorkflowOrganization {
  constructor({ database, captureSource = () => ({}), activateArtifacts = () => {}, registerTabArtifacts = () => {}, publish = () => {}, fault = () => {} }) {
    this.database = database;
    this.db = database?.db || database;
    if (!this.db?.prepare || !this.db?.transaction) fail('workflow_database_required');
    Object.assign(this, { captureSource, activateArtifacts, registerTabArtifacts, publish, fault });
    this.init();
    if (this.getPublication().version === ORGANIZATION_VERSION) {
      const DatabaseManager = require('./database');
      this.executionDatabase = database?.ensureWorkflowExecutionStorage ? database : new DatabaseManager({ existingConnection: this.db });
      this.executionDatabase.ensureWorkflowExecutionStorage();
    }
  }

  init() {
    if (this.db.inTransaction) fail('workflow_transaction_owner_required');
    // Do not repair/reinitialize a future version, even if some of our tables
    // are missing. Read known fields where available; all writes must refuse.
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_org_meta'").get();
    if (exists) {
      const meta = this.db.prepare('SELECT * FROM workflow_org_meta WHERE singleton=1').get();
      if (!meta || meta.schema_version !== ORGANIZATION_VERSION) return;
    }
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_org_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL,
          generation INTEGER NOT NULL, revision INTEGER NOT NULL, migration_version INTEGER NOT NULL,
          source_fingerprint TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS workflow_org_workflows (
          workflow_id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL,
          metadata_json TEXT NOT NULL, layout_json TEXT NOT NULL, deleted_generation INTEGER
        );
        CREATE TABLE IF NOT EXISTS workflow_org_tabs (
          tab_id TEXT PRIMARY KEY, subject_version INTEGER NOT NULL, execution_json TEXT,
          record_json TEXT NOT NULL, revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_org_memberships (
          tab_id TEXT PRIMARY KEY REFERENCES workflow_org_tabs(tab_id) ON DELETE RESTRICT,
          workflow_id TEXT NOT NULL REFERENCES workflow_org_workflows(workflow_id) ON DELETE RESTRICT,
          revision INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS workflow_org_members_by_workflow ON workflow_org_memberships(workflow_id, tab_id);
        CREATE TABLE IF NOT EXISTS workflow_org_aliases (
          namespace TEXT NOT NULL, tab_id TEXT NOT NULL,
          global_tab_id TEXT NOT NULL REFERENCES workflow_org_tabs(tab_id) ON DELETE RESTRICT,
          metadata_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(namespace, tab_id)
        );
        CREATE TABLE IF NOT EXISTS workflow_org_stages (
          migration_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, base_revision INTEGER NOT NULL,
          source_fingerprint TEXT NOT NULL, source_json TEXT NOT NULL, plan_json TEXT NOT NULL,
          request_hash TEXT NOT NULL, published_generation INTEGER
        );
        CREATE TABLE IF NOT EXISTS workflow_org_generations (
          generation INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, revision INTEGER NOT NULL,
          source_fingerprint TEXT, source_revisions_json TEXT NOT NULL, snapshot_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_org_mutations (
          mutation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
          response_json TEXT NOT NULL, generation INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_org_journal (
          id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, details_json TEXT NOT NULL
        );
      `);
      this.db.prepare(`INSERT OR IGNORE INTO workflow_org_meta
        (singleton,schema_version,generation,revision,migration_version) VALUES(1,?,0,0,0)`).run(ORGANIZATION_VERSION);
    }).immediate();
  }

  getPublication() {
    const row = this.db.prepare('SELECT * FROM workflow_org_meta WHERE singleton=1').get();
    if (!row) fail('workflow_publication_missing');
    return { version: row.schema_version, generation: row.generation, revision: row.revision,
      migrationVersion: row.migration_version, sourceFingerprint: row.source_fingerprint,
      metadata: parse(row.metadata_json) };
  }
  assertWritable(expectedRevision, { migrating = false } = {}) {
    const meta = this.getPublication();
    supported(meta);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== meta.revision) fail('workflow_revision_changed', { currentRevision: meta.revision });
    if (!migrating && meta.migrationVersion !== ORGANIZATION_VERSION) fail('workflow_migration_required');
    if (migrating && meta.migrationVersion !== 0) fail('workflow_already_migrated');
    return meta;
  }
  transaction(fn) {
    if (this.db.inTransaction) fail('workflow_transaction_owner_required');
    return this.db.transaction(fn).immediate();
  }
  read(fn) {
    // A catalog/member/state reader must see a single SQLite snapshot even
    // when another Main connection commits between its SELECT statements.
    return this.db.inTransaction ? fn() : this.db.transaction(fn)();
  }

  captureMigrationSource() {
    const extra = clone(syncValue(this.captureSource()) || {});
    supported(extra);
    const tables = {}, schema = {};
    for (const table of LEGACY_TABLES) {
      const entry = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!entry) continue;
      // Sort by serialized complete row, preserving every future column/blob.
      tables[table] = this.db.prepare(`SELECT * FROM "${table}"`).all().map(row => clone(row))
        .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
      schema[table] = entry.sql;
    }
    const workspaceRaw = tables.app_state?.find(row => row.key === 'workspace-session')?.value;
    let workspace = extra.workspace;
    if (workspace === undefined) {
      try { workspace = workspaceRaw ? parse(workspaceRaw) : {}; }
      catch { fail('workflow_legacy_workspace_corrupt'); }
    }
    return { ...extra, version: ORGANIZATION_VERSION, workspace,
      sourceRevisions: extra.sourceRevisions || {}, legacy: { tables, schema } };
  }

  prepareMigration({ migrationId, expectedRevision }) {
    requireId(migrationId);
    return this.transaction(() => {
      this.assertWritable(expectedRevision, { migrating: true });
      const source = this.captureMigrationSource();
      const sourceFingerprint = fingerprint(source);
      const requestHash = fingerprint({ migrationId, expectedRevision, sourceFingerprint });
      const old = this.db.prepare('SELECT * FROM workflow_org_stages WHERE migration_id=?').get(migrationId);
      if (old) {
        if (old.request_hash !== requestHash) fail('workflow_migration_id_conflict');
        return this.getPreparedMigration(migrationId);
      }
      const plan = planMigration(source);
      this.db.prepare(`INSERT INTO workflow_org_stages
        (migration_id,schema_version,base_revision,source_fingerprint,source_json,plan_json,request_hash)
        VALUES(?,?,?,?,?,?,?)`).run(migrationId, ORGANIZATION_VERSION, expectedRevision,
        sourceFingerprint, stableJson(source), stableJson(plan), requestHash);
      return this.getPreparedMigration(migrationId);
    });
  }
  getPreparedMigration(migrationId) {
    const row = this.db.prepare('SELECT * FROM workflow_org_stages WHERE migration_id=?').get(requireId(migrationId));
    if (!row) return null;
    return { migrationId, version: row.schema_version, baseRevision: row.base_revision,
      sourceFingerprint: row.source_fingerprint, source: parse(row.source_json), plan: parse(row.plan_json),
      publishedGeneration: row.published_generation };
  }

  mutate(kind, request, change, { migrating = false } = {}) {
    requireId(request.mutationId);
    const requestJson = stableJson({ ...request, kind });
    const requestHash = fingerprint(parse(requestJson));
    let replay = false;
    const result = this.transaction(() => {
      // Version protection also applies to retries against a future store.
      supported(this.getPublication());
      const old = this.db.prepare('SELECT * FROM workflow_org_mutations WHERE mutation_id=?').get(request.mutationId);
      if (old) {
        if (old.request_hash !== requestHash) fail('workflow_mutation_id_conflict');
        replay = true;
        return parse(old.response_json);
      }
      const meta = this.assertWritable(request.expectedRevision, { migrating });
      const generation = meta.generation + 1;
      const changed = change(generation, meta) || {};
      const result = { ...changed, mutationId: request.mutationId, version: ORGANIZATION_VERSION,
        generation, revision: meta.revision + 1 };
      const snapshot = this.readState();
      const sourceFingerprint = changed.sourceFingerprint || meta.sourceFingerprint;
      this.db.prepare(`INSERT INTO workflow_org_generations
        (generation,schema_version,revision,source_fingerprint,source_revisions_json,snapshot_json)
        VALUES(?,?,?,?,?,?)`).run(generation, ORGANIZATION_VERSION, result.revision,
        sourceFingerprint, stableJson(changed.sourceRevisions || {}), stableJson({ ...snapshot, publication: result }));
      this.db.prepare(`INSERT INTO workflow_org_mutations
        (mutation_id,request_hash,request_json,response_json,generation) VALUES(?,?,?,?,?)`)
        .run(request.mutationId, requestHash, requestJson, stableJson(result), generation);
      this.fault('beforePublicationMarker', { kind, generation });
      this.db.prepare(`UPDATE workflow_org_meta SET generation=?,revision=?,migration_version=?,source_fingerprint=?
        WHERE singleton=1 AND revision=?`).run(generation, result.revision,
        migrating ? ORGANIZATION_VERSION : meta.migrationVersion, sourceFingerprint, meta.revision);
      return result;
    });
    if (!replay) {
      this.fault('afterCommit', { kind, generation: result.generation });
      // Publication is durable above; a listener failure cannot revoke commit.
      try { this.publish(clone(result)); } catch { /* recover by getPublication/replay */ }
    }
    return result;
  }

  publishMigration(request) {
    return this.mutate('publishMigration', request, generation => {
      const stage = this.getPreparedMigration(request.migrationId);
      if (!stage || stage.version !== ORGANIZATION_VERSION) fail('workflow_migration_stage_missing');
      if (stage.baseRevision !== request.expectedRevision) fail('workflow_revision_changed');
      const current = this.captureMigrationSource();
      if (request.sourceFingerprint !== stage.sourceFingerprint || fingerprint(current) !== stage.sourceFingerprint) {
        fail('workflow_migration_source_changed');
      }
      for (const workflow of stage.plan.workflows) this.insertWorkflow(workflow);
      for (const entry of stage.plan.catalog) {
        const active = entry.records.find(row => !row.archived) || entry.records[0];
        const execution = active ? { ...executionScopeForRow(active.record),
          ...(active.record.execution_subject_version === 2 ? {} : { legacyStorageId: active.record.id }) } : null;
        this.db.prepare(`INSERT INTO workflow_org_tabs(tab_id,subject_version,execution_json,record_json,revision)
          VALUES(?,?,?,?,1)`).run(entry.tabId, execution?.version || 0, execution ? stableJson(execution) : null, stableJson(entry));
        for (const alias of entry.aliases) this.insertAlias(alias, entry.tabId);
      }
      for (const member of stage.plan.memberships) this.db.prepare(`INSERT INTO workflow_org_memberships
        (tab_id,workflow_id,revision) VALUES(?,?,?)`).run(member.tabId, member.workflowId, member.revision);
      for (const details of stage.plan.journal) this.journal(generation, details);
      // Root/policy adapters belong to the parent. They run synchronously on
      // this same DB transaction, before the generation is externally visible.
      // Throwing (or returning a Promise) rolls back their writes and ours.
      syncValue(this.activateArtifacts(clone(stage.plan), generation));
      this.db.prepare('UPDATE workflow_org_stages SET published_generation=? WHERE migration_id=?').run(generation, request.migrationId);
      return { migrationId: request.migrationId, sourceFingerprint: stage.sourceFingerprint,
        sourceRevisions: current.sourceRevisions, integrationRequired: stage.plan.artifacts.integrationRequired };
    }, { migrating: true });
  }
  insertWorkflow(workflow) {
    this.db.prepare(`INSERT INTO workflow_org_workflows
      (workflow_id,kind,revision,metadata_json,layout_json) VALUES(?,?,?,?,?)`)
      .run(workflow.id, workflow.kind, workflow.revision, stableJson(workflow.metadata), stableJson(workflow.layout));
  }
  insertAlias(alias, globalTabId) {
    requireId(alias.namespace); requireId(alias.tabId);
    const old = this.db.prepare('SELECT global_tab_id FROM workflow_org_aliases WHERE namespace=? AND tab_id=?').get(alias.namespace, alias.tabId);
    if (old && old.global_tab_id !== globalTabId) fail('workflow_alias_conflict');
    if (!old) this.db.prepare('INSERT INTO workflow_org_aliases(namespace,tab_id,global_tab_id,metadata_json) VALUES(?,?,?,?)')
      .run(alias.namespace, alias.tabId, globalTabId, stableJson(alias));
  }
  journal(generation, details) {
    this.db.prepare('INSERT INTO workflow_org_journal(generation,details_json) VALUES(?,?)').run(generation, stableJson(details));
  }

  getWorkflow(workflowId, { includeDeleted = false } = {}) {
    const row = this.db.prepare('SELECT * FROM workflow_org_workflows WHERE workflow_id=?').get(requireId(workflowId));
    if (!row || (row.deleted_generation && !includeDeleted)) return null;
    return { id: row.workflow_id, kind: row.kind, revision: row.revision,
      metadata: parse(row.metadata_json), layout: parse(row.layout_json), deletedGeneration: row.deleted_generation };
  }
  listWorkflows({ includeDeleted = false } = {}) {
    return this.read(() => {
      const order = this.getPublication().metadata.workflowOrder || [];
      const workflows = this.db.prepare('SELECT workflow_id FROM workflow_org_workflows ORDER BY rowid').all()
        .map(row => this.getWorkflow(row.workflow_id, { includeDeleted })).filter(Boolean);
      const position = workflow => order.includes(workflow.id) ? order.indexOf(workflow.id) : order.length;
      return workflows.sort((a, b) => position(a) - position(b));
    });
  }
  getMembership(tabId) {
    const row = this.db.prepare('SELECT * FROM workflow_org_memberships WHERE tab_id=?').get(requireId(tabId));
    return row ? { tabId: row.tab_id, workflowId: row.workflow_id, revision: row.revision } : null;
  }
  getTab(tabId) {
    return this.read(() => this.readTab(tabId));
  }
  readTab(tabId) {
    const row = this.db.prepare('SELECT * FROM workflow_org_tabs WHERE tab_id=?').get(requireId(tabId));
    if (!row) return null;
    const saved = parse(row.record_json);
    let executionSubject = row.execution_json ? parse(row.execution_json) : null;
    // Legacy runtime fields are read from the current source row, never from
    // stale migration data. An archived/missing row retains exact provenance.
    const hasTabs = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tabs'").get();
    const legacyRow = row.subject_version === 1 && hasTabs
      ? this.db.prepare('SELECT * FROM tabs WHERE tab_id=? AND project_id=?').get(tabId, executionSubject.projectId) || null : null;
    const nativeRow = row.subject_version === 2 && hasTabs
      ? this.db.prepare('SELECT * FROM tabs WHERE tab_id=? AND execution_subject_id=? AND execution_namespace=? AND execution_subject_version=2')
        .get(tabId, executionSubject.subjectId, executionSubject.executionNamespace) || null : legacyRow;
    if (nativeRow) executionSubject = { ...executionSubject, ...executionScopeForRow(nativeRow) };
    return { tabId, revision: row.revision, subjectVersion: row.subject_version, executionSubject,
      record: saved, legacyRow, nativeRow, membership: this.getMembership(tabId),
      executionResolved: !!nativeRow };
  }
  listGlobalTabs() {
    return this.read(() => this.db.prepare('SELECT tab_id FROM workflow_org_tabs ORDER BY rowid').all().map(row => this.getTab(row.tab_id)));
  }
  listMembers(workflowId) {
    return this.read(() => this.db.prepare('SELECT tab_id FROM workflow_org_memberships WHERE workflow_id=? ORDER BY rowid')
      .all(requireId(workflowId)).map(row => this.getTab(row.tab_id)));
  }
  resolveLegacyAlias({ namespace, tabId }) {
    return this.read(() => {
      const row = this.db.prepare('SELECT global_tab_id FROM workflow_org_aliases WHERE namespace=? AND tab_id=?')
        .get(requireId(namespace), requireId(tabId));
      return row ? this.getTab(row.global_tab_id) : null;
    });
  }
  readState() {
    return this.read(() => ({ publication: this.getPublication(), workflows: this.listWorkflows(), tabs: this.listGlobalTabs() }));
  }
  getJournal() {
    return this.db.prepare('SELECT * FROM workflow_org_journal ORDER BY id').all()
      .map(row => ({ id: row.id, generation: row.generation, ...parse(row.details_json) }));
  }
  getMigrationArtifacts(migrationId) { return this.getPreparedMigration(migrationId)?.plan.artifacts || null; }
  getOrganizationAdapterInputs(migrationId) {
    return this.read(() => {
      const artifacts = this.getMigrationArtifacts(migrationId);
      if (!artifacts) return null;
      const tables = artifacts.legacy.tables;
      const aliases = this.db.prepare('SELECT * FROM workflow_org_aliases ORDER BY namespace,tab_id').all();
      return { publication: this.getPublication(), artifacts,
        // A partially moved group may have members in several workflows. The
        // raw group definition/order stays address-scoped; adapters receive
        // explicit partitions rather than a fabricated merged group/root scope.
        namespaces: (tables.projects || []).map(project => ({
          namespace: project.id, project: clone(project), groupsRaw: project.tab_groups ?? null,
          members: aliases.filter(alias => alias.namespace === project.id).map(alias => ({
            legacyTabId: alias.tab_id, tabId: alias.global_tab_id, membership: this.getMembership(alias.global_tab_id),
          })),
          promptSources: (tables.project_prompt_sources || []).filter(row => row.project_id === project.id),
          quickActions: (tables.quick_actions || []).filter(row => row.project_id === project.id),
          archive: (tables.tab_history || []).filter(row => row.project_id === project.id),
          favorites: (tables.favorites || []).filter(row => row.project_id === project.id),
          exports: (tables.ai_sessions || []).filter(row => row.project_id === project.id),
        })) };
    });
  }

  workflowRequired(workflowId, expectedWorkflowRevision) {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) fail('workflow_not_found');
    supported(workflow.metadata);
    if (expectedWorkflowRevision !== undefined && workflow.revision !== expectedWorkflowRevision) fail('workflow_layout_revision_changed');
    return workflow;
  }
  memberRequired(tabId, expectedMembershipRevision) {
    const member = this.getMembership(tabId);
    if (!member) fail('workflow_tab_not_found');
    if (!Number.isSafeInteger(expectedMembershipRevision) || member.revision !== expectedMembershipRevision) fail('workflow_membership_revision_changed');
    return member;
  }
  validateLayout(workflowId, layout) {
    supportedLayout(layout);
    for (const ref of layoutReferences(layout)) {
      const member = this.getMembership(ref.tabId);
      if (!member || member.workflowId !== workflowId) fail('workflow_layout_membership_conflict', { tabId: ref.tabId });
    }
  }
  writeLayout(workflow, layout, generation) {
    if (stableJson(workflow.layout) === stableJson(layout)) return;
    this.validateLayout(workflow.id, layout);
    this.journal(generation, { reason: 'layout-edit', workflowId: workflow.id, before: workflow.layout, after: layout });
    this.db.prepare('UPDATE workflow_org_workflows SET layout_json=?,revision=revision+1 WHERE workflow_id=?')
      .run(stableJson(layout), workflow.id);
  }
  prunePlacements(tabIds, generation) {
    for (const workflow of this.listWorkflows()) this.writeLayout(workflow, removeLayoutTabs(workflow.layout, tabIds), generation);
  }

  createWorkflow(request) {
    return this.mutate('createWorkflow', request, () => {
      const metadata = clone(request.workflow);
      requireId(metadata?.id); supported(metadata);
      if (metadata.id === INBOX_WORKFLOW_ID || (metadata.kind && metadata.kind !== 'user')) fail('workflow_system_kind_reserved');
      if (this.getWorkflow(metadata.id, { includeDeleted: true })) fail('workflow_id_exists');
      const layout = metadata.layout || {};
      delete metadata.layout;
      this.validateLayout(metadata.id, layout);
      this.insertWorkflow({ id: metadata.id, kind: 'user', revision: 1, metadata, layout });
      return { workflowId: metadata.id };
    });
  }
  registerLegacyTab(request) {
    return this.mutate('registerLegacyTab', request, generation => {
      requireId(request.legacyNamespace); requireId(request.tabId);
      const row = this.db.prepare('SELECT * FROM tabs WHERE project_id=? AND tab_id=? AND execution_subject_version=1')
        .get(request.legacyNamespace, request.tabId);
      if (!row) fail('workflow_exact_legacy_tab_missing');
      const existing = this.getTab(request.tabId);
      if (existing) {
        if (existing.subjectVersion !== 1 || existing.executionSubject.projectId !== request.legacyNamespace) fail('workflow_legacy_address_conflict');
        return { tabId: request.tabId, registered: false, workflowId: existing.membership.workflowId };
      }
      const workflowId = request.workflowId || INBOX_WORKFLOW_ID;
      this.workflowRequired(workflowId);
      const execution = { ...executionScopeForRow(row), legacyStorageId: row.id };
      const entry = { tabId: request.tabId, records: [{ namespace: request.legacyNamespace, archived: false, record: clone(row) }],
        aliases: [{ namespace: request.legacyNamespace, tabId: request.tabId }], references: [] };
      this.db.prepare('INSERT INTO workflow_org_tabs(tab_id,subject_version,execution_json,record_json,revision) VALUES(?,1,?,?,1)')
        .run(request.tabId, stableJson(execution), stableJson(entry));
      this.db.prepare('INSERT INTO workflow_org_memberships VALUES(?,?,1)').run(request.tabId, workflowId);
      this.insertAlias(entry.aliases[0], request.tabId);
      syncValue(this.registerTabArtifacts(request.tabId,{...clone(request),executionSubject:execution,
        record:request.record || {groupId:row.tab_group_id,visualParentTabId:row.visual_parent_tab_id},
        admissionRequest:{sourceTabId:request.sourceTabId || null}},generation));
      return { tabId: request.tabId, registered: true, workflowId, membershipRevision: 1 };
    });
  }
  commitWorkspace(request) {
    return this.mutate('commitWorkspace', request, generation => {
      if (!Array.isArray(request.spaces) || !request.tabWorkflowMembership || typeof request.tabWorkflowMembership !== 'object') fail('workflow_complete_snapshot_required');
      const previous = this.listWorkflows();
      const requested = new Map();
      for (const space of request.spaces) {
        requireId(space?.id); supported(space);
        if (requested.has(space.id)) fail('workflow_space_identity_conflict');
        const old = this.getWorkflow(space.id, { includeDeleted: true });
        if (old?.deletedGeneration) fail('workflow_id_exists');
        if (space.kind && space.kind !== (space.id === INBOX_WORKFLOW_ID ? 'inbox' : 'user')) fail('workflow_system_kind_reserved');
        requested.set(space.id, space);
      }
      // Inbox omission never means system deletion. Its identity/kind survive
      // every complete renderer snapshot, including a snapshot with no spaces.
      if (!requested.has(INBOX_WORKFLOW_ID)) requested.set(INBOX_WORKFLOW_ID, this.getWorkflow(INBOX_WORKFLOW_ID).metadata);
      const removed = previous.filter(workflow => !requested.has(workflow.id));
      const deletedIds = new Set(removed.map(workflow => workflow.id));
      const supplied = Array.isArray(request.tabWorkflowMembership)
        ? Object.fromEntries(request.tabWorkflowMembership.map(member => [member.tabId, member]))
        : request.tabWorkflowMembership;
      const catalog = this.listGlobalTabs();
      if (Object.keys(supplied).length !== catalog.length || catalog.some(tab => !Object.hasOwn(supplied, tab.tabId))) fail('workflow_incomplete_membership_snapshot');
      const newIds = new Set();
      for (const [workflowId, space] of requested) if (!this.getWorkflow(workflowId)) {
        const metadata = clone(space);
        delete metadata.layout;
        this.insertWorkflow({ id: workflowId, kind: 'user', revision: 1, metadata, layout: {} });
        newIds.add(workflowId);
      }
      for (const tab of catalog) {
        const proposal = supplied[tab.tabId];
        let workflowId = typeof proposal === 'string' ? proposal : proposal?.workflowId;
        if (deletedIds.has(workflowId)) workflowId = INBOX_WORKFLOW_ID;
        if (!requested.has(workflowId)) fail('workflow_membership_target_missing', { tabId: tab.tabId });
        if (proposal?.expectedMembershipRevision !== undefined && proposal.expectedMembershipRevision !== tab.membership.revision) fail('workflow_membership_revision_changed');
        if (workflowId !== tab.membership.workflowId) {
          this.db.prepare('UPDATE workflow_org_memberships SET workflow_id=?,revision=revision+1 WHERE tab_id=?').run(workflowId, tab.tabId);
          this.journal(generation, { reason: 'snapshot-membership', before: tab.membership, workflowId });
        }
      }
      // All membership changes above, workflow insertion and profile pruning
      // below, order, tombstones and the publication marker commit together.
      for (const [workflowId, space] of requested) {
        const old = this.getWorkflow(workflowId);
        const fields = clone(space);
        delete fields.layout;
        const metadata = { ...mergeLayout(old?.metadata || {}, fields), id: workflowId };
        const proposedLayout = space.layout === undefined ? old?.layout || {} : mergeLayout(old?.layout || {}, space.layout);
        const foreign = layoutReferences(proposedLayout).filter(ref => this.getMembership(ref.tabId)?.workflowId !== workflowId).map(ref => ref.tabId);
        const layout = removeLayoutTabs(proposedLayout, foreign);
        if (foreign.length) this.journal(generation, { reason: 'snapshot-placement-prune', workflowId, before: proposedLayout, after: layout });
        if (!old) this.insertWorkflow({ id: workflowId, kind: 'user', revision: 1, metadata, layout });
        else {
          this.validateLayout(workflowId, layout);
          if (stableJson(old.metadata) !== stableJson(metadata) || stableJson(old.layout) !== stableJson(layout)) {
            this.journal(generation, { reason: 'snapshot-workflow', before: old });
            this.db.prepare('UPDATE workflow_org_workflows SET metadata_json=?,layout_json=?,revision=? WHERE workflow_id=?')
              .run(stableJson(metadata), stableJson(layout), newIds.has(workflowId) ? 1 : old.revision + 1, workflowId);
          }
        }
      }
      for (const workflow of removed) {
        this.journal(generation, { reason: 'snapshot-workflow-delete', before: workflow });
        this.db.prepare('UPDATE workflow_org_workflows SET layout_json=?,deleted_generation=?,revision=revision+1 WHERE workflow_id=?')
          .run(stableJson(removeLayoutTabs(workflow.layout, catalog.map(tab => tab.tabId))), generation, workflow.id);
      }
      const metadata = this.getPublication().metadata;
      this.db.prepare('UPDATE workflow_org_meta SET metadata_json=? WHERE singleton=1')
        .run(stableJson({ ...metadata, workflowOrder: [...requested.keys()] }));
      return { workflowOrder: [...requested.keys()], deletedWorkflowIds: [...deletedIds] };
    });
  }
  createTab(request) {
    return this.mutate('createTab', request, generation => {
      requireId(request.tabId);
      this.workflowRequired(request.workflowId);
      if (this.getTab(request.tabId)) fail('workflow_tab_id_exists');
      const subject = clone(request.executionSubject);
      if (!subject || subject.version !== EXECUTION_SUBJECT_VERSION || !id(subject.cwd)
        || Object.hasOwn(subject, 'projectId') || (subject.tabId && subject.tabId !== request.tabId)) fail('workflow_execution_subject_v2_required');
      subject.tabId = request.tabId;
      subject.subjectId = subject.subjectId || crypto.randomUUID();
      subject.executionNamespace = subject.executionNamespace || GLOBAL_EXECUTION_NAMESPACE;
      requireId(subject.subjectId);
      requireId(subject.executionNamespace);
      const record = request.record || {};
      supported(record);
      this.executionDatabase.createExecutionTabV2({ tabId: request.tabId, subjectId: subject.subjectId,
        executionNamespace: subject.executionNamespace, cwd: subject.cwd, record });
      this.db.prepare(`INSERT INTO workflow_org_tabs(tab_id,subject_version,execution_json,record_json,revision)
        VALUES(?,?,?,?,1)`).run(request.tabId, EXECUTION_SUBJECT_VERSION, stableJson(subject), stableJson(record));
      this.db.prepare('INSERT INTO workflow_org_memberships(tab_id,workflow_id,revision) VALUES(?,?,1)').run(request.tabId, request.workflowId);
      this.insertAlias({ namespace: subject.executionNamespace, tabId: request.tabId }, request.tabId);
      for (const alias of request.aliases || []) this.insertAlias(alias, request.tabId);
      // Parent-owned direct group/prompt bindings use the same connection and
      // transaction as native storage/catalog/membership. Nothing is published
      // until the synchronous hook and generation commit both succeed.
      syncValue(this.registerTabArtifacts(request.tabId, clone(request), generation));
      return { tabId: request.tabId, workflowId: request.workflowId, membershipRevision: 1, executionSubject: subject };
    });
  }
  moveTab(request) {
    return this.mutate('moveTab', request, generation => {
      const member = this.memberRequired(request.tabId, request.expectedMembershipRevision);
      if (request.layout !== undefined && !Number.isSafeInteger(request.expectedWorkflowRevision)) fail('workflow_layout_revision_required');
      this.workflowRequired(request.workflowId, request.expectedWorkflowRevision);
      const changed=member.workflowId!==request.workflowId;
      if(changed)this.db.prepare('UPDATE workflow_org_memberships SET workflow_id=?,revision=revision+1 WHERE tab_id=?')
        .run(request.workflowId, request.tabId);
      this.journal(generation, { reason: 'membership-move', before: member, workflowId: request.workflowId });
      this.prunePlacements([request.tabId], generation);
      if (request.layout !== undefined) {
        const destination = this.getWorkflow(request.workflowId);
        this.writeLayout(destination, mergeLayout(destination.layout, request.layout), generation);
      }
      return { tabId: request.tabId, workflowId: request.workflowId, membershipRevision: member.revision + Number(changed) };
    });
  }
  moveTabs(request) {
    return this.mutate('moveTabs',request,generation=>{
      if(!Array.isArray(request.members) || !request.members.length
        || new Set(request.members.map(member=>member.tabId)).size!==request.members.length)fail('workflow_move_members_required');
      this.workflowRequired(request.workflowId,request.expectedWorkflowRevision);
      const members=request.members.map(item=>this.memberRequired(item.tabId,item.expectedMembershipRevision));
      for(const member of members) {
        if(member.workflowId!==request.workflowId)this.db.prepare('UPDATE workflow_org_memberships SET workflow_id=?,revision=revision+1 WHERE tab_id=?')
          .run(request.workflowId,member.tabId);
        this.journal(generation,{reason:'membership-move',before:member,workflowId:request.workflowId});
      }
      this.prunePlacements(members.map(member=>member.tabId),generation);
      return {tabIds:members.map(member=>member.tabId),workflowId:request.workflowId};
    });
  }
  detachTab(request) {
    return this.mutate('detachTab', request, generation => {
      const member = this.memberRequired(request.tabId, request.expectedMembershipRevision);
      this.prunePlacements([request.tabId], generation);
      return { tabId: request.tabId, workflowId: member.workflowId, membershipRevision: member.revision };
    });
  }
  saveLayout(request) {
    return this.mutate('saveLayout', request, generation => {
      if (!Number.isSafeInteger(request.expectedWorkflowRevision)) fail('workflow_layout_revision_required');
      const workflow = this.workflowRequired(request.workflowId, request.expectedWorkflowRevision);
      this.writeLayout(workflow, mergeLayout(workflow.layout, request.layout), generation);
      return { workflowId: workflow.id, workflowRevision: this.getWorkflow(workflow.id).revision };
    });
  }
  deleteWorkflow(request) {
    return this.mutate('deleteWorkflow', request, generation => {
      if (request.workflowId === INBOX_WORKFLOW_ID) fail('workflow_inbox_cannot_delete');
      if (!Number.isSafeInteger(request.expectedWorkflowRevision)) fail('workflow_layout_revision_required');
      const workflow = this.workflowRequired(request.workflowId, request.expectedWorkflowRevision);
      const members = this.listMembers(workflow.id).map(tab => tab.tabId);
      this.db.prepare('UPDATE workflow_org_memberships SET workflow_id=?,revision=revision+1 WHERE workflow_id=?')
        .run(INBOX_WORKFLOW_ID, workflow.id);
      this.prunePlacements(members, generation);
      this.journal(generation, { reason: 'workflow-delete', before: workflow, rehomed: members, workflowId: INBOX_WORKFLOW_ID });
      this.db.prepare('UPDATE workflow_org_workflows SET deleted_generation=?,revision=revision+1 WHERE workflow_id=?')
        .run(generation, workflow.id);
      return { workflowId: workflow.id, rehomed: members, inboxWorkflowId: INBOX_WORKFLOW_ID };
    });
  }
}

module.exports = { WorkflowOrganization, LEGACY_TABLES, fingerprint, INBOX_WORKFLOW_ID };
