'use strict';
const {execFileSync}=require('node:child_process');
const normalize=value=>String(value || '').trim().replace(/\s+/g,' ');
function parseProcessObservation(text) {
  const match=String(text || '').trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
  return match?{pid:Number(match[1]),ppid:Number(match[2]),processStartedAt:normalize(match[3]),command:match[4].trim()}:null;
}
function readProcessObservation(pid) {
  if(!Number.isInteger(pid) || pid<=1)return null;
  try{return parseProcessObservation(execFileSync('ps',['-p',String(pid),'-o','pid=,ppid=,lstart=,command='],
    {encoding:'utf8',timeout:1000,maxBuffer:65536}));}catch{return null;}
}
function matchesProcessObservation(current,expected) {
  return !!current && !!expected && Number(expected.pid)===current.pid && Number(expected.ppid)===current.ppid
    && normalize(expected.processStartedAt)===current.processStartedAt && String(expected.command || '').trim()===current.command;
}
module.exports={parseProcessObservation,readProcessObservation,matchesProcessObservation};
