"use strict";

// A pin is a SQL write. This capability shares the exact installed immutable
// unit and its owner vectors; it does not construct/serialize a body document.
const { createHash } = require('node:crypto');
const { beginUnitReadDiagnostic } = require('./history-unit-read-diagnostic');
const { historyPagedCursorAddress, historyPagedCursorFromAddress } = require('./history-paged-store');
const ENCODING = 'history-entry-body-borrow-v1';
const fail = code => Object.assign(new Error(code), { code });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function inspectBodyBorrow(plane, request, consumerKey) {
  plane.assertCapacity();
  const parent = plane.state(request, consumerKey), p = parent.primaryPresentation;
  if (request.encoding !== ENCODING || !uuid(request.bodyRequestId)
    || Buffer.byteLength(JSON.stringify(request)) > 65536 || Object.hasOwn(request, 'sourceSnapshot')) throw fail('HISTORY_BODY_BINDING');
  if (Object.hasOwn(request, 'sessionId') || Object.hasOwn(request, 'cwd')) {
    const owner = createHash('sha256').update(JSON.stringify(['codex', request.sessionId, request.cwd || '', request.tabId || '', consumerKey])).digest('hex');
    if (owner !== parent.ownerKey || request.sessionId !== parent.source?.sessionId) throw fail('HISTORY_ROOT_OWNER_MISMATCH');
  }
  if (!p?.unitAt || !p?.headerAt || !p?.root?.fork) throw fail('HISTORY_ROOT_PRIMARY_VIEW_REQUIRED');
  const header = plane.cursor(parent, request.nodeToken), rank = header.field('rank').scalar();
  if (!Number.isSafeInteger(rank) || rank < 0) throw fail('HISTORY_ROOT_UNIT_RANK');
  if (p.headerAt(rank)?.identity() !== header.identity()) throw fail('HISTORY_ROOT_UNIT_HEADER');
  const cursor = p.unitAt(rank);
  if (cursor?.kind !== 'object') return { parent, cursor, rank, eligible: false };
  const kind = cursor.field('kind');
  let value = ''; if (kind.kind === 'text' && kind.length === 5) for (const chunk of kind.textChunks()) value += chunk;
  return { parent, cursor, rank, eligible: value === 'entry' };
}
function assertBodyChild(state, request) {
  if (state.bodyRequestId !== undefined || Object.hasOwn(request, 'bodyRequestId')) {
    if (!uuid(state.bodyRequestId) || request.bodyRequestId !== state.bodyRequestId) throw fail('HISTORY_BODY_BINDING');
  }
}
function forkBodyBorrow(plane, request, options = {}) {
  const diagnostic = beginUnitReadDiagnostic(options.onUnitDiagnostic);
  let primary, completed = false;
  try {
    diagnostic?.begin('validation');
    const result = forkBodyBorrowOwned(plane, request, options, diagnostic);
    completed = true; return result;
  } catch (error) { primary = error; throw error; }
  finally { diagnostic?.finish(primary, completed); }
}
function forkBodyBorrowOwned(plane, request, { consumerKey, control }, diagnostic) {
  control?.assertCurrent();
  const { parent, cursor, rank, eligible } = inspectBodyBorrow(plane, request, consumerKey);
  diagnostic?.parent(parent, plane.generation, rank); diagnostic?.end('validation');
  diagnostic?.kind(eligible ? 'entry' : 'group'); diagnostic?.memo(eligible ? 'installed-body-pin' : 'unsupported');
  if (!eligible) return { success: true, kind: 'unsupported', encoding: ENCODING,
    ...plane.identity(parent), bodyRequestId: request.bodyRequestId };
  let pin, installed, transferred = false, primary;
  const address = historyPagedCursorAddress(cursor);
  try {
    diagnostic?.begin('install');
    // Capture the handle INSIDE the transaction, including commit/quota errors.
    plane.store.transaction(() => { pin = parent.primaryPresentation.root.fork(); });
    control?.assertCurrent(); plane.state(request, consumerKey);
    const held = historyPagedCursorFromAddress(plane.store, pin, address);
    installed = plane.install({ root: pin }, held, { consumerKey, ownerKey: parent.ownerKey,
      revision: parent.revision, source: parent.source, release: () => pin.release() });
    installed.state.bodyRequestId = request.bodyRequestId;
    const result = { success: true, kind: 'entry-body', encoding: ENCODING, __notedHistoryTransport: 'root-v1',
      ...plane.identity(installed.state), root: installed.descriptor, bodyRequestId: request.bodyRequestId };
    control?.assertCurrent(); plane.state(request, consumerKey); plane.state(result, consumerKey);
    diagnostic?.end('install'); transferred = true; return result;
  } catch (error) { primary = error; throw error; }
  finally {
    diagnostic?.begin('cleanup');
    try { if (!transferred) try { if (installed) plane.drop(installed.state); else pin?.release(); }
    catch (error) { if (!primary) throw error; plane.metrics.cleanupErrors = (plane.metrics.cleanupErrors || 0) + 1; }
    } finally { diagnostic?.end('cleanup'); }
  }
}
// Map/Set membership uses the existing cursor grammar. A page owns at most
// maxItems pairs; no graph dictionary or native historical inventory in Main.
function* bodyPairs(store, cursor) {
  const address = historyPagedCursorAddress(cursor), meta = store.json(address.ref.id);
  if (!['map','set'].includes(cursor.kind)) throw fail('HISTORY_BODY_PAIRS_KIND');
  if (meta.logicalMap) { yield* cursor.pairs(); return; }
  const { HistoryPagedCursor } = require('./history-paged-store');
  for (const page of store.vectorValues(meta.items)) {
    const item = new HistoryPagedCursor(store, store.json(page).value, () => cursor.kind, address.owners, address.imported);
    yield cursor.kind === 'map' ? [item.at(0), item.at(1)] : [item, item];
  }
}
function* bodyItems(store, cursor) {
  const address = historyPagedCursorAddress(cursor), meta = store.json(address.ref.id);
  if (cursor.kind !== 'array') throw fail('HISTORY_BODY_ITEMS_KIND');
  const { HistoryPagedCursor } = require('./history-paged-store');
  for (const { ordinal, page } of store.vectorPresent(meta.items)) if (ordinal < meta.length) {
    yield { ordinal, value: new HistoryPagedCursor(store, store.json(page).value,
      () => cursor.kind, address.owners, address.imported) };
  }
}
module.exports = { ENCODING, inspectBodyBorrow, forkBodyBorrow, assertBodyChild, bodyPairs, bodyItems };
