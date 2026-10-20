import test from 'node:test';import assert from 'node:assert/strict';
import {stripHexToHsv,stripHsvToHex} from './paneStripColor.mjs';
test('hex/hsv exact RGB round trips for neutral, dark and primary/secondary colors',()=>{
  for(const hex of ['#000000','#ffffff','#ff0000','#00ff00','#0000ff','#ffff00','#00ffff','#ff00ff','#123456','#a78bfa'])
    assert.equal(stripHsvToHex(stripHexToHsv(hex)),hex);
  assert.equal(stripHsvToHex({h:360,s:100,v:100}),'#ff0000');
  assert.throws(()=>stripHexToHsv('red'));
});
