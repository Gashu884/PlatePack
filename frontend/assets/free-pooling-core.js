/* The operator chooses membership. Labels and well mappings are advisory. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PCRFreePooling=api;})(typeof globalThis==='object'?globalThis:this,()=>{
  const key=(hash,id)=>hash+':'+id;
  function areaKey(config){return JSON.stringify({width:config.roiWidth,height:config.roiHeight,rois:config.rois.map(r=>({id:r.id,x:r.x,y:r.y,baseline:r.baseline||null,loading:r.loading||1,dilution:r.dilution||1}))});}
  function create(id,name){return {id,name,keys:[],reference:'max',referenceVolume:1,step:.1,minVolume:null,maxVolume:null};}
  const optionalVolume=value=>value==null||String(value).trim()===''?null:Number(value);
  function volumeRange(pool){
    const min=optionalVolume(pool.minVolume),max=optionalVolume(pool.maxVolume);
    if([min,max].some(value=>value!==null&&(!Number.isFinite(value)||value<0)))throw Error('分注量の下限・上限は0以上で入力するか、空欄にしてください。');
    if(min!==null&&max!==null&&min>max)throw Error('分注量の下限は上限以下にしてください。');
    return {min,max};
  }
  function rangeLabel(pool){const {min,max}=volumeRange(pool);return min===null&&max===null?'未設定':min===null?max+' µL以下':max===null?min+' µL以上':min+'–'+max+' µL';}
  const copy=value=>JSON.parse(JSON.stringify(value));
  function working(record){
    if(!record.freePoolDraft){const saved=record.freePools?.find(p=>p.id===record.freePoolId)||record.freePools?.[0];record.freePoolDraft=saved?copy(saved):create('draft','');}
    return record.freePoolDraft;
  }
  function select(record,id){
    const saved=record.freePools?.find(p=>p.id===id);if(!saved)throw Error('保存したセットが見つかりません。');
    record.freePoolId=id;record.freePoolDraft=copy(saved);return record.freePoolDraft;
  }
  const settings=pool=>JSON.stringify({name:String(pool.name||'').trim(),keys:[...new Set(pool.keys)],reference:pool.reference,referenceVolume:Number(pool.referenceVolume),step:Number(pool.step),range:volumeRange(pool)});
  function isSaved(record,pool=working(record)){const saved=record.freePools?.find(p=>p.id===pool.id);try{return !!saved&&settings(saved)===settings(pool);}catch{return false;}}
  function save(record,id,at){
    const draft=working(record),name=String(draft.name||'').trim();if(!name)throw Error('セット名を入力してください。');
    calculate(draft,record.sessions);const previous=record.freePools?.find(p=>p.id===draft.id),update=previous&&previous.name===name;
    const range=volumeRange(draft),saved={...copy(draft),id:update?previous.id:id,name,keys:[...new Set(draft.keys)],referenceVolume:Number(draft.referenceVolume),step:Number(draft.step),minVolume:range.min,maxVolume:range.max,createdAt:update?(previous.createdAt||at):at,savedAt:at};
    record.freePools||=[];if(update)record.freePools[record.freePools.indexOf(previous)]=saved;else record.freePools.push(saved);
    record.freePoolId=saved.id;record.freePoolDraft=copy(saved);return saved;
  }
  function calculate(pool,sessions){
    const volume=Number(pool.referenceVolume),step=Number(pool.step),range=volumeRange(pool);
    if(!Number.isFinite(volume)||volume<=0||!Number.isFinite(step)||step<0)throw Error('基準液量は0より大きく、丸め刻みは0以上で入力してください。');
    if(!['max','median','min'].includes(pool.reference)&&!String(pool.reference).startsWith('band:'))throw Error('基準バンドを選択してください。');
    const lookup=new Map();
    for(const s of sessions)for(let i=0;i<s.config.rois.length;i++){
      const r=s.config.rois[i],m=s.quantification?.results?.[i];
      lookup.set(key(s.image.sha256,r.id),{key:key(s.image.sha256,r.id),hash:s.image.sha256,image:s.image.name,id:r.id,well:r.well||'',sample:r.sample||'',area:m?.area,flags:m?.flags||[],status:m?.status||'unknown',label:r.decision||'auto'});
    }
    const rows=[...new Set(pool.keys)].map(k=>lookup.get(k)||{key:k,id:null,image:'ROIがありません',area:null,flags:[]});
    const areas=rows.map(r=>r.area).filter(a=>Number.isFinite(a)&&a>0).sort((a,b)=>a-b),n=areas.length;
    const median=n?(areas[(n-1)>>1]+areas[n>>1])/2:null;
    let reference=n?(pool.reference==='min'?areas[0]:pool.reference==='median'?median:areas[n-1]):null;
    if(String(pool.reference).startsWith('band:')){const band=rows.find(r=>r.key===pool.reference.slice(5));if(!band||!(band.area>0))throw Error('基準にするバンドを選択してください。');reference=band.area;}
    for(const row of rows){
      row.relative=null;row.volume=null;row.idealVolume=null;row.note='';
      if(!Number.isFinite(row.area)||row.area<=0){row.note=row.id===null?'再抽出でROIがなくなりました':'面積が0のため液量を計算できません';continue;}
      row.relative=row.area/reference;row.idealVolume=volume/row.relative;
      row.volume=step?Math.round((Math.floor(row.idealVolume/step+.5)*step)*1e9)/1e9:row.idealVolume;
      if(!Number.isFinite(row.volume)||!Number.isFinite(row.idealVolume)){row.volume=null;row.idealVolume=null;row.note='計算値が数値範囲を超えています';continue;}
      if(row.volume===0)row.note='丸め後0 µL：丸め刻みを小さくできます';
      if(range.min!==null&&row.volume<range.min||range.max!==null&&row.volume>range.max)row.note+=(row.note?' / ':'')+'設定した目安範囲外（'+rangeLabel(pool)+'・計算には含む）';
    }
    return {rows,count:rows.length,computed:rows.filter(r=>r.volume!==null).length,reference,median,range,total:rows.reduce((sum,r)=>sum+(r.volume||0),0),version:'selected-area-1'};
  }
  return {key,areaKey,create,calculate,working,select,save,isSaved,volumeRange,rangeLabel};
});
