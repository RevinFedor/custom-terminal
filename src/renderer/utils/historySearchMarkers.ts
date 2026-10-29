import {create} from 'zustand';
import { historySearchEntryKeys } from '../../shared/history-search.mjs';

type Markers = {lease: object; sessionId: string; keys?: Set<string>; currentKeys?: Set<string>;
  rootClient?: any; currentMatchIndex?: number};
export const useHistorySearchMarkers = create<{byTab: Record<string, Markers>; requests:Record<string,number>; inputRequests:Record<string,number>; markerRevisions:Record<string,number>}>()(() => ({byTab:{},requests:{},inputRequests:{},markerRevisions:{}}));
let sequence=0;
export function requestHistorySearch(tabId:string) {
  useHistorySearchMarkers.setState(state=>({requests:{...state.requests,[tabId]:++sequence}}));
}
export function consumeHistorySearchRequest(tabId:string,request:number) {
  useHistorySearchMarkers.setState(state=>{
    if(state.requests[tabId]!==request)return state;
    const requests={...state.requests};delete requests[tabId];return {requests};
  });
}
export function requestInputSearch(tabId:string) {
  useHistorySearchMarkers.setState(state=>({inputRequests:{...state.inputRequests,[tabId]:++sequence}}));
}
export function consumeInputSearchRequest(tabId:string,request:number) {
  useHistorySearchMarkers.setState(state=>{
    if(state.inputRequests[tabId]!==request)return state;
    const inputRequests={...state.inputRequests};delete inputRequests[tabId];return {inputRequests};
  });
}
export function publishHistorySearchMarkers(tabId: string, value: Markers) {
  useHistorySearchMarkers.setState(state => ({byTab:{...state.byTab,[tabId]:value},
    markerRevisions:{...state.markerRevisions,[tabId]:++sequence}}));
}
export function clearHistorySearchMarkers(tabId: string, lease: object) {
  useHistorySearchMarkers.setState(state => {
    if (state.byTab[tabId]?.lease !== lease) return state;
    const byTab={...state.byTab};delete byTab[tabId];
    const markerRevisions={...state.markerRevisions};delete markerRevisions[tabId];return {byTab,markerRevisions};
  });
}

// Indexed Timeline subscribes to one scalar revision and asks for flags for
// its currently mounted subjects. It never retains History's complete search
// sets or constructs a second search graph from all logical rows.
export function historySearchMarkerFlags(tabId: string, sessionId: string | null, entry: any) {
  const marker = useHistorySearchMarkers.getState().byTab[tabId];
  if (!marker || marker.sessionId !== sessionId) return { match: false, current: false };
  if(marker.rootClient)return {match:false,current:false,pending:true};
  const keys = historySearchEntryKeys(entry);
  return { match: keys.some((key: string) => marker.keys?.has(key)),
    current: keys.some((key: string) => marker.currentKeys?.has(key)) };
}
