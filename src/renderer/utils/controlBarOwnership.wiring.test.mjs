import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(
  fileURLToPath(new URL('../components/Workspace/ClaudeControlBar.tsx', import.meta.url)),
  'utf8',
);

test('one shared measurement function owns the Control Bar layout answer', () => {
  assert.match(source, /const measureControlBar = useCallback\(/);
  const layoutStart = source.indexOf('const measureControlBar = useCallback(');
  const layoutEnd = source.indexOf('useEffect(() => {', layoutStart);
  const layoutBlock = source.slice(layoutStart, layoutEnd);
  assert.equal(
    (layoutBlock.match(/shouldShedControlBarReadings\(/g) || []).length,
    1,
    'the same geometry question must not be implemented twice',
  );
});

test('hidden readings width is reset when the component changes tab owner', () => {
  assert.match(source, /readingsWidthRef\.current = 0;[\s\S]{0,160}setReadingsShed\(false\);[\s\S]{0,80}\[tabId\]/);
});
