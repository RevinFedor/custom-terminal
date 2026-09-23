import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('packaged main resolves working-directory through the packed srcSharedDir', () => {
  assert.doesNotMatch(main, /require\(['"]\.\.\/shared\/working-directory\.cjs['"]\)/);
  assert.match(
    main,
    /const srcSharedDir = path\.join\(__dirname, '\.\.', '\.\.', 'src', 'shared'\);[\s\S]{0,180}require\(path\.join\(srcSharedDir, 'working-directory\.cjs'\)\)/,
  );
  assert.ok(packageJson.build.files.includes('src/shared/**/*'));
  assert.equal(fs.existsSync(path.join(root, 'src/shared/working-directory.cjs')), true);
});
