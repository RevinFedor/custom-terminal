// One explicitly staged, content-addressed Noted bundle. Used when unrelated
// CURRENT renderer/Source work must NOT hitchhike on a narrow maintenance fix.
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const digest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
export async function readPreparedInstall(projectDir, nonce, { intentPath = path.join(projectDir, 'release', 'prepared-install-intent.json') } = {}) {
  let info, intent;
  try { info = await fs.lstat(intentPath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 100_000 || info.uid !== process.getuid()) throw new Error('invalid prepared install intent file');
  intent = JSON.parse(await fs.readFile(intentPath, 'utf8'));
  if (intent.version !== 1 || !['pending', 'claimed', 'completed', 'failed'].includes(intent.state)) throw new Error('invalid prepared install intent');
  if (intent.state === 'completed') return null;
  if (intent.state === 'failed') throw new Error('prepared install failed; inspect its exact receipt before choosing another cut');
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(nonce || '')) throw new Error('prepared cut is reserved for the external install owner; no manual CURRENT build');
  if (intent.state !== 'pending') throw new Error('prepared install already claimed by ' + String(intent.claimedBy || 'unknown') + '; inspect that exact job, do not replay');
  if (!path.isAbsolute(intent.candidateApp || '') || path.basename(intent.candidateApp) !== 'Noted Terminal.app'
    || !/^[a-f0-9]{64}$/.test(intent.expectedAsarSha256 || '') || !/^[a-f0-9]{64}$/.test(intent.baselineAsarSha256 || '')
    || !Array.isArray(intent.sourcePins) || !intent.sourcePins.length
    || intent.sourcePins.some(pin => !/^src\/main\/[a-zA-Z0-9_.-]+\.js$/.test(pin.path || '') || !/^[a-f0-9]{64}$/.test(pin.sha256 || ''))) {
    throw new Error('invalid prepared install content pins');
  }
  const original = JSON.stringify(intent);
  async function save(patch) {
    const next = { ...intent, ...patch };
    const temp = intentPath + '.tmp-' + process.pid;
    await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(temp, intentPath); intent = next;
  }
  return {
    candidateApp: intent.candidateApp,
    intentPath,
    async verify(installedApp) {
      if (await digest(path.join(installedApp, 'Contents/Resources/app.asar')) !== intent.baselineAsarSha256) throw new Error('installed baseline changed since prepared cut');
      for (const pin of intent.sourcePins) if (await digest(path.join(projectDir, pin.path)) !== pin.sha256) throw new Error('prepared Source pin changed: ' + pin.path);
      const candidate = await fs.lstat(intent.candidateApp);
      if (!candidate.isDirectory() || candidate.isSymbolicLink()) throw new Error('prepared candidate is not a real app directory');
      await this.verifyCandidate(intent.candidateApp);
    },
    async verifyCandidate(app) {
      if (await digest(path.join(app, 'Contents/Resources/app.asar')) !== intent.expectedAsarSha256) throw new Error('prepared candidate ASAR changed');
    },
    async claim() {
      // Called under the normal global installer lock. A pre-lock reader is
      // not a reservation, and must not overwrite a concurrent changed intent.
      if (JSON.stringify(JSON.parse(await fs.readFile(intentPath, 'utf8'))) !== original) throw new Error('prepared install intent changed before claim');
      await save({ state: 'claimed', claimedBy: nonce, claimedAt: Date.now() });
    },
    async finish(result) {
      if (intent.state !== 'claimed' || intent.claimedBy !== nonce) return;
      if (JSON.stringify(JSON.parse(await fs.readFile(intentPath, 'utf8'))) !== JSON.stringify(intent)) throw new Error('prepared install receipt owner changed');
      await save({ state: result.ok ? 'completed' : 'failed', finishedAt: Date.now(),
        result: { ok: result.ok, installed: result.installed, launchRequested: result.launchRequested,
          failedStep: result.failedStep || null, maintenance: result.maintenance || null } });
    },
  };
}
