const item = (id, label = id, children = []) => ({
  id,
  label,
  kind: 'file',
  collapsible: false,
  expanded: true,
  children,
});

const branch = (id, label = id, children = [], expanded = true) => ({
  id,
  label,
  kind: 'folder',
  collapsible: true,
  expanded,
  children,
});

const fixtureFactories = {
  flat: () => [
    item('flat-a', 'Alpha'),
    item('flat-b', 'Beta'),
    item('flat-c', 'Gamma'),
    item('flat-d', 'Delta'),
    item('flat-e', 'Epsilon'),
  ],

  mixed: () => [
    item('root-intro', '000-root-intro.md'),
    branch('folder-a', '010-folder-a', [
      item('a-readme', '010-folder-a-readme.md'),
      item('a-child', '1-01-child.md', [
        item('a-grandchild', '2-01-grandchild.md', [
          item('a-depth-four', '3-01-depth-four.md'),
        ]),
      ]),
      branch('folder-a-empty', '020-empty-folder'),
      item('a-tail', '1-02-tail.md'),
    ]),
    branch('folder-b', '100-folder-b', [
      item('b-first', '100-folder-b-readme.md'),
      branch('folder-b-closed', '110-closed-folder', [
        item('b-hidden', 'hidden-child.md'),
      ], false),
      item('b-tail', '1-03-tail.md'),
    ]),
    item('root-tail', '999-root-tail.md'),
  ],

  mirrored: () => [
    branch('left-folder', 'Left group', [
      item('left-a', 'Left A'),
      item('left-parent', 'Left parent', [
        item('left-child', 'Left child'),
      ]),
      item('left-tail', 'Left tail'),
    ]),
    branch('right-folder', 'Right group', [
      item('right-a', 'Right A'),
      item('right-parent', 'Right parent', [
        item('right-child', 'Right child'),
      ]),
      item('right-tail', 'Right tail'),
    ]),
    branch('empty-folder', 'Empty group'),
  ],

  anchor: () => [
    item('anchor-before', 'Item before branch'),
    branch('anchor-folder', 'Branch with five items', [
      item('anchor-1', 'Item 1'),
      item('anchor-2', 'Item 2'),
      item('anchor-3', 'Item 3'),
      item('anchor-4', 'Item 4'),
      item('anchor-5', 'Item 5'),
    ]),
    item('anchor-after', 'Item after branch'),
  ],

  long: () => [
    branch('long-top', 'Top group', Array.from({ length: 28 }, (_, index) => (
      item(`top-${index + 1}`, `Top item ${String(index + 1).padStart(2, '0')}`)
    ))),
    item('long-pivot', 'Pivot item'),
    branch('long-bottom', 'Bottom group', Array.from({ length: 30 }, (_, index) => (
      item(`bottom-${index + 1}`, `Bottom item ${String(index + 1).padStart(2, '0')}`)
    ))),
  ],
};

export function createOutlineFixture(name = 'mixed') {
  const factory = fixtureFactories[name] || fixtureFactories.mixed;
  return factory();
}

export function outlineFixtureNames() {
  return Object.keys(fixtureFactories);
}
