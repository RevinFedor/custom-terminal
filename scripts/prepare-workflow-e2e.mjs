#!/usr/bin/env node
// Parent-owned frozen source/fixture. No Git, provider credentials, production
// data, process launch or global configuration mutations.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('..',import.meta.url));
const lease=await fs.mkdtemp(path.join(os.tmpdir(),'noted-workflow-e2e-'));
const source=path.join(lease,'source');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashes={};
const excluded=new Set(['node_modules','.git','dist','release','logs','target','.DS_Store']);
async function snapshot(from,to,prefix='') {
  await fs.mkdir(to,{recursive:true});
  for(const entry of await fs.readdir(from,{withFileTypes:true})) {
    if(excluded.has(entry.name) || entry.name==='.env' || entry.name.startsWith('.env.')
      || /\.(?:sqlite|db|log)(?:$|-)/.test(entry.name) || prefix==='packages/' && entry.name==='codex')continue;
    const src=path.join(from,entry.name),dest=path.join(to,entry.name),relative=prefix+entry.name;
    if(entry.isDirectory())await snapshot(src,dest,relative+'/');
    else if(entry.isFile()) {
      const bytes=await fs.readFile(src);await fs.writeFile(dest,bytes,{mode:(await fs.stat(src)).mode & 0o777});
      hashes[relative]=hash(bytes);
    }
  }
}
await snapshot(project,source);
await fs.symlink(path.join(project,'node_modules'),path.join(source,'node_modules'));
// Shared source packages must be frozen, even with read-only dependencies.
const shared=path.join(lease,'noted-shared');
await snapshot(path.resolve(project,'../noted-shared'),shared,'../noted-shared/');
await fs.symlink(path.resolve(project,'../noted-shared/node_modules'),path.join(shared,'node_modules'));
const env={NODE_ENV:'development',NOTED_E2E_TEST:'true',NOTED_E2E_WINDOWED:'1',NOTED_E2E_USE_BUILT_RENDERER:'true',
  NOTED_E2E_FILE_LOG:'1',NOTED_E2E_CLI_ISOLATION_ROOT:lease,NOTED_USER_DATA_DIR:path.join(lease,'user-data'),
  NOTED_DISCOVERY_DIR:path.join(lease,'discovery'),CODEX_HOME:path.join(lease,'codex-profile'),CLAUDE_CONFIG_DIR:path.join(lease,'claude-profile'),
  NOTED_CDP_PORT:'9347',NOTED_WEB_PORT:'7994',NOTED_RENDERER_PORT:'5197'};
for(const key of ['NOTED_USER_DATA_DIR','NOTED_DISCOVERY_DIR','CODEX_HOME','CLAUDE_CONFIG_DIR'])await fs.mkdir(env[key],{mode:0o700});
await fs.writeFile(path.join(env.CODEX_HOME,'config.toml'),'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "medium"\n',{mode:0o600});
await fs.writeFile(path.join(lease,'manifest.json'),JSON.stringify({version:1,project,lease,source,env,hashes,
  cutoff:new Date().toISOString(),credentialsCopied:false},null,2),{mode:0o600});
console.log(JSON.stringify({lease,source,files:Object.keys(hashes).length,manifest:path.join(lease,'manifest.json')}));
