const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { orderDirectoryEntries } = require('./project-prompt-catalog');

const root = '/private/catalog-sort';
const directory = path.join(root, 'docs');
const entry = (name, isDirectory = false) => ({ name, path: path.join(directory, name), isDirectory });
const legacyOrder = entries => [...entries].sort((a, b) => {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, {
    numeric: true, sensitivity: 'base',
  });
});

test('natural catalog order preserves numbers, case/accent ties and multilingual names', () => {
  const names = ['10', '2', '02', '1', 'a', 'A', 'á', 'a\u0301', 'Å', 'ä',
    'Ёлка', 'елка', 'Елка', 'ёлка', 'задача10', 'задача2', 'Z', 'z',
    'İ', 'i', 'I', 'ı', 'ß', 'ss', 'Σ', 'σ', 'ς', '一', '二', '😀', '🧩',
    'a-b', 'a_b', 'a b', '[task]', 'v1.10', 'v1.2', '2.prompt.md', '10.prompt.md'];
  for (let shift = 0; shift < names.length; shift++) {
    const rotated = names.slice(shift).concat(names.slice(0, shift));
    const entries = rotated.map((name, index) => entry(name, index % 3 === 0));
    assert.deepEqual(orderDirectoryEntries(entries, directory, root), legacyOrder(entries));
    assert.deepEqual(orderDirectoryEntries([...entries].reverse(), directory, root), legacyOrder([...entries].reverse()));
  }
});

test('manual positions and visual file children keep their exact precedence over natural order', () => {
  const entries = [entry('10.prompt.md'), entry('2.prompt.md'), entry('folder10', true),
    entry('folder2', true), entry('É.prompt.md'), entry('e.prompt.md')];
  const [ten, two, folderTen, folderTwo, accent, lower] = entries;
  const layout = {
    orderByParent: { [directory]: [ten.path, ten.path, '/missing', accent.path] },
    visualParentByPath: { [lower.path]: ten.path },
  };
  assert.deepEqual(orderDirectoryEntries(entries, directory, root, layout),
    [ten, lower, accent, folderTwo, folderTen, two]);
});

test('base-equal sibling names retain source order without introducing a new tie-breaker', () => {
  const entries = [entry('a.prompt.md'), entry('A.prompt.md'), entry('á.prompt.md')];
  assert.deepEqual(orderDirectoryEntries(entries, directory, root), entries);
  assert.deepEqual(orderDirectoryEntries([...entries].reverse(), directory, root), [...entries].reverse());
});
