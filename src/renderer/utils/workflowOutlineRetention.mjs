// The outline is organization data. Live card/group presentation has its own
// current model/subscriptions, so a title alone must not restart the drag tree.
function plainCopy(value) {
  if(value===null || ['undefined','string','number','boolean'].includes(typeof value))return value;
  if(typeof value!=='object' || !Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    throw Error('unsupported-outline-data');
  if(Array.isArray(value))return value.map(plainCopy);
  const result={};
  for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if(!descriptor.enumerable)continue;
    if(!('value' in descriptor))throw Error('outline-accessor');
    result[key]=plainCopy(descriptor.value);
  }
  return result;
}
const immutable=value=>{if(value && typeof value==='object'){Object.values(value).forEach(immutable);Object.freeze(value);}return value;};
const tagged=value=>value===undefined ? ['undefined'] : value===null ? ['null']
  : Array.isArray(value) ? ['array',value.map(tagged)]
    : typeof value==='object' ? ['object',Object.keys(value).sort().map(key=>[key,tagged(value[key])])]
      : [typeof value,value];
const shape=nodes=>nodes.map(node=>Object.fromEntries(Object.entries(node).filter(([key])=>key!=='label')
  .map(([key,value])=>[key,key==='children' ? shape(value || []):value])));

export function retainWorkflowOutline(previous,key,candidate) {
  try {
    const detached=plainCopy(candidate),signature=JSON.stringify(tagged(shape(detached)));
    if(previous?.key===key && previous.signature===signature)return previous;
    return{key,signature,outline:immutable(detached),immutable:true};
  }catch {
    // Unknown/non-data metadata follows the original frame publication path.
    return{key,signature:null,outline:candidate,immutable:false};
  }
}
