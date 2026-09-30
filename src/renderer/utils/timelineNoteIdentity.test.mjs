import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTimelineNoteAnchors } from './timelineNoteIdentity.mjs';

test('note remains on the live point, promoted carrier and canonical row using the main-proven address', () => {
  const anchor = { uuid: 'canonical', sessionId: 'S', sourceIdentity: 'source600', sourceIdentityAliases: ['source500'], sourceUuidAliases: ['live'] };
  for (const entry of [
    { uuid: 'live', sessionId: 'S', sourceIdentity: 'source500' },
    { uuid: 'promoted', sessionId: 'S', sourceIdentity: 'source600', sourceIdentityAliases: ['source500'] },
    { uuid: 'canonical', sessionId: 'S', sourceIdentity: 'source600' },
  ]) assert.equal(projectTimelineNoteAnchors([entry], [anchor])[0].uuid, 'canonical');
});

test('notes never promote another session, ambiguous anchors, or an equal-text point', () => {
  const entry = { uuid: 'live', sessionId: 'S', sourceIdentity: 'source500', content: 'same' };
  for (const anchors of [
    [{ uuid: 'foreign', sessionId: 'OTHER', sourceIdentity: 'source500' }],
    [{ uuid: 'foreign', sessionId: 'S', sourceIdentity: 'source600', content: 'same' }],
    ['A','B'].map(uuid => ({ uuid, sessionId: 'S', sourceIdentity: 'source500' })),
  ]) assert.equal(projectTimelineNoteAnchors([entry], anchors)[0], entry);
});
