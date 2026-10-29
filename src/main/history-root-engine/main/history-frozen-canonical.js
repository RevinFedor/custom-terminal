'use strict';

// A renderer cannot claim that changed physical input is current. Only a
// reader-owned fork of an already published immutable canonical lease can
// prepare another presentation without rereading the physical source.
const { historyPagedCursorAddress, historyPagedCursorFromAddress } = require('./history-paged-store');
const held = new WeakMap();
function forkFrozenCanonical(store, source) {
  const entries = historyPagedCursorAddress(source.entries);
  let root,metadata,checkpoint;
  let transferred = false,primaryFailure;
  try {
    const previous=held.get(source);
    store.transaction(()=>{
      root=source.root.fork();
      // The producer publishes sessionMeta from a separate arena/lease.
      // Pin its exact owner index, not a naked address under entries.root.
      metadata=previous?.store===store&&previous.metadata?previous.metadata.fork()
        :store.lease(store.referenceForCursor(source.sessionMeta));
      checkpoint=source.checkpoint?.fork?.();
    });
    let released = false;
    const snapshot = Object.freeze({ ...source, root,
      entries: historyPagedCursorFromAddress(store, root, entries),
      sessionMeta: metadata.cursor(),...(checkpoint?{checkpoint}:{}),
      sourceSnapshot: Object.freeze({ ...source.sourceSnapshot }),
      release() { if (!released) { released = true;let error;
        for(const lease of [root,metadata,checkpoint])try{lease?.release();}catch(e){error||=e;}if(error)throw error;
      } },
    });
    held.set(snapshot, { store, root, metadata, checkpoint }); transferred = true; return snapshot;
  } catch(error){primaryFailure=error;throw error;}
  finally { if (!transferred) {let error;for(const lease of [root,metadata,checkpoint])try{lease?.release();}catch(e){error||=e;}
    if(error&&!primaryFailure)throw error;if(error&&primaryFailure)console.warn('[HistoryPrimary] canonical-fork-cleanup-failed code='+String(error.code||error.message));
  } }
}
function isFrozenCanonical(store, source) {
  const proof = held.get(source);
  if (!proof || proof.store !== store || proof.root !== source.root) return false;
  proof.root.cursor(); // A released lease cannot authorize new preparation.
  proof.metadata?.cursor();proof.checkpoint?.cursor();
  return true;
}
module.exports = { forkFrozenCanonical, isFrozenCanonical };
