const clamp=(value,max)=>Math.max(0,Math.min(max,Number(value)||0));
export function stripHsvToHex({h,s,v}) {
  const hue=((Number(h)||0)%360+360)%360,saturation=clamp(s,100)/100,value=clamp(v,100)/100;
  const c=value*saturation,x=c*(1-Math.abs((hue/60)%2-1)),m=value-c;
  const rgb=hue<60?[c,x,0]:hue<120?[x,c,0]:hue<180?[0,c,x]:hue<240?[0,x,c]:hue<300?[x,0,c]:[c,0,x];
  return '#'+rgb.map(channel=>Math.round((channel+m)*255).toString(16).padStart(2,'0')).join('');
}
export function stripHexToHsv(hex) {
  if(!/^#[\da-f]{6}$/i.test(hex))throw Error('strip_group_color_invalid');
  const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
  const h=!d?0:max===r?60*(((g-b)/d+6)%6):max===g?60*((b-r)/d+2):60*((r-g)/d+4);
  return {h,s:max?d/max*100:0,v:max*100};
}
