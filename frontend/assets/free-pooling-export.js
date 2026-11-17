/* Use verified physical well links; a missing link never becomes a guessed well. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./free-pooling-core.js'):root.PCRFreePooling,typeof module==='object'&&module.exports?require('./plate-volume-map.js'):root.PCRPlateVolumeMap);if(typeof module==='object'&&module.exports)module.exports=api;else root.PCRFreePoolingExport=api;})(typeof globalThis==='object'?globalThis:this,(core,mapping)=>{
  function rows(record,pool,at){
    const result=core.calculate(pool,record.sessions),source=mapping.build(result,record,{target:'source'}),destination=mapping.build(result,record,{target:'packed'});
    const index=model=>new Map(model.plates.flatMap(p=>Object.entries(p.cells).flatMap(([well,bands])=>bands.map(row=>[row.key,{plate:p.name,well}]))));
    const sources=index(source),destinations=index(destination),missing=new Map(destination.unplaced.map(row=>[row.key,row.reason]));
    const modes={max:'最大面積のバンド',median:'選択バンドの中央値',min:'最小面積のバンド'};
    const referenceBand=String(pool.reference).startsWith('band:')?result.rows.filter(row=>row.key===pool.reference.slice(5)):pool.reference==='median'?[]:result.rows.filter(row=>row.area>0&&row.area===result.reference);
    const selected=JSON.stringify(result.rows.map(row=>({image:row.image,roi:row.id,sha256:row.hash||'',key:row.key})));
    const savedState=core.isSaved(record,pool)?'保存済み':record.freePools?.some(p=>p.id===pool.id)?'保存後に変更あり':'未保存';
    const header=['セット名','入力プレート','入力well','出力プレート','出力well','分注量_µL','泳動画像','ROI番号','サンプルID','wellメモ','ウェル対応','輝度面積','相対値','丸め前分注量_µL','参考ラベル','測定上の注記','計算上の注記','相対値の基準','基準選択キー','基準ROI','基準面積','基準バンド分注量_µL','丸め刻み_µL','選択ROI一覧_JSON','設定保存状態','前回セット保存日時','CSV出力日時','画像SHA256','計算方法'];
    return [header,...result.rows.map(row=>{const from=sources.get(row.key),to=destinations.get(row.key);return [pool.name,from?.plate,from?.well,to?.plate,to?.well,row.volume,row.image,row.id,row.sample,row.well,from&&to?'対応済み':missing.get(row.key)||'ウェル対応未設定',row.area,row.relative,row.idealVolume,row.label,(row.flags||[]).join(' / '),row.note,modes[pool.reference]||'選択したバンド',pool.reference,referenceBand.map(b=>b.image+' #'+b.id).join(' / '),result.reference,Number(pool.referenceVolume),Number(pool.step),selected,savedState,pool.savedAt||'',at,row.hash,result.version];})];
  }
  function csv(record,pool,at){const cell=value=>{let text=String(value??'');if(typeof value!=='number'&&/^[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};return '\ufeff'+rows(record,pool,at).map(row=>row.map(cell).join(',')).join('\r\n');}
  return {rows,csv};
});
