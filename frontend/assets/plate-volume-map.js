/* A PNG layout never silently guesses an existing physical well. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./gel-links-core.js'):root.PlatePackGelLinks);if(typeof module==='object'&&module.exports)module.exports=api;else root.PCRPlateVolumeMap=api;})(typeof globalThis==='object'?globalThis:this,links=>{
  const validWell=w=>typeof w==='string'&&/^[A-H](?:[1-9]|1[0-2])$/.test(w);
  function indexedWell(index,order){const n=index%96;return order==='column'?'ABCDEFGH'[n%8]+(1+Math.floor(n/8)):'ABCDEFGH'[Math.floor(n/12)]+(n%12+1);}
  function binding(record,row){
    const roi=record.sessions?.find(s=>s.image.sha256===row.hash)?.config.rois.find(r=>r.id===row.id);
    const candidates=[roi?.platepack,record.links?.gels.find(g=>g.sha256===row.hash)?.rois.find(r=>r.id===row.id)?.binding];
    return candidates.find(b=>b&&!b.skipped&&record.plate&&!links.bindingError(record.plate,b))||null;
  }
  function build(result,record,{mode='linked',order='row',target='packed'}={}){
    if(!['linked','roi','compact'].includes(mode)||!['row','column'].includes(order)||!['packed','source'].includes(target))throw Error('プレート図の配置方法を選んでください。');
    const plates=new Map(),unplaced=[];
    function put(key,name,well,row,caption){
      if(!validWell(well)){unplaced.push({...row,reason:'ウェル位置が不明です'});return;}
      if(!plates.has(key))plates.set(key,{key,name,caption,cells:{}});
      const p=plates.get(key);p.cells[well]||=[];p.cells[well].push({...row});
    }
    result.rows.forEach((row,ordinal)=>{
      if(mode!=='linked'){
        if(!Number.isInteger(row.id)||row.id<1||row.id>384){unplaced.push({...row,reason:'ROI番号を配置できません'});return;}
        const index=mode==='compact'?ordinal:row.id-1,page=Math.floor(index/96),key=mode==='compact'?'new:'+page:row.hash+':'+page;
        const name=mode==='compact'?'分注プレート '+(page+1):row.image.replace(/\.[^.]+$/,'')+' · '+(page+1);
        const caption=(mode==='compact'?'選択した順の新しい配置':'ROI番号を使った仮配置')+' · '+(order==='row'?'A1 → A12 → B1':'A1 → H1 → A2');
        put(key,name,indexedWell(index,order),row,caption);return;
      }
      const b=binding(record,row);
      if(!b){unplaced.push({...row,reason:'登録済みのウェル対応がありません'});return;}
      if(target==='source'){
        const p=record.plate.plates[Number(b.sourcePlate)-1];
        put('source:'+b.sourcePlate+':'+b.sourceUid,p.label||'入力プレート '+b.sourcePlate,b.sourceWell,row,'登録済みの入力ウェル対応');return;
      }
      const outputs=record.plate.packedPlates||[];
      if(b.kind==='packed'){
        const p=outputs.find(p=>p.id===b.plateKey);
        put('packed:'+b.plateKey,p.displayName||p.label||p.id,b.well,row,'登録済みの出力ウェル対応');return;
      }
      const found=[];
      for(const p of outputs)for(let r=0;r<8;r++)for(let c=0;c<12;c++){
        const cell=p.grid?.[r]?.[c];if(cell?.sourcePlate===b.sourcePlate&&cell?.sourceWell===b.sourceWell)found.push({p,well:'ABCDEFGH'[r]+(c+1)});
      }
      if(found.length!==1){unplaced.push({...row,reason:found.length?'対応する出力ウェルが複数あります':'対応する出力ウェルがありません'});return;}
      const {p,well}=found[0];put('packed:'+p.id,p.displayName||p.label||p.id,well,row,'登録済みの出力ウェル対応');
    });
    return {plates:[...plates.values()],unplaced,mode,order,target};
  }
  return {build,indexedWell,binding};
});
