function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function compareAgentDraftScreenParity(headlessDiagnostic, rendererDiagnostic) {
  const headless = headlessDiagnostic && headlessDiagnostic.available === true
    ? headlessDiagnostic
    : null;
  const renderer = rendererDiagnostic && rendererDiagnostic.success === true
    ? rendererDiagnostic
    : null;
  if (!headless || !renderer) {
    return {
      comparable: false,
      reason: !headless ? 'headless-diagnostic-unavailable' : 'renderer-diagnostic-unavailable',
      rendererError: rendererDiagnostic?.error || null,
    };
  }

  const headlessWriteSeq = finiteNumber(headless.flushedSeq);
  const rendererWriteSeq = finiteNumber(renderer.rendererWriteSeq);
  const sameGeneration = !!headless.generation
    && !!renderer.rendererGeneration
    && headless.generation === renderer.rendererGeneration;
  const sameGenerationOrdinal = finiteNumber(headless.generationOrdinal) !== null
    && finiteNumber(renderer.rendererGenerationOrdinal) !== null
    && finiteNumber(headless.generationOrdinal) === finiteNumber(renderer.rendererGenerationOrdinal);
  const sameWriteSeq = headlessWriteSeq !== null
    && rendererWriteSeq !== null
    && headlessWriteSeq === rendererWriteSeq;
  const sameGeometry = finiteNumber(headless.cursor?.rows) === finiteNumber(renderer.rows)
    && finiteNumber(headless.cursor?.cols) === finiteNumber(renderer.cols);
  const sameCursor = finiteNumber(headless.cursor?.cursorRow) === finiteNumber(renderer.cursorRow)
    && finiteNumber(headless.cursor?.cursorX) === finiteNumber(renderer.cursorX);

  const headlessRows = new Map(
    (Array.isArray(headless.rows) ? headless.rows : [])
      .filter((row) => Number.isFinite(Number(row?.row)))
      .map((row) => [Number(row.row), String(row.text || '')]),
  );
  const rendererRows = new Map(
    (Array.isArray(renderer.lines) ? renderer.lines : [])
      .filter((row) => Number.isFinite(Number(row?.row)))
      .map((row) => [Number(row.row), String(row.text || '')]),
  );
  const comparedRows = [];
  for (const [row, headlessText] of headlessRows) {
    if (!rendererRows.has(row)) continue;
    const rendererText = rendererRows.get(row);
    comparedRows.push({
      row,
      equal: headlessText === rendererText,
      ...(headlessText === rendererText ? {} : { headlessText, rendererText }),
    });
  }
  const differingRows = comparedRows.filter((row) => row.equal !== true);
  const sameBoundary = sameGeneration && sameGenerationOrdinal && sameWriteSeq;
  const comparable = sameBoundary && sameGeometry;
  const rendererPainted = renderer.dom?.painted === true;
  const reason = !sameBoundary
    ? 'renderer-headless-boundary-mismatch'
    : !sameGeometry
      ? 'renderer-headless-geometry-mismatch'
      : 'exact-renderer-headless-boundary';

  return {
    comparable,
    visibleComparable: comparable && rendererPainted,
    rendererPainted,
    reason,
    sameGeneration,
    sameGenerationOrdinal,
    sameWriteSeq,
    sameGeometry,
    sameCursor,
    headlessBoundary: {
      generation: headless.generation || null,
      generationOrdinal: finiteNumber(headless.generationOrdinal),
      writeSeq: finiteNumber(headless.writeSeq),
      flushedSeq: headlessWriteSeq,
      complete: headless.complete === true,
    },
    rendererBoundary: {
      instanceId: renderer.rendererInstanceId || null,
      generation: renderer.rendererGeneration || null,
      generationOrdinal: finiteNumber(renderer.rendererGenerationOrdinal),
      writeSeq: rendererWriteSeq,
      capturedAt: finiteNumber(renderer.capturedAt),
      flushedAt: finiteNumber(renderer.rendererFlushedAt),
    },
    geometry: {
      headless: headless.cursor || null,
      renderer: {
        rows: finiteNumber(renderer.rows),
        cols: finiteNumber(renderer.cols),
        bufferLength: finiteNumber(renderer.bufferLength),
        baseY: finiteNumber(renderer.baseY),
        viewportY: finiteNumber(renderer.viewportY),
        cursorX: finiteNumber(renderer.cursorX),
        cursorY: finiteNumber(renderer.cursorY),
        cursorRow: finiteNumber(renderer.cursorRow),
        dom: renderer.dom || null,
      },
    },
    comparedRowCount: comparedRows.length,
    differingRows,
  };
}

module.exports = {
  compareAgentDraftScreenParity,
};
