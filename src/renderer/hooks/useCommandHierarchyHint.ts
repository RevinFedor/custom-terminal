import {useLayoutEffect,useRef} from 'react';
import type {RefObject} from 'react';
import {registerCommandHierarchyHint} from '../utils/commandHierarchyHint';

export function useCommandHierarchyHint(root:RefObject<HTMLElement|null>,enabled=true) {
  const lease=useRef<{element:HTMLElement;release:()=>void}|null>(null);
  // Scrollers can appear after a pane/tab conditional mount. This doesn't
  // subscribe to Cmd and doesn't re-render any row or retained surface.
  useLayoutEffect(()=>{
    const element=enabled?root.current:null;
    if(element===lease.current?.element)return;
    lease.current?.release();lease.current=null;
    if(element)lease.current={element,release:registerCommandHierarchyHint(element)};
  });
  useLayoutEffect(()=>()=>{lease.current?.release();lease.current=null;},[]);
}
