import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {transformSync} from 'esbuild';
import * as dwell from '../../utils/navigationDwell.mjs';
const module={exports:{}};
vm.runInNewContext(transformSync(fs.readFileSync(new URL('./NavigationDwellStroke.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code,{
  module,exports:module.exports,require:name=>name==='react'?React:dwell});
test('actual shared finite SVG renders workflow circle and clockwise badge rectangle with the same palette/deadline',()=>{
  for(const shape of ['circle','rect']) {
    const html=renderToStaticMarkup(React.createElement('svg',null,React.createElement(module.exports.default,{shape,trackFill:shape==='circle'?'rgba(20,20,24,0.78)':'none',
      attributes:shape==='rect'?{x:1,y:1,width:24,height:14,rx:4,pathLength:100}:{cx:12,cy:12,r:9}})));
    assert.match(html,new RegExp(`<${shape} `));assert.match(html,/dur="500ms"/);assert.match(html,/stroke="#c4b5fd"/);
    assert.match(html,/stroke-dashoffset="100"/);assert.match(html,/to="0"/);assert.doesNotMatch(html,/infinite|repeatCount/);
    assert.equal((html.match(new RegExp(`<${shape} `,'g'))||[]).length,2,'track and progress reuse the existing glyph node count');
    if(shape==='circle')assert.match(html,/fill="rgba\(20,20,24,0.78\)"/);
  }
});
