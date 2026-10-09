import test from 'node:test';
import assert from 'node:assert/strict';
import { clampTimelinePreviewResponseLines, loadTimelinePreviewResponseLines,
  TIMELINE_PREVIEW_RESPONSE_LINES_KEY } from './timelinePreviewSettings.mjs';

test('new hover-answer setting defaults to three, independent of old expanded Timeline lines', () => {
  assert.equal(loadTimelinePreviewResponseLines({ getItem: () => null }), 3);
  assert.equal(loadTimelinePreviewResponseLines({ getItem: key => key === TIMELINE_PREVIEW_RESPONSE_LINES_KEY ? '7' : '1' }), 7);
  assert.equal(loadTimelinePreviewResponseLines({ getItem: () => { throw new Error('storage unavailable'); } }), 3);
  for (const value of [undefined, NaN, 'bad', 0, -1]) assert.equal(clampTimelinePreviewResponseLines(value), 3);
  assert.equal(clampTimelinePreviewResponseLines(100), 10);
});
