'use strict';

// A checked prepared Np subject has its own read-plane lease and wrapper
// lifetime. The wrapper retains the original semantic bundle AND shown view;
// it neither resolves a new Root nor claims React commit, layout or input.
const { createHmac } = require('node:crypto');
const { retainPrimaryHistoryPresentation } = require('./history-primary-semantic-bundle');
const { SCHEMA, sourceProjection, digestJSON } = require('./history-primary-metadata-validation');
const PROFILE = 'primary-prepared-presentation-v1';
const ENCODING = 'history-primary-prepared-presentation-v1';
const MAX_BYTES = 65536;
const fail = code => Object.assign(new Error(code), { code });
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function preparedPresentationBinding(plane, state, validation = state.primaryPresentation?.preparedMetadataValidation) {
  const p = state.primaryPresentation;
  if (!p || !validation || !['validated', 'refused'].includes(validation.kind) || validation.schema !== SCHEMA
    || typeof p.validatePreparedMetadata !== 'function' || !p.sessionMetaCursor
    || p.metadataSchema !== 1 || !p.sourceMetadataCursor || !p.durableMetadataCursor
    || !p.presentationSource || p.semanticSnapshotComplete !== true) throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_REQUIRED');
  if (validation.kind === 'validated' && (!sha(validation.digest)
    || validation.preparedEntryCount !== p.sourceMetadataCursor.length
    || p.presentationSource().length !== validation.preparedEntryCount)) throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_REQUIRED');
  const binding = { ...plane.identity(state), profile: PROFILE, schema: SCHEMA,
    parentNodeToken: plane.nodeToken(state, p.headerCursor), nodeToken: plane.nodeToken(state, p.sourceMetadataCursor),
    metadataIdentity: p.metadataIdentity, metadataSchema: p.metadataSchema, semanticIdentity: p.semanticIdentity,
    semanticRevisionToken: p.semanticRevisionToken, viewRevisionToken: p.viewRevisionToken,
    canonicalEntryCount: p.canonicalEntryCount, sourceEntryCount: p.sourceMetadataCursor.length,
    sourceProof: digestJSON(sourceProjection(state.source)), validationDigest: validation.kind === 'validated' ? validation.digest : null };
  const validationToken = createHmac('sha256', plane.secret).update(JSON.stringify(binding)).digest('hex');
  return { ...binding, validationToken };
}
function preparedPresentationCapability(plane, state) {
  const b = preparedPresentationBinding(plane, state);
  return { profile: PROFILE, schema: SCHEMA, sourceProof: b.sourceProof,
    validationDigest: b.validationDigest, validationToken: b.validationToken };
}
function preparedValidationReceipt(plane, binding) {
  return createHmac('sha256', plane.secret).update('history-primary-prepared-checked-v1:')
    .update(JSON.stringify(binding)).digest('hex');
}
function assertReuse(plane, state, binding, witness) {
  const keys = Object.keys(binding), stable = ['ownerKey', 'generation', 'profile', 'schema', 'metadataIdentity',
    'metadataSchema', 'semanticIdentity', 'semanticRevisionToken', 'canonicalEntryCount', 'sourceEntryCount',
    'sourceProof', 'validationDigest'];
  if (state.primaryPresentation.primaryRequestClass !== 'view' || !witness || typeof witness !== 'object'
    || Array.isArray(witness) || Object.keys(witness).length !== keys.length + 1
    || !keys.every(key => Object.hasOwn(witness, key)) || !Object.hasOwn(witness, 'validationReceipt')
    || !sha(witness.validationReceipt) || !sha(binding.validationDigest) || bytes(witness) > MAX_BYTES
    || stable.some(key => witness[key] !== binding[key])) throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_REUSE');
  const prior = Object.fromEntries(keys.map(key => [key, witness[key]]));
  if (preparedValidationReceipt(plane, prior) !== witness.validationReceipt) throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_REUSE');
}

async function forkPreparedPresentation(plane, request, { consumerKey, control } = {}) {
  plane.assertCapacity(); control?.assertCurrent();
  const original = plane.state(request, consumerKey), p = original.primaryPresentation;
  const binding = preparedPresentationBinding(plane, original);
  const allowed = [...Object.keys(binding), 'encoding', 'reuseValidation', 'preparedRequestId', '_historyRootConsumerKey',
    'readDemandId', 'diagnosticReadId', 'diagnosticActionId'];
  if (request.encoding !== ENCODING || typeof request.preparedRequestId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.preparedRequestId)
    || Object.keys(request).some(key => !allowed.includes(key))
    || bytes(request) > MAX_BYTES || Object.entries(binding).some(([key, value]) => request[key] !== value)) {
    throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_BINDING');
  }
  const assert = () => {
    control?.assertCurrent();
    if (plane.state(request, consumerKey) !== original || original.primaryPresentation !== p) throw fail('HISTORY_ROOT_OWNER_MISMATCH');
  };
  let child, installed, transferred = false, primary;
  plane.opening++;
  try {
    assert();
    let validation;
    if (Object.hasOwn(request, 'reuseValidation')) {
      assertReuse(plane, original, binding, request.reuseValidation);
      if (control?.checkpoint) await control.checkpoint(); else await tick();
      assert(); validation = p.preparedMetadataValidation;
    } else {
      validation = await p.validatePreparedMetadata({ control: { assertCurrent: assert,
        async checkpoint() { assert(); if (control?.checkpoint) await control.checkpoint(); else await tick(); assert(); },
      } });
    }
    assert();
    const checked = preparedPresentationBinding(plane, original, validation);
    if (Object.entries(binding).some(([key, value]) => checked[key] !== value)) throw fail('HISTORY_PRIMARY_PREPARED_VALIDATION_CHANGED');
    child = retainPrimaryHistoryPresentation(plane.store, p);
    assert();
    installed = plane.install({ root: child.root, primaryPresentation: child }, child.headerCursor,
      { consumerKey, ownerKey: original.ownerKey, revision: original.revision, source: original.source, release: () => child.close() });
    const state = installed.state;
    state.preparedPresentationRequestId = request.preparedRequestId;
    state.preparedPresentationOrigin = Object.freeze({ ...binding, validationReceipt: preparedValidationReceipt(plane, binding) });
    const result = { success: true, __notedHistoryTransport: 'root-v1', ...plane.identity(state),
      root: installed.descriptor, totalEntries: child.headerCursor.length,
      sessionMeta: plane.describe(state, child.sessionMetaCursor, { inline: false }),
      sourceSnapshot: original.source, mode: 'unchanged', readMetrics: {},
      readProfile: 'history-primary-v1', semanticSnapshotComplete: true,
      canonicalEntryCount: child.canonicalEntryCount, sourceEntryCount: child.sourceMetadataCursor.length,
      displayUnitCount: child.headerCursor.length, semanticIdentity: child.semanticIdentity,
      metadataIdentity: child.metadataIdentity, metadataSchema: child.metadataSchema,
      semanticRevisionToken: child.semanticRevisionToken, viewRevisionToken: child.viewRevisionToken,
      primaryRequestClass: child.primaryRequestClass,
      sourceMetadata: plane.describe(state, child.sourceMetadataCursor, { inline: false }),
      durableMetadata: plane.describe(state, child.durableMetadataCursor, { inline: false }),
      preparedSource: plane.describe(state, child.presentationSource(), { inline: false }),
      preparedView: plane.describe(state, child.root.cursor(), { inline: false }),
      metadataRowWindow: { profile: 'primary-metadata-fields-v1', minimumCreditBytes: plane.metadataWindowBounds(state).overhead },
      presentationAddresses: { profile: 'primary-presentation-address-v1', maxItems: 3 },
      canonicalConsumers: { profile: 'primary-canonical-consumers-v1', maxItems: 3, valueEncoding: 'history-canonical-consumer-text-v1' },
      canonicalMetadataValidation: plane.canonicalMetadataCapability(state),
      preparedPresentation: preparedPresentationCapability(plane, state),
      preparedValidation: state.preparedPresentationOrigin, retainedPreparedPresentation: true, encoding: ENCODING,
      preparedRequestId: state.preparedPresentationRequestId,
      producerBounded: false, nativeMemoryMeasured: false };
    if (bytes(result) > MAX_BYTES) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL');
    assert(); plane.state(result, consumerKey); transferred = true;
    return result;
  } catch (error) { primary = error; throw error; }
  finally {
    plane.opening--;
    if (!transferred) {
      try { if (installed) plane.drop(installed.state); else child?.close(); }
      catch (error) { if (!primary) throw error; plane.metrics.cleanupErrors = (plane.metrics.cleanupErrors || 0) + 1; }
    }
  }
}

module.exports = { HISTORY_PRIMARY_PREPARED_PRESENTATION_PROFILE: PROFILE,
  HISTORY_PRIMARY_PREPARED_PRESENTATION_ENCODING: ENCODING, preparedPresentationBinding,
  preparedPresentationCapability, forkPreparedPresentation };
