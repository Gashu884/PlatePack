/* A portable local file: originals, plate identities, all ROI links and settings. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./plate-volume-map.js'):root.PCRPlateVolumeMap,typeof module==='object'&&module.exports?require('./free-pooling-export.js'):root.PCRFreePoolingExport);if(typeof module==='object'&&module.exports)module.exports=api;else root.PCRROIBackup=api;})(typeof globalThis==='object'?globalThis:this,(mapping,exporter)=>{
  const copy=value=>JSON.parse(JSON.stringify(value));
  function mappings(record){
    const rows=record.sessions.flatMap(session=>session.config.rois.map((roi,index)=>({key:session.image.sha256+':'+roi.id,hash:session.image.sha256,image:session.image.name,id:roi.id,measurement:session.quantification?.results?.[index]||null})));
    const positions=target=>new Map(mapping.build({rows},record,{target}).plates.flatMap(plate=>Object.entries(plate.cells).flatMap(([well,items])=>items.map(row=>[row.key,{plate:plate.name,well}]))));
    const sources=positions('source'),outputs=positions('packed');
    return rows.map(row=>{const session=record.sessions.find(s=>s.image.sha256===row.hash),roi=session.config.rois.find(r=>r.id===row.id),linked=record.links?.gels?.find(g=>g.sha256===row.hash)?.rois.find(r=>r.id===row.id);
      return {image:row.image,sha256:row.hash,roi:row.id,row:roi.row,column:roi.col,geometry:{x:roi.x,y:roi.y,width:session.config.roiWidth,height:session.config.roiHeight,baseline:roi.baseline||null},sample:roi.sample||'',well:roi.well||'',binding:copy(roi.platepack||null),link:copy(linked||null),input:sources.get(row.key)||null,output:outputs.get(row.key)||null,measurement:copy(row.measurement)};
    });
  }
  function create(record,at){
    const out=copy(record);delete out.roiBackup;delete out.localSavedAt;delete out.localDraftClean;
    if(!out.sessions?.length||out.sessions.some(session=>typeof session.raw!=='string'||!session.raw.length))throw Error('元画像を含むROI・well JSONを作成できませんでした。');
    const sets=[...(out.freePools||[])];if(out.freePoolDraft)sets.push(out.freePoolDraft);
    out.roiBackup={format:'pcr-roi-well-backup',version:1,exportedAt:at,includesOriginalImages:true,roiMappings:mappings(out),calculations:sets.map((pool,index)=>{try{const table=exporter.rows(out,pool,at);return {kind:index<(out.freePools||[]).length?'saved':'working',settings:copy(pool),columns:table[0],rows:table.slice(1)};}catch(error){return {settings:copy(pool),error:error.message};}})};
    return out;
  }
  function read(value){
    if(value?.version!==1||!Array.isArray(value.sessions)||!value.sessions.length||value.sessions.length>32)throw Error('ROI・well JSONまたは実験JSONを選んでください。');
    const record=copy(value),hashes=new Set();
    for(const session of record.sessions){const hash=session.image?.sha256,rois=session.config?.rois;if(!/^[a-f0-9]{64}$/i.test(hash||'')||hashes.has(hash)||!Array.isArray(rois)||rois.length>384||new Set(rois.map(roi=>roi.id)).size!==rois.length)throw Error('画像またはROIの識別情報が不正です。');hashes.add(hash);}
    if(record.roiBackup){
      const meta=record.roiBackup;if(meta.format!=='pcr-roi-well-backup'||meta.version!==1)throw Error('対応していないROI・well JSONの形式です。');
      if(record.sessions.some(session=>typeof session.raw!=='string'||!session.raw.length))throw Error('JSONに元画像が含まれていません。');
      if(JSON.stringify(meta.roiMappings)!==JSON.stringify(mappings(record)))throw Error('JSON内のROI・well対応と解析データが一致しません。');
    }
    delete record.roiBackup;delete record.localSavedAt;delete record.localDraftClean;return record;
  }
  function preferLocal(draft,remote){return !!draft?.sessions?.length&&draft.localDraftClean!==true&&draft.projectId===remote.project_id&&Number.isFinite(Date.parse(draft.localSavedAt))&&Date.parse(draft.localSavedAt)>Date.parse(remote.updated_at||remote.created_at);}
  return {create,read,mappings,preferLocal};
});
