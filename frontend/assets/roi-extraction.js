/* Extraction limits cap lane slots, including undetected samples. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PCRROIExtraction=api;})(typeof globalThis==='object'?globalThis:this,()=>{
  function limit(value){const n=Number(value);if(!Number.isInteger(n)||n<1||n>384)throw Error('最大ROI数は1〜384の整数で入力してください。');return n;}
  function rectangle(start,end,width,height){
    const clamp=(n,max)=>Math.max(0,Math.min(max,n)),x0=clamp(Math.min(start.x,end.x),width),y0=clamp(Math.min(start.y,end.y),height),x1=clamp(Math.max(start.x,end.x),width),y1=clamp(Math.max(start.y,end.y),height);
    return {x:x0,y:y0,width:x1-x0,height:y1-y0};
  }
  function createMasks(){
    const images=new Map();
    const get=hash=>(images.get(hash)||[]).map(rect=>({...rect}));
    return {get,add(hash,rect){if(rect.width<4||rect.height<4)return false;const list=get(hash);if(list.length>=32)throw Error('除外マスクは32か所までです。');images.set(hash,[...list,{...rect}]);return true;},undo(hash){const list=get(hash);list.pop();images.set(hash,list);},clear:hash=>images.delete(hash)};
  }
  function reconcile(before,next){
    const out=JSON.parse(JSON.stringify(next)),kept=[];
    const tolerance=Math.max(8,Number(next.grid?.pitch||before.grid?.pitch||40)*.45);
    for(const roi of out.rois){
      const old=before.rois.find(r=>r.id===roi.id&&r.row===roi.row&&r.col===roi.col&&Math.abs(r.x-roi.x)<tolerance&&Math.abs(r.y-roi.y)<tolerance);
      if(!old)continue;kept.push(roi.id);
      for(const key of ['sample','well','poolGroup','decision','note','widthExcluded','platepack','loading','dilution'])if(old[key]!==undefined)roi[key]=JSON.parse(JSON.stringify(old[key]));
    }
    for(const key of ['poolTotal','poolMin','poolMax','poolStep','groupSize','poolScope','useMarker','markerComparable'])if(before[key]!==undefined)out[key]=before[key];
    out.markers=(out.markers||[]).map(marker=>{const old=before.markers?.find(m=>m.row===marker.row&&Math.abs(m.x-marker.x)<tolerance&&Math.abs(m.y-marker.y)<tolerance);return old?JSON.parse(JSON.stringify(old)):marker;});
    return {config:out,kept};
  }
  let pending=false;
  function ask(name,initial=48){
    if(pending)return Promise.resolve(null);pending=true;
    const dialog=document.getElementById('extractionDialog'),input=document.getElementById('extractionLimit'),form=document.getElementById('extractionForm'),cancel=document.getElementById('cancelExtraction');
    document.getElementById('extractionImage').textContent=name;input.value=initial;
    return new Promise(resolve=>{
      const finish=value=>{form.onsubmit=null;cancel.onclick=null;dialog.oncancel=null;dialog.onclose=null;pending=false;if(dialog.open)dialog.close();resolve(value);};
      form.onsubmit=event=>{event.preventDefault();try{const n=limit(input.value);input.setCustomValidity('');finish(n);}catch(error){input.setCustomValidity(error.message);input.reportValidity();}};
      input.oninput=()=>input.setCustomValidity('');cancel.onclick=()=>finish(null);dialog.oncancel=event=>{event.preventDefault();finish(null);};dialog.onclose=()=>finish(null);
      dialog.showModal();input.focus();input.select();
    });
  }
  return {limit,reconcile,ask,rectangle,createMasks};
});
