import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectTimelineWorkingFileMarkers } from './timelineWorkingFileMarkers.mjs';
const linked = [{ path: '/project/work/status.md' }];

test('matching linked edits add the existing pencil attribute and never mutate cached entries', () => {
  const edited = { uuid: 'A', fileEdits: ['work/status.md', '/project/work/status.md'] };
  const readOnly = { uuid: 'B' };
  const entries = [edited, readOnly];
  const projected = projectTimelineWorkingFileMarkers(entries, linked, '/project', path);
  assert.deepEqual(projected[0].docsEdited, ['/project/work/status.md']);
  assert.equal(edited.docsEdited, undefined);
  assert.equal(projected[1], readOnly);
});

test('attachment alone, unlinked files, another root and read calls cannot produce a marker', () => {
  for (const entry of [{ uuid: 'A' }, { uuid: 'A', fileEdits: ['src/code.js'] },
    { uuid: 'A', fileEdits: ['/other/work/status.md'] }]) {
    const entries = [entry];
    assert.equal(projectTimelineWorkingFileMarkers(entries, linked, '/project', path), entries);
  }
});

test('existing docs paths stay one marker; current links can change without a parser rebuild', () => {
  const entry = { uuid: 'A', docsEdited: ['docs/status.md'], fileEdits: ['docs/status.md'] };
  const entries = [entry];
  assert.equal(projectTimelineWorkingFileMarkers(entries, [{ path: '/project/docs/status.md' }], '/project', path), entries);
  assert.equal(projectTimelineWorkingFileMarkers(entries, [], '/project', path), entries);
  const plain = [{ uuid: 'B', fileEdits: ['work/status.md'] }];
  assert.ok(projectTimelineWorkingFileMarkers(plain, linked, '/project', path)[0].docsEdited);
  assert.equal(projectTimelineWorkingFileMarkers(plain, [], '/project', path), plain);
});

test('missing cwd cannot guess a relative target; absolute targets and spaced paths remain exact', () => {
  const files = [{ path: '/private/My Project/notes.md' }];
  assert.equal(projectTimelineWorkingFileMarkers([{ uuid: 'A', fileEdits: ['notes.md'] }], files, '', path)[0].docsEdited, undefined);
  assert.deepEqual(projectTimelineWorkingFileMarkers([{ uuid: 'A', fileEdits: [files[0].path] }], files, '', path)[0].docsEdited, [files[0].path]);
  const lowerCase = [{ path: '/project/work/claude.md' }];
  assert.deepEqual(projectTimelineWorkingFileMarkers([{ uuid: 'B', fileEdits: [lowerCase[0].path] }], lowerCase,
    '/project', path)[0].docsEdited, [lowerCase[0].path]);
});
