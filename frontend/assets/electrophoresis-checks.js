/* Confirmation is tied to the exact identities, measurement settings and algorithm. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ElectrophoresisChecks=api;})(typeof globalThis==='object'?globalThis:this,()=>{
  function key(value){
    if(Array.isArray(value))return '['+value.map(key).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+key(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  function measured(session,version=session.quantification?.version){
    return !!version&&session.measuredVersion===version&&session.measuredConfig===key(session.config);
  }
  function signature(record){
    return key({plate:record.plate,links:record.links,groupSize:record.groupSize,sessions:record.sessions.map(s=>({hash:s.image.sha256,config:s.config,algorithm:s.quantification?.version,measuredConfig:s.measuredConfig,measuredVersion:s.measuredVersion}))});
  }
  return {key,measured,signature};
});
