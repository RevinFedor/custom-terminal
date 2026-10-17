import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Main ships the very same pure renderer/compiler dependencies. No runtime
// transpiler, React bridge, copied Swift sorter, or path outside the app.asar.
const root=fileURLToPath(new URL('..',import.meta.url));
export function buildWorkflowNativeDrag({outfile=path.join(root,'dist/workflow-native-drag.cjs')}={}) {
  return buildSync({entryPoints:[path.join(root,'src/main/workflow-native-drag-compiler.mjs')],
    outfile,bundle:true,platform:'node',format:'cjs',target:'node18',logLevel:'silent',metafile:true,
    alias:{'@noted/structured-dnd':path.resolve(root,'../noted-shared/packages/structured-dnd/src')}});
}
