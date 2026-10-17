import {create} from 'zustand';

type Markers = {lease: object; sessionId: string; keys: Set<string>; currentKeys: Set<string>};
export const useHistorySearchMarkers = create<{byTab: Record<string, Markers>; requests:Record<string,number>; inputRequests:Record<string,number>}>()(() => ({byTab:{},requests:{},inputRequests:{}}));
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
  useHistorySearchMarkers.setState(state => ({byTab:{...state.byTab,[tabId]:value}}));
}
export function clearHistorySearchMarkers(tabId: string, lease: object) {
  useHistorySearchMarkers.setState(state => {
    if (state.byTab[tabId]?.lease !== lease) return state;
    const byTab={...state.byTab};delete byTab[tabId];return {byTab};
  });
}
