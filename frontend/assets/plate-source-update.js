/* Apply a direct source-only revision to an experiment without relocating its ROIs. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./plate-editor-core.js'),require('./gel-links-core.js'),require('./electrophoresis-checks.js'));
  else root.PlateSourceUpdate=factory(root.PlateEditor,root.PlatePackGelLinks,root.ElectrophoresisChecks);
})(globalThis,(core,links,checks)=>{
  function update(record,entry){
    const boardKey=boards=>checks.key(boards.map(p=>{const copy=core.clone(p);delete copy.displayName;return copy}));
    const plate=entry.payload,meta=plate?.plateEdit;
    if(!record.plateRef||entry.project_id!==record.projectId||meta?.parentRefs?.length!==1||meta.parentRefs[0]!==record.plateRef)
      throw Error('この実験の元プレートを訂正して保存した版を選択してください。');
    if(!meta.operations?.length||meta.operations.some(a=>a.type!=='correct-source'))
      throw Error('入力元の訂正だけを行った版を選択してください。位置変更はROIの再対応が必要です。');
    const base=core.assemble([{entry:{ref:record.plateRef,name:record.plateName,project_id:record.projectId,payload:record.plate},index:0}]).data;
    if(checks.key(base.plates)!==checks.key(meta.initialSourcePlates)||boardKey(base.packedPlates)!==boardKey(meta.initialPackedPlates))
      throw Error('訂正前のプレートが実験の記録と一致しません。');
    let replay=base;for(const a of meta.operations)replay=core.apply(replay,a);
    if(checks.key(replay.plates)!==checks.key(plate.plates)||boardKey(replay.packedPlates)!==boardKey(plate.packedPlates))
      throw Error('訂正履歴とプレートが一致しません。');
    const next=core.clone(record),at=new Date().toISOString();
    if(next.links){
      links.validate(next.links);
      for(const gel of next.links.gels)for(const roi of gel.rois){
        const b=roi.binding;if(!b)continue;
        const error=links.bindingError(record.plate,b);if(error)throw Error('ROI #'+roi.id+': '+error);
        if(b.kind==='packed')roi.binding=links.resolve(plate,'packed',b.plateKey,b.well);
        else{
          let output=null;
          record.plate.packedPlates.forEach((p,pi)=>p.grid.forEach((row,r)=>row.forEach((cell,c)=>{
            if(cell?.sourcePlate===b.sourcePlate&&cell.sourceWell===b.sourceWell)output=plate.packedPlates[pi].grid[r][c];
          })));
          roi.binding=links.resolve(plate,'source',output?.sourcePlate||b.sourcePlate,output?.sourceWell||b.sourceWell);
        }
      }
      links.validate(next.links);
    }
    for(const session of next.sessions){
      const gel=next.links?.gels.find(g=>g.sha256===session.image.sha256),before=core.clone(session.config);
      for(const r of session.config.rois){
        const b=gel?.rois.find(x=>x.id===r.id)?.binding;if(!b)continue;
        r.sample=links.sampleId(next.links,b);
        r.well=links.wellLabel(plate,b);
        r.platepack={...core.clone(b),namespace:next.links.namespace};
      }
      session.history ||= [];session.history.push({at,action:'PlatePack: 入力元の訂正を反映',before,after:core.clone(session.config)});
      session.updatedAt=at;
      // Recompute pooling and exports against corrected identities before confirmation.
      delete session.measuredConfig;delete session.measuredVersion;delete session.measuredAt;
    }
    next.plate=core.clone(plate);delete next.plate.recordType;delete next.plate.gelLinks;
    next.plateRef=entry.ref;next.plateName=entry.name;next.confirmed=null;
    next.sourceUpdates ||= [];next.sourceUpdates.push({at,from:record.plateRef,to:entry.ref,operations:core.clone(meta.operations)});
    return next;
  }
  return {update};
});
