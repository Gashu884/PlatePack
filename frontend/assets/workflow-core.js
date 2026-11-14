(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PCRWorkflow=api;})(globalThis,()=>{
  function rows(entries,catalog,view,editor){
    const out=[];
    if(view==='input')return entries.filter(e=>!e.payload?.electrophoresis&&!e.payload?.plateEdit&&!e.payload?.packedPlates?.length).map(entry=>({kind:'input',entry,name:entry.name}));
    const plates=editor.deduplicateEntries(entries.filter(e=>!e.payload?.electrophoresis&&e.payload?.packedPlates?.length));
    const groups=editor.overviewGroups(plates,catalog),seen=new Set();
    for(const group of groups){
      const items=group.items.filter(item=>item.status===view);if(!items.length)continue;
      out.push({kind:'group',entry:group.root,name:group.root.name,count:items.length});
      for(const item of items){seen.add(item.entry.ref+'#'+item.index);out.push({...item,kind:'plate',name:editor.plateName(item.entry,item.index)});}
    }
    for(const entry of plates.filter(e=>e.payload.plateEdit))for(const [index] of entry.payload.packedPlates.entries()){
      if(seen.has(entry.ref+'#'+index)||!editor.visible(entry,index,catalog,view))continue;
      const origin=editor.catalogKey(entry,index);if(groups.some(g=>g.items.some(i=>i.origin===origin)))continue;
      out.push({kind:'plate',entry,index,origin,name:editor.plateName(entry,index)});
    }
    // Older stand-alone analysis records remain available without rewriting them.
    if(view==='active')for(const entry of entries.filter(e=>e.payload?.electrophoresis)){const physical=groups.flatMap(g=>g.items);if(!physical.some(item=>analysisMatches(entry,item)))out.push({kind:'analysis',entry,name:entry.name});}
    return out;
  }
  function analysisMatches(entry,item){
    const meta=entry.payload?.electrophoresis;if(!meta?.plateRef)return false;
    if(meta.originKey)return meta.originKey===item.origin;
    if(Number.isInteger(meta.plateIndex)){
      const p=entry.payload.packedPlates?.[meta.plateIndex],origin=p?.outputOrigin||{ref:meta.plateRef,index:meta.plateIndex};
      return origin.ref+'#'+origin.index===item.origin;
    }
    return meta.plateRef===item.entry.ref||item.origin.startsWith(meta.plateRef+'#');
  }
  return {rows,analysisMatches};
});
