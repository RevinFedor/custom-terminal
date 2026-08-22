import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const originalDir = path.join(here, '..', 'assets', 'workflow-icons', 'original');
const expected = {
  'agrofield-original.b64': '5e34c8409ec9b7961e100f44ac8d167ab28c2e3913f23e12c44ae6444febde34',
  'noted-terminal-original.b64': 'cc0c8c37ed762d2738578cfce8ad7b01c63206e8ca067fd7ccfd4f2a7e79e956',
  'gt-editor-original.b64': '053e2a98fa0222a54a4fc7f12b9c261a0acf4dc81bb510806c8c9b565c093b89',
  'flow-tab-original.b64': '9e12bc899d21981c6eaad3744cf5f0c09687f19ffaed5e62d1dd7cdec87b822d',
  'voice-record-original.b64': 'e18062fdf3a98d25c9d097fb73a072e01fa305c1ea004637effaf8f128fb3b42',
  'ios-dev-original.b64': 'ad17c2d7c217e466ad4c19d64d78ab390440097b57b730f752de2ed0247a54a1',
  'sc-desktop-original.b64': 'ecf8378a31df3bb56a4e3d595760fd1e793329dc831c11776328effef4f86741',
};

test('built-in workflow icons are byte-exact pre-migration production PNGs', () => {
  for (const [name, hash] of Object.entries(expected)) {
    const encoded = fs.readFileSync(path.join(originalDir, name), 'utf8').trim();
    const png = Buffer.from(encoded, 'base64');
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', `${name} is PNG`);
    assert.equal(crypto.createHash('sha256').update(png).digest('hex'), hash, name);
  }
});
