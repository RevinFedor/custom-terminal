import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {installPerfFreezeProbe} from '../../src/renderer/utils/perfFreezeProbe';
import {uiPerformancePhase} from '../../src/renderer/utils/uiPerformanceDiagnostics.mjs';
import '../../packages/claude-blocks/src/blocks.css';

// Deliberately synthetic retained messages; no transcript, provider or process.
const retained=document.createElement('div');
retained.style.cssText='position:absolute;inset:0;opacity:0;pointer-events:none;z-index:-1';
let html='';
for(let i=0;i<47;i++){
 html+='<section><div class="cb-messages">';
 for(let j=0;j<180;j++)html+='<article class="cb-row cb-row-assistant cb-message"><p>Retained text <b>bold</b> <span>word</span></p><pre><code>const synthetic = true;</code></pre><footer>Saved</footer></article>';
 html+='</div></section>';
}
retained.innerHTML=html;document.body.appendChild(retained);
installPerfFreezeProbe();
function Fixture(){
 const [changed,setChanged]=useState(false);
 return <main data-history-owner="diagnostic-owner" style={{padding:24}}>
  <input aria-label="Private draft" defaultValue="" style={{border:'1px solid #555',padding:8}}/>
  {!changed&&<button data-insp-path="fixture/diagnostic-action.tsx" data-insp-line="24" data-probe-action
   onClick={()=>{
    uiPerformancePhase('fixture-known-cpu-start');
    const start=performance.now();while(performance.now()-start<150){}
    uiPerformancePhase('fixture-known-cpu-end',{ms:performance.now()-start});
    setChanged(true);
   }}>Known CPU and stylesheet work</button>}
  {changed&&<><style data-insp-path="fixture/diagnostic-style.tsx" data-insp-line="30">{'::highlight(diagnostic-retained-work){background:#ffc}'}</style>
   <button data-probe-reset onClick={()=>setChanged(false)}>Reset</button><span data-probe-done>Done</span></>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
