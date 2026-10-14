const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ATOMICITY = 'runtime-only';

function isWithin(rootPath, candidatePath, { allowRoot = true } = {}) {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === '') return allowRoot;
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isStrictDescendant(parentPath, candidatePath) {
  return isWithin(parentPath, candidatePath, { allowRoot: false });
}

function errorDetails(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    code: error.code || null,
    message: error.message || String(error),
  };
}

function exists(fsImpl, targetPath) {
  try {
    fsImpl.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function actualPathsForMove(fsImpl, move) {
  const actualPaths = [];
  try {
    if (exists(fsImpl, move.sourcePath)) actualPaths.push(move.sourcePath);
  } catch {}
  try {
    if (exists(fsImpl, move.destinationPath)) actualPaths.push(move.destinationPath);
  } catch {}
  return actualPaths;
}

function snapshotMoves(fsImpl, moves) {
  return moves.map((move) => {
    const actualPaths = actualPathsForMove(fsImpl, move);
    return {
      sourcePath: move.sourcePath,
      destinationPath: move.destinationPath,
      status: move.status,
      error: move.error || null,
      actualPath: actualPaths.length === 1 ? actualPaths[0] : null,
      actualPaths,
    };
  });
}

function baseResult(overrides) {
  return {
    committed: false,
    rolledBack: false,
    partial: false,
    partialRollbackFailure: false,
    conflict: false,
    reason: null,
    phase: null,
    atomicity: RUNTIME_ATOMICITY,
    crashSafe: false,
    moves: [],
    ...overrides,
  };
}

function normalizeMove(move, index) {
  if (!move || typeof move !== 'object') {
    return { error: { code: 'invalid-move', index, message: 'Move must be an object' } };
  }
  if (typeof move.sourcePath !== 'string' || !move.sourcePath.trim()) {
    return { error: { code: 'invalid-source', index, message: 'sourcePath is required' } };
  }
  if (typeof move.destinationPath !== 'string' || !move.destinationPath.trim()) {
    return { error: { code: 'invalid-destination', index, message: 'destinationPath is required' } };
  }
  return {
    move: {
      sourcePath: path.resolve(move.sourcePath),
      destinationPath: path.resolve(move.destinationPath),
      status: 'not-attempted',
      error: null,
    },
  };
}

function preflightAtomicMoveBatch({ fsImpl, rootPath, moves }) {
  const errors = [];
  const normalizedMoves = [];

  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    errors.push({ code: 'invalid-root', message: 'rootPath is required' });
    return { ok: false, errors, moves: normalizedMoves, rootPath: null };
  }
  if (!Array.isArray(moves) || moves.length === 0) {
    errors.push({ code: 'empty-batch', message: 'At least one move is required' });
    return { ok: false, errors, moves: normalizedMoves, rootPath: path.resolve(rootPath) };
  }

  const requestedRoot = path.resolve(rootPath);
  let canonicalRoot;
  try {
    const rootStat = fsImpl.lstatSync(requestedRoot);
    if (!rootStat.isDirectory()) {
      errors.push({ code: 'root-not-directory', path: requestedRoot, message: 'rootPath must be a directory' });
      return { ok: false, errors, moves: normalizedMoves, rootPath: requestedRoot };
    }
    canonicalRoot = fsImpl.realpathSync(requestedRoot);
  } catch (error) {
    errors.push({ code: 'invalid-root', path: requestedRoot, message: error.message, error: errorDetails(error) });
    return { ok: false, errors, moves: normalizedMoves, rootPath: requestedRoot };
  }

  for (let index = 0; index < moves.length; index += 1) {
    const normalized = normalizeMove(moves[index], index);
    if (normalized.error) {
      errors.push(normalized.error);
      continue;
    }

    const move = normalized.move;
    move.index = index;
    normalizedMoves.push(move);

    if (move.sourcePath === move.destinationPath) {
      errors.push({ code: 'same-path', index, path: move.sourcePath, message: 'Source and destination are identical' });
      continue;
    }

    let sourceStat;
    let canonicalSourceParent;
    try {
      sourceStat = fsImpl.lstatSync(move.sourcePath);
      canonicalSourceParent = fsImpl.realpathSync(path.dirname(move.sourcePath));
      if (!isWithin(canonicalRoot, canonicalSourceParent)) {
        errors.push({ code: 'source-outside-root', index, path: move.sourcePath, message: 'Source is outside rootPath' });
      }
    } catch (error) {
      errors.push({
        code: error && error.code === 'ENOENT' ? 'source-missing' : 'source-invalid',
        index,
        path: move.sourcePath,
        message: error.message,
        error: errorDetails(error),
      });
    }

    let destinationParentStat;
    let canonicalDestinationParent;
    try {
      destinationParentStat = fsImpl.lstatSync(path.dirname(move.destinationPath));
      if (!destinationParentStat.isDirectory()) {
        errors.push({
          code: 'destination-parent-not-directory',
          index,
          path: path.dirname(move.destinationPath),
          message: 'Destination parent must be a directory',
        });
      }
      canonicalDestinationParent = fsImpl.realpathSync(path.dirname(move.destinationPath));
      if (!isWithin(canonicalRoot, canonicalDestinationParent)) {
        errors.push({
          code: 'destination-outside-root',
          index,
          path: move.destinationPath,
          message: 'Destination is outside rootPath',
        });
      }
    } catch (error) {
      errors.push({
        code: error && error.code === 'ENOENT' ? 'destination-parent-missing' : 'destination-parent-invalid',
        index,
        path: path.dirname(move.destinationPath),
        message: error.message,
        error: errorDetails(error),
      });
    }

    try {
      if (exists(fsImpl, move.destinationPath)) {
        errors.push({ code: 'destination-exists', index, path: move.destinationPath, message: 'Destination already exists' });
      }
    } catch (error) {
      errors.push({
        code: 'destination-invalid',
        index,
        path: move.destinationPath,
        message: error.message,
        error: errorDetails(error),
      });
    }

    move.canonicalSourcePath = canonicalSourceParent
      ? path.join(canonicalSourceParent, path.basename(move.sourcePath))
      : move.sourcePath;
    move.canonicalDestinationPath = canonicalDestinationParent
      ? path.join(canonicalDestinationParent, path.basename(move.destinationPath))
      : move.destinationPath;

    if (sourceStat && sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) {
      let canonicalSourceDirectory = move.canonicalSourcePath;
      try { canonicalSourceDirectory = fsImpl.realpathSync(move.sourcePath); } catch {}
      if (isStrictDescendant(canonicalSourceDirectory, move.canonicalDestinationPath)) {
        errors.push({
          code: 'self-descendant',
          index,
          sourcePath: move.sourcePath,
          destinationPath: move.destinationPath,
          message: 'A directory cannot be moved into its own descendant',
        });
      }
    }
  }

  const destinations = new Map();
  for (const move of normalizedMoves) {
    const key = move.canonicalDestinationPath;
    const first = destinations.get(key);
    if (first !== undefined) {
      errors.push({
        code: 'duplicate-destination',
        indexes: [first, move.index],
        path: move.destinationPath,
        message: 'Multiple moves target the same destination',
      });
    } else {
      destinations.set(key, move.index);
    }
  }

  for (let left = 0; left < normalizedMoves.length; left += 1) {
    for (let right = left + 1; right < normalizedMoves.length; right += 1) {
      const first = normalizedMoves[left];
      const second = normalizedMoves[right];
      if (
        first.canonicalSourcePath === second.canonicalSourcePath
        || isStrictDescendant(first.canonicalSourcePath, second.canonicalSourcePath)
        || isStrictDescendant(second.canonicalSourcePath, first.canonicalSourcePath)
      ) {
        errors.push({
          code: 'overlapping-sources',
          indexes: [first.index, second.index],
          paths: [first.sourcePath, second.sourcePath],
          message: 'Batch sources must not overlap',
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    moves: normalizedMoves,
    rootPath: requestedRoot,
    canonicalRoot,
  };
}

function rollbackAppliedMoves({ fsImpl, appliedMoves }) {
  const rollbackErrors = [];
  for (let index = appliedMoves.length - 1; index >= 0; index -= 1) {
    const move = appliedMoves[index];
    try {
      fsImpl.renameSync(move.destinationPath, move.sourcePath);
      move.status = 'rolled-back';
    } catch (error) {
      move.status = 'rollback-failed';
      move.error = errorDetails(error);
      rollbackErrors.push({
        index: move.index,
        sourcePath: move.sourcePath,
        destinationPath: move.destinationPath,
        error: errorDetails(error),
      });
    }
  }
  return rollbackErrors;
}

/**
 * Provides all-or-rollback behavior while this process remains alive. It does
 * not provide crash or power-loss atomicity because filesystem renames and the
 * layout CAS are separate durable operations.
 */
function executeAtomicMoveBatch({
  rootPath,
  moves,
  finalLayout,
  expectedRevision,
  layoutStore,
  beforeRename,
  fsImpl = fs,
}) {
  const preflight = preflightAtomicMoveBatch({ fsImpl, rootPath, moves });
  if (!preflight.ok) {
    return baseResult({
      reason: 'preflight-failed',
      phase: 'preflight',
      preflightErrors: preflight.errors,
      moves: snapshotMoves(fsImpl, preflight.moves),
    });
  }

  if (!layoutStore || typeof layoutStore.put !== 'function') {
    return baseResult({
      reason: 'invalid-layout-store',
      phase: 'preflight',
      preflightErrors: [{ code: 'invalid-layout-store', message: 'layoutStore.put is required' }],
      moves: snapshotMoves(fsImpl, preflight.moves),
    });
  }

  const appliedMoves = [];
  let moveFailure = null;

  for (let index = 0; index < preflight.moves.length; index += 1) {
    const move = preflight.moves[index];
    try {
      if (typeof beforeRename === 'function') {
        beforeRename({
          step: index + 1,
          index,
          sourcePath: move.sourcePath,
          destinationPath: move.destinationPath,
        });
      }
      fsImpl.renameSync(move.sourcePath, move.destinationPath);
      move.status = 'moved';
      appliedMoves.push(move);
    } catch (error) {
      move.status = 'failed';
      move.error = errorDetails(error);
      moveFailure = { index: move.index, error: errorDetails(error) };
      break;
    }
  }

  if (moveFailure) {
    const rollbackErrors = rollbackAppliedMoves({ fsImpl, appliedMoves });
    return baseResult({
      rolledBack: rollbackErrors.length === 0,
      partial: rollbackErrors.length > 0,
      partialRollbackFailure: rollbackErrors.length > 0,
      reason: 'move-failed',
      phase: rollbackErrors.length > 0 ? 'rollback' : 'move',
      failure: moveFailure,
      rollbackErrors,
      moves: snapshotMoves(fsImpl, preflight.moves),
    });
  }

  let layoutResult;
  let layoutFailure = null;
  try {
    layoutResult = layoutStore.put(preflight.rootPath, finalLayout, expectedRevision);
    if (layoutResult && typeof layoutResult.then === 'function') {
      const error = new TypeError('layoutStore.put must be synchronous');
      error.code = 'ASYNC_LAYOUT_STORE';
      throw error;
    }
    if (!layoutResult || layoutResult.ok !== true) {
      layoutFailure = {
        conflict: Boolean(layoutResult && layoutResult.conflict),
        error: null,
        result: layoutResult || null,
      };
    }
  } catch (error) {
    layoutFailure = { conflict: false, error: errorDetails(error), result: null };
  }

  if (layoutFailure) {
    const rollbackErrors = rollbackAppliedMoves({ fsImpl, appliedMoves });
    return baseResult({
      rolledBack: rollbackErrors.length === 0,
      partial: rollbackErrors.length > 0,
      partialRollbackFailure: rollbackErrors.length > 0,
      conflict: layoutFailure.conflict,
      reason: layoutFailure.conflict ? 'layout-conflict' : 'layout-write-failed',
      phase: rollbackErrors.length > 0 ? 'rollback' : 'layout',
      layoutResult: layoutFailure.result,
      failure: layoutFailure.error,
      rollbackErrors,
      moves: snapshotMoves(fsImpl, preflight.moves),
    });
  }

  for (const move of preflight.moves) move.status = 'committed';
  return baseResult({
    committed: true,
    reason: 'committed',
    phase: 'committed',
    layoutResult,
    moves: snapshotMoves(fsImpl, preflight.moves),
  });
}

function isDisposableDndRoot(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) return false;
  const resolved = path.resolve(rootPath);
  const baseName = path.basename(resolved).toLowerCase();
  const explicitlyNamed = /(dnd|drag)/.test(baseName) && /(lab|fixture|e2e|test)/.test(baseName);
  return isWithin(path.resolve(os.tmpdir()), resolved) || explicitlyNamed;
}

function registerAtomicMoveBatchIpc({
  ipcMain,
  layoutStore,
  moveChannel = 'move-items-atomic',
  devFailureChannel = 'dnd-dev-arm-atomic-move-failure',
  allowDevFailureInjection = false,
  logger = console,
}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('ipcMain.handle is required');
  }

  let pendingFailure = null;

  ipcMain.handle(devFailureChannel, (_event, payload = {}) => {
    if (!allowDevFailureInjection) {
      return { ok: false, reason: 'unavailable' };
    }

    const rootPath = typeof payload.rootPath === 'string'
      ? path.resolve(payload.rootPath)
      : '';
    const step = Number(payload.step);
    if (!isDisposableDndRoot(rootPath)) {
      return { ok: false, reason: 'fixture-root-required' };
    }
    if (!Number.isInteger(step) || step < 1) {
      return { ok: false, reason: 'invalid-step' };
    }

    pendingFailure = { rootPath, step };
    return { ok: true, rootPath, step };
  });

  ipcMain.handle(moveChannel, (_event, payload = {}) => {
    const rootPath = typeof payload.rootPath === 'string'
      ? path.resolve(payload.rootPath)
      : payload.rootPath;
    const armedFailure = pendingFailure && pendingFailure.rootPath === rootPath
      ? pendingFailure
      : null;
    if (armedFailure) pendingFailure = null;

    const result = executeAtomicMoveBatch({
      rootPath,
      moves: payload.moves,
      finalLayout: payload.finalLayout,
      expectedRevision: payload.expectedRevision,
      layoutStore,
      beforeRename: armedFailure
        ? ({ step }) => {
            if (step === armedFailure.step) {
              const error = new Error(`Injected atomic move failure at step ${step}`);
              error.code = 'DND_ATOMIC_MOVE_INJECTED_FAILURE';
              throw error;
            }
          }
        : undefined,
    });

    logger?.log?.(
      '[AtomicMoveBatch]',
      `channel=${moveChannel}`,
      `count=${Array.isArray(payload.moves) ? payload.moves.length : 0}`,
      `committed=${result.committed ? 1 : 0}`,
      `rolledBack=${result.rolledBack ? 1 : 0}`,
      `partial=${result.partial ? 1 : 0}`,
      `reason=${result.reason || '-'}`,
    );
    return result;
  });

  return {
    getPendingFailure: () => pendingFailure && { ...pendingFailure },
  };
}

module.exports = {
  RUNTIME_ATOMICITY,
  executeAtomicMoveBatch,
  isDisposableDndRoot,
  preflightAtomicMoveBatch,
  registerAtomicMoveBatchIpc,
};
