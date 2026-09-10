'use strict';

// A newly requested renderer read is not necessarily a newly painted frame.
// Both main and renderer wrappers must apply the same comparison before a
// positive visual hint is allowed to contradict current main empty proof.
function rendererDraftFrameRejection(headlessState, rendererState) {
  const main = headlessState?.frameIdentity;
  if (!main?.generation || !Number.isSafeInteger(main.writeSeq)) return null;
  const renderer = rendererState?.frameIdentity;
  if (!renderer?.generation || !Number.isSafeInteger(renderer.writeSeq)) return 'renderer-frame-unproven';
  if (renderer.generation !== main.generation) return 'renderer-generation-mismatch';
  if (renderer.writeSeq < main.writeSeq) return 'renderer-frame-behind';
  return null;
}

module.exports = { rendererDraftFrameRejection };
