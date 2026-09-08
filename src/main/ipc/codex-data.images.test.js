const test = require('node:test');
const assert = require('node:assert/strict');
const { _api } = require('./codex-data');

const event = { __line: 2, __byteOffset: 200, type: 'event_msg',
  payload: { type: 'user_message', message: 'before [Image #1] after',
    local_images: ['/tmp/native-image.png'], images: [] } };
const response = { __line: 1, __byteOffset: 100, type: 'response_item',
  payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: '<image name=[Image #1] path="/tmp/native-image.png">' },
    { type: 'input_image', image_url: 'data:image/png;base64,not-needed-by-history' },
    { type: 'input_text', text: '</image>' },
    { type: 'input_text', text: 'before [Image #1] after' },
  ] } };

for (const [name, records] of [['event only', [event]], ['response only', [response]],
  ['response then event', [response, event]], ['event then response', [event, response]]]) {
  test('native image metadata survives History without an app receipt: ' + name, () => {
    const rows = _api.buildCodexFullHistory(records, 'S').filter(e => e.role === 'user');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, name === 'response only' ? ' before [Image #1] after' : 'before [Image #1] after');
    assert.deepEqual(rows[0].imagePaths, [{ id: 1, path: '/tmp/native-image.png' }]);
    assert.equal(JSON.stringify(rows).includes('base64'), false);
  });
}

test('image markers alone do not invent file identities', () => {
  const rows = _api.buildCodexFullHistory([{ ...event,
    payload: { type: 'user_message', message: '[Image #1]' } }], 'S');
  assert.equal(rows[0].imagePaths, undefined);
});
