'use strict';
const {projectPaneStripRowPlacement} = require('./pane-strip-row-placement.cjs');

const paneOrder = pane => (Array.isArray(pane?.tabs) && pane.tabs.length ? pane.tabs
  : pane?.tabId ? [{tabId:pane.tabId}] : []).filter(entry=>entry?.tabId).map(entry=>entry.tabId);
const centerOrder = (layout,key) => (layout?.centerStrips?.[key]
  || (layout?.activeSpaceTab ? [layout.activeSpaceTab] : [])).map(entry=>entry.tabId);
const sameOrder = (a,b) => a.length===b.length && a.every((id,index)=>id===b[index]);

function readPaneStripRowPlacement(layout,{windowId,centerKey,paneIndex}={}) {
  return windowId ? layout?.splitPanes?.find(pane=>pane.windowId===windowId)?.stripRowPlacement
    : Number.isInteger(paneIndex) ? layout?.splitPanes?.[paneIndex]?.stripRowPlacement
    : layout?.centerStripRowPlacements?.[centerKey];
}

// Project row presentation onto the already chosen order. No placement writer.
function projectPaneStripLayoutRows(before,after,{sourceIds,target=null}={}) {
  const next={...after};
  if(Array.isArray(after.splitPanes))next.splitPanes=after.splitPanes.map((pane,index)=>{
    const prior=pane.windowId ? before?.splitPanes?.find(item=>item.windowId===pane.windowId) : before?.splitPanes?.[index];
    const baseOrder=paneOrder(prior),order=paneOrder(pane);
    const hit=(target?.windowId ? target.windowId===pane.windowId : Number.isInteger(target?.paneIndex) && target.paneIndex===index)
      && Number.isFinite(target.width) && target.width>0;
    if(!hit && sameOrder(baseOrder,order))return pane;
    if(!hit && !Object.hasOwn(prior || {},'stripRowPlacement'))return pane;
    return {...pane,stripRowPlacement:projectPaneStripRowPlacement({
      current:prior?.stripRowPlacement,baseOrder,order,sourceIds,
      rowStartId:hit?target.rowStartId:null,width:hit?target.width:prior?.stripRowPlacement?.width,
    })};
  });
  const keys=new Set([...Object.keys(before?.centerStrips || {}),...Object.keys(after.centerStrips || {}),
    ...Object.keys(before?.centerStripRowPlacements || {}),...(target?.centerKey?[target.centerKey]:[])]);
  for(const key of keys) {
    const baseOrder=centerOrder(before,key),order=centerOrder(after,key);
    const hit=!target?.windowId && !Number.isInteger(target?.paneIndex) && target?.centerKey===key && Number.isFinite(target.width) && target.width>0;
    if(!hit && sameOrder(baseOrder,order))continue;
    if(!hit && !Object.hasOwn(before?.centerStripRowPlacements || {},key))continue;
    next.centerStripRowPlacements={...next.centerStripRowPlacements,[key]:projectPaneStripRowPlacement({
      current:before?.centerStripRowPlacements?.[key],baseOrder,order,sourceIds,
      rowStartId:hit?target.rowStartId:null,width:hit?target.width:before?.centerStripRowPlacements?.[key]?.width,
    })};
  }
  return next;
}

module.exports={readPaneStripRowPlacement,projectPaneStripLayoutRows};
