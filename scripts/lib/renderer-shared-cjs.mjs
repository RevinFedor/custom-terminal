import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

// Shared contracts stay CommonJS for Main. Vite's dependency optimizer supplies
// the browser's default/named interop and bundles their relative require edges.
export function rendererSharedCjsEntries(projectRoot) {
  return readdirSync(resolve(projectRoot, 'src/shared'), {
    recursive: true,
    withFileTypes: true,
  })
    .filter(entry => entry.isFile()
      && entry.name.endsWith('.cjs')
      && !/\.(test|spec)\.cjs$/.test(entry.name))
    .map(entry => resolve(entry.parentPath, entry.name))
    .sort();
}

const PREFIX = '@noted/shared-cjs/';
const normalized = value => value.replaceAll('\\', '/');
const entryId = (root, file) => PREFIX + normalized(relative(resolve(root, 'src/shared'), file));

export function rendererSharedCjsIds(projectRoot) {
  return rendererSharedCjsEntries(projectRoot).map(file => entryId(projectRoot, file));
}

// Vite only applies optimizer named/default interop on its bare-import path.
// Absolute include entries do not intercept relative source imports, which
// otherwise reach the browser as raw *.cjs?import (NEW04 actual bootstrap).
// Redirect that directory-scoped DEV edge through ordinary aliases/optimizer;
// leave build CommonJS, raw/url assets, Main requires and source imports intact.
export function rendererSharedCjsDevPlugin(projectRoot) {
  const files = rendererSharedCjsEntries(projectRoot);
  const ids = new Map(files.map(file => [normalized(file), entryId(projectRoot, file)]));
  return {
    name: 'noted-renderer-shared-cjs-dev',
    apply: 'serve',
    enforce: 'pre',
    config() {
      return {resolve: {alias: files.map(file => ({find: ids.get(normalized(file)), replacement: file}))}};
    },
    async resolveId(id, importer, options) {
      if (!importer || options?.scan) return null;
      const query = id.indexOf('?');
      const source = query < 0 ? id : id.slice(0, query);
      if (!source.endsWith('.cjs') || source.startsWith(PREFIX)) return null;
      if (query >= 0 && [...new URLSearchParams(id.slice(query + 1)).keys()]
        .some(key => !['import', 't', 'v'].includes(key))) return null;
      const file = source.startsWith('.') ? resolve(dirname(importer.split('?')[0]), source)
        : source.startsWith('/src/shared/') ? resolve(projectRoot, source.slice(1)) : source;
      const alias = ids.get(normalized(file));
      if (!alias) return null;
      return this.resolve(alias, importer, {...options, skipSelf: true});
    },
  };
}

