const test = require('node:test');
const assert = require('node:assert/strict');
const { _api } = require('./codex-data');
const imagePath = '/tmp/owned-preview-picture.png';
const event = { type: 'event_msg', __line: 1, __byteOffset: 100, timestamp: '2026-10-08T03:00:00Z',
  payload: { type: 'user_message', message: '[Image #1] Check this.', images: [imagePath] } };
const response = { type: 'response_item', __line: 2, __byteOffset: 200, timestamp: '2026-10-08T03:00:01Z',
  payload: { type: 'message', role: 'user', local_images: [imagePath],
    content: [{ type: 'input_image', image_url: 'data:image/png;base64,fixture' },
      { type: 'input_text', text: 'Check this.' }] } };
for (const records of [[event], [response], [event, response], [response, event]]) {
  test('actual Timeline preserves the canonical History image refs: ' + records.map(row => row.type).join(' → '), () => {
    const full = _api.buildCodexFullHistory(records, 'images').find(row => row.role === 'user');
    const rows = _api.buildCodexTimeline(records, 'images');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].imagePaths, full.imagePaths);
    assert.equal(rows[0].imagePaths[0].path, imagePath);
    assert.equal(rows[0].hasImage, true);
  });
}
test('caller image mutation never writes back into retained incremental Timeline state', () => {
  const projector = _api.createCodexTimelineProjector('images');
  projector.feed(event); projector.feed(response);
  const caller = projector.finalize();
  caller[0].imagePaths[0].path = '/tmp/not-the-source.png';
  assert.equal(projector.finalize()[0].imagePaths[0].path, imagePath);
});
