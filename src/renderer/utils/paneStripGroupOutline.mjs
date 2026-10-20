const valid=r=>r&&[r.left,r.right,r.top,r.bottom].every(Number.isFinite)&&r.right>r.left&&r.bottom>r.top;
const expand=r=>({left:r.left-.5,right:r.right+.5,top:r.top-.5,bottom:r.bottom+.5});
const round=n=>Math.round(n*100)/100;
const union=intervals=>{
  const out=[];
  for(const [left,right] of intervals.sort((a,b)=>a[0]-b[0])){
    const last=out.at(-1);if(last&&left<=last[1])last[1]=Math.max(last[1],right);else out.push([left,right]);
  }return out;
};
const inside=(intervals,x)=>intervals.some(([a,b])=>x>a&&x<b);

/** Orthogonal UNION boundary, not a bounding box: file bumps and empty
 * intervals remain visible. Work happens at layout publication, never per move. */
export function stripSilhouetteEdges(input,tails=[]) {
  const rects=input.filter(valid),ys=[...new Set(rects.flatMap(r=>[r.top,r.bottom]))].sort((a,b)=>a-b);
  const bands=ys.slice(0,-1).map((top,i)=>({top,bottom:ys[i+1],xs:union(rects.filter(r=>r.top<=top&&r.bottom>=ys[i+1]).map(r=>[r.left,r.right]))}));
  const edges=[];
  const add=(x1,y1,x2,y2)=>{
    const cuts=y1===y2?[...new Set([x1,x2,...tails.flatMap(t=>y1>=t.top&&y1<=t.bottom?[t.left,t.right]:[])
      .filter(x=>x>x1&&x<x2)])].sort((a,b)=>a-b):[y1,y2];
    for(let i=0;i<cuts.length-1;i++){
      const horizontal=y1===y2,a=horizontal?{x:cuts[i],y:y1}:{x:x1,y:cuts[i]},b=horizontal?{x:cuts[i+1],y:y1}:{x:x2,y:cuts[i+1]};
      const x=(a.x+b.x)/2,y=(a.y+b.y)/2;
      const dashed=tails.some(t=>x>=t.left&&x<=t.right&&y>=t.top&&y<=t.bottom);
      edges.push({x1:a.x,y1:a.y,x2:b.x,y2:b.y,dashed});
    }
  };
  for(const band of bands)for(const [a,b]of band.xs){add(a,band.top,a,band.bottom);add(b,band.top,b,band.bottom);}
  for(let i=0;i<ys.length;i++){
    const above=bands[i-1]?.xs||[],below=bands[i]?.xs||[];
    const xs=[...new Set([...above.flat(),...below.flat()])].sort((a,b)=>a-b);
    for(let k=0;k<xs.length-1;k++)if(inside(above,(xs[k]+xs[k+1])/2)!==inside(below,(xs[k]+xs[k+1])/2))add(xs[k],ys[i],xs[k+1],ys[i]);
  }
  return edges;
}
// Round only real turns in the union boundary. Collinear band seams and the
// solid/dashed transition stay continuous; short file steps bound each radius.
export function stripRoundedPaths(edges,radius=0) {
  const point=(x,y)=>({x,y}),key=p=>`${p.x},${p.y}`;
  const ends=edges.map(e=>[point(e.x1,e.y1),point(e.x2,e.y2)]),trimmed=ends.map(pair=>pair.slice());
  const vertices=new Map(),paths=[[],[]],arcs=[[],[]];
  edges.forEach((edge,index)=>ends[index].forEach((p,end)=>{
    const name=key(p),list=vertices.get(name)||[];list.push({index,end});vertices.set(name,list);
  }));
  const requested=Number.isFinite(radius)?Math.max(0,radius):0;
  if(requested>0)for(const links of vertices.values()) {
    if(links.length!==2)continue;
    const [a,b]=links;if(edges[a.index].dashed!==edges[b.index].dashed)continue;
    const at=ends[a.index][a.end],otherA=ends[a.index][1-a.end],otherB=ends[b.index][1-b.end];
    const ax=otherA.x-at.x,ay=otherA.y-at.y,bx=otherB.x-at.x,by=otherB.y-at.y;
    if(ax*bx+ay*by!==0)continue;
    const la=Math.hypot(ax,ay),lb=Math.hypot(bx,by),r=Math.min(requested,la/2,lb/2);
    if(r<.01)continue;
    const entry=point(at.x+ax/la*r,at.y+ay/la*r),exit=point(at.x+bx/lb*r,at.y+by/lb*r);
    trimmed[a.index][a.end]=entry;trimmed[b.index][b.end]=exit;
    const sweep=(-ax*by+ay*bx)>0?1:0;
    arcs[edges[a.index].dashed?1:0].push(`M${round(entry.x)} ${round(entry.y)}A${round(r)} ${round(r)} 0 0 ${sweep} ${round(exit.x)} ${round(exit.y)}`);
  }
  edges.forEach((edge,index)=>{
    const [a,b]=trimmed[index];paths[edge.dashed?1:0].push(`M${round(a.x)} ${round(a.y)}L${round(b.x)} ${round(b.y)}`);
  });
  return {solid:paths[0].concat(arcs[0]).join(''),dashed:paths[1].concat(arcs[1]).join('')};
}

/** `chips` uses the shared strip layout receipt plus separately read card/file
 * silhouettes. Foreign chips always split a run, including noncontiguous groups. */
export function buildPaneStripGroupOutlines({chips,groups,rows=[],radius=0}) {
  const membership=new Map();for(const group of groups||[])for(const id of group.tabIds||[])membership.set(id,group);
  const positioned=(chips||[]).filter(valid);
  const lines=[];
  for(const chip of positioned){
    let line=lines.find(r=>Math.abs(r.top-chip.top)<=1);
    if(!line){line={top:chip.top,chips:[]};lines.push(line);}line.chips.push(chip);
  }
  lines.sort((a,b)=>a.top-b.top);for(const line of lines)line.chips.sort((a,b)=>a.left-b.left);
  const groupRows=new Map();lines.forEach((line,index)=>line.chips.forEach(chip=>{
    const group=membership.get(chip.id);if(group){const set=groupRows.get(group.id)||new Set();set.add(index);groupRows.set(group.id,set);}
  }));
  const outlines=[];
  lines.forEach((line,rowIndex)=>{
    const row=rows.find(row=>Math.abs(row.top-line.top)<=1);
    for(let i=0;i<line.chips.length;){
      const group=membership.get(line.chips[i].id);if(!group){i++;continue;}
      const begin=i,run=[];
      while(i<line.chips.length&&membership.get(line.chips[i].id)?.id===group.id)run.push(line.chips[i++]);
      const rects=run.flatMap(chip=>[expand(chip.card||chip),...(chip.files||[]).filter(valid).map(expand)]),tails=[];
      for(let k=1;k<run.length;k++){
        const left=run[k-1].card||run[k-1],right=run[k].card||run[k];
        if(right.left>left.right)rects.push({left:left.right-.5,right:right.left+.5,top:Math.max(left.top,right.top)-.5,bottom:Math.min(left.bottom,right.bottom)+.5});
      }
      const hasEarlier=[...(groupRows.get(group.id)||[])].some(index=>index<rowIndex);
      const hasLater=[...(groupRows.get(group.id)||[])].some(index=>index>rowIndex);
      const openLeft=!!row&&begin===0&&hasEarlier,openRight=!!row&&i===line.chips.length&&hasLater;
      const left=Math.min(...rects.map(r=>r.left)),right=Math.max(...rects.map(r=>r.right));
      const top=line.top-.5,bottom=Math.max(...rects.map(r=>r.bottom));
      const leftEnd=openLeft?Math.min(row.left-1,left):left,rightEnd=openRight?Math.max(row.right+1,right):right;
      if(openLeft&&leftEnd<left){
        const tail={left:leftEnd,right:left,top,bottom};rects.push(tail);if(left>row.left)tails.push(tail);
      }
      if(openRight&&rightEnd>right){
        const tail={left:right,right:rightEnd,top,bottom};rects.push(tail);if(right<row.right)tails.push(tail);
      }
      // A wrapped row continues beyond the viewport; its artificial ends are
      // not group corners. Keep horizontal strokes long enough to clip, and
      // omit the vertical caps before rounding the real silhouette corners.
      const edges=stripSilhouetteEdges(rects,tails).filter(e=>!(e.x1===e.x2&&
        ((openLeft&&e.x1===leftEnd)||(openRight&&e.x1===rightEnd))));
      const clip=openLeft||openRight?{left:openLeft?row.left:left-1,right:openRight?row.right:right+1,
        top:Math.min(...rects.map(r=>r.top))-1,bottom:bottom+1}:undefined;
      outlines.push({id:`${group.id}:${rowIndex}:${begin}`,groupId:group.id,color:group.color,tabIds:run.map(chip=>chip.id),
        ...stripRoundedPaths(edges,radius),edges,clip});
    }
  });return outlines;
}
