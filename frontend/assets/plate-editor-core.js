/* Immutable output-plate edits. Source identities travel with cells. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlateEditor = api;
})(globalThis, function() {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const well = (r,c) => 'ABCDEFGH'[r] + (c+1);
  const MAX_SELECTED=24;
  const originKey=p=>p.ref+'#'+p.index;
  const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
  function dataSignature(entry){
    const payload=clone(entry.payload);
    // Cursor positions and label orientation do not change sample data or layout.
    for(const key of ['currentPlateIndex','currentPackedIndex','selectedGrowthWeek','wellLabelMode','currentSaveProjectId'])delete payload[key];
    for(const plate of payload.plates||[])if(Array.isArray(plate.wells))plate.wells.sort();
    return canonical({name:entry.name,project:entry.project_id,payload});
  }
  function deduplicateEntries(entries){
    const sorted=entries.map(e=>({...e,aliases:[...e.aliases||[]]})).sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));
    const db=new Map();
    for(const entry of sorted)if(!entry.ref.startsWith('local:')){const signature=dataSignature(entry);if(!db.has(signature))db.set(signature,entry);}
    return sorted.filter(entry=>{
      if(!entry.ref.startsWith('local:'))return true;
      const match=db.get(dataSignature(entry));
      if(!match)return true;
      match.aliases=[...new Set([...match.aliases,entry.ref,...entry.aliases])];return false;
    });
  }
  function plateName(entry,index){
    const p=entry.payload.packedPlates[index];
    return p.displayName || (p.sourceRecordName||entry.name||'プレート').replace(/(_ed|_done)$/g,'')+'_'+String((p.outputOrigin?.index??index)+1).padStart(2,'0');
  }
  function position(value) {
    if (typeof value !== 'string' || !/^[A-H](?:[1-9]|1[0-2])$/.test(value)) throw Error('ウェルが不正です。');
    return [value.charCodeAt(0)-65, Number(value.slice(1))-1];
  }
  function grid(value) {
    if (!Array.isArray(value) || value.length !== 8 || !value.every(r=>Array.isArray(r)&&r.length===12)) throw Error('96ウェルの配置を読み込めません。');
  }
  function identity(p, ref, index) {
    return p.sourceOrigin || {namespace:ref.replace(/[^\w-]/g,'-'), uid:p.uid || 'source-'+(index+1), plate:String(index+1), label:p.label || 'Plate '+(index+1)};
  }
  function assemble(selections, options={}) {
    if (!selections.length || selections.length>(options.groupCompletion?2000:MAX_SELECTED)) throw Error(`1〜${MAX_SELECTED}枚を選択してください。`);
    const entries = [...new Map(selections.map(s=>[s.entry.ref,s.entry])).values()];
    if (new Set(entries.map(e=>e.project_id)).size!==1) throw Error('同じプロジェクトのプレートを選んでください。');
    const data = {version:2, recordType:'edited_plate', plates:[], packedPlates:[], sourceColorMap:[], currentSaveProjectId:entries[0].project_id,
      plateEdit:{version:1, parentRefs:entries.map(e=>e.ref), rootRefs:[...new Set(entries.flatMap(e=>e.payload.plateEdit?.rootRefs || [e.ref]))], parents:entries.map(e=>({ref:e.ref,name:e.name})), operations:[]}};
    const sourceIndices = new Map(), outputOrigins = new Set(), selected = [];
    for (const entry of entries) {
      const snapshot=entry.payload, remap=new Map();
      if (!Array.isArray(snapshot.plates) || !snapshot.plates.length) throw Error('入力プレートがありません。');
      snapshot.plates.forEach((p,i)=>{
        if(!Array.isArray(p.wells))throw Error('入力ウェルが不正です。');
        p.wells.forEach(position);
        const origin=identity(p,entry.ref,i), key=origin.namespace+':'+origin.uid;
        if(!sourceIndices.has(key)){
          const copy=clone(p);copy.sourceOrigin=clone(origin);copy.uid='source-'+(data.plates.length+1);
          copy.label=p.sourceOrigin?p.label:entry.name+' / '+(p.label||'Plate '+(i+1));
          data.plates.push(copy);sourceIndices.set(key,String(data.plates.length));
        } else {
          const existing=data.plates[Number(sourceIndices.get(key))-1];
          if(options.mergeSources){
            // Only selected output cells are authoritative when combining saved revisions.
            existing.wells=[...new Set([...existing.wells,...p.wells])];
            existing.growthWeeks={...p.growthWeeks,...existing.growthWeeks};
          }else if(JSON.stringify(existing.wells)!==JSON.stringify(p.wells) || JSON.stringify(existing.growthWeeks||{})!==JSON.stringify(p.growthWeeks||{}))throw Error('同じ入力プレートに異なる内容があります。同じ版を選択してください。');
        }
        remap.set(String(i+1),sourceIndices.get(key));
      });
      for (const [index, plate] of (snapshot.packedPlates || []).entries()) {
        // Separate files can share unselected historical outputs. Merge only the
        // chosen physical plates across files; originals retain their other plates.
        if((entries.length>1||options.selectedOnly)&&!selections.some(s=>s.entry.ref===entry.ref&&s.index===index))continue;
        grid(plate.grid);
        const origin=plate.outputOrigin || {ref:entry.ref,index};
        const originKey=origin.ref+':'+origin.index;
        if(outputOrigins.has(originKey))throw Error('同じ出力プレートの別の版を同時には編集できません。');
        outputOrigins.add(originKey);
        const copy=clone(plate);copy.outputOrigin=clone(origin);copy.label=plate.label||plate.id||'出力 '+(index+1);copy.displayName=plateName(entry,index);
        copy.sourceRecordName=plate.sourceRecordName||entry.name;
        let id=plate.id||'DEST-'+(index+1),suffix=2;
        while(data.packedPlates.some(p=>p.id===id))id=(plate.id||'DEST')+' ('+suffix+++')';
        copy.id=id;
        copy.grid.forEach((row,r)=>row.forEach((cell,c)=>{
          if(!cell)return;
          const mapped=remap.get(cell.sourcePlate);position(cell.sourceWell);
          if(!mapped || !data.plates[Number(mapped)-1].wells.includes(cell.sourceWell))throw Error(`${copy.displayName} / ${well(r,c)} の入力元 ${cell.sourcePlate}-${cell.sourceWell} が入力プレートにありません。入力一覧と出力配置が一致していません。`);
          cell.sourcePlate=mapped;
        }));
        if(selections.some(s=>s.entry.ref===entry.ref&&s.index===index))selected.push(data.packedPlates.length);
        data.packedPlates.push(copy);
      }
    }
    if(selected.length!==selections.length || new Set(selected).size!==selected.length)throw Error('プレートの選択が重複、または無効です。');
    const identities=new Set();
    for(const p of data.packedPlates)for(const cell of p.grid.flat())if(cell){
      const key=cell.sourcePlate+':'+cell.sourceWell;
      if(identities.has(key))throw Error('同じ試料が複数の出力ウェルにあります。同じ元データの別の版を選んでいないか確認してください。');
      identities.add(key);
    }
    if(options.mergeSources)for(const p of data.packedPlates)for(const c of p.grid.flat())if(c?.growthWeek!==undefined){
      const source=data.plates[Number(c.sourcePlate)-1];source.growthWeeks ||= {};source.growthWeeks[c.sourceWell]=c.growthWeek;
    }
    data.plateEdit.initialPackedPlates=clone(data.packedPlates);
    data.plateEdit.initialSourcePlates=clone(data.plates);
    data.plateEdit.sourceCorrectionHistory=entries.flatMap(e=>[
      ...clone(e.payload.plateEdit?.sourceCorrectionHistory||[]),
      ...(e.payload.plateEdit?.operations||[]).filter(a=>a.type==='correct-source').map(a=>({
        at:a.at,record:e.name,output:e.payload.packedPlates[a.from].displayName||e.payload.packedPlates[a.from].id,well:a.wells[0],
        before:a.before.sourcePlate+'-'+a.before.sourceWell,after:a.sourcePlate+'-'+a.sourceWell
      }))
    ]);
    data.plateEdit.selectedPlates=clone(selected);
    return {data, selected, name:[...new Set(entries.map(e=>e.name.replace(/_(?:ed|done)$/,'')))].join(' + ').slice(0,117)+'_ed'};
  }
  function cellAt(data, plate, name) {
    if(!Number.isInteger(plate)||!data.packedPlates[plate])throw Error('プレートが見つかりません。');
    const [r,c]=position(name);return data.packedPlates[plate].grid[r][c];
  }
  function setCell(data,plate,name,value){const [r,c]=position(name);data.packedPlates[plate].grid[r][c]=value;}
  function apply(data, action) {
    const next=clone(data), names=[...new Set(action.wells||[])];
    if(!names.length)throw Error('ウェルを選択してください。');
    const values=names.map(w=>cellAt(next,action.from,w));
    if(!values.some(Boolean))throw Error('選択範囲に試料がありません。');
    if(action.type==='correct-source'){
      if(names.length!==1)throw Error('訂正するウェルを1つ選択してください。');
      const cell=values[0], source=action.sourcePlate, target=action.sourceWell;
      position(target);
      if(typeof source!=='string'||String(Number(source))!==source||!next.plates[Number(source)-1])throw Error('入力プレートを選択してください。');
      if(cell.sourcePlate===source&&cell.sourceWell===target)return clone(data);
      for(const [pi,p] of next.packedPlates.entries())for(let r=0;r<8;r++)for(let c=0;c<12;c++){
        const other=p.grid[r][c];
        if(other?.sourcePlate===source&&other.sourceWell===target)throw Error(`入力元 ${source}-${target} は ${p.displayName||p.id} / ${well(r,c)} で使用済みです。`);
      }
      const before={sourcePlate:cell.sourcePlate,sourceWell:cell.sourceWell};
      const old=next.plates[Number(cell.sourcePlate)-1], dest=next.plates[Number(source)-1];
      const phase=dest.growthWeeks?.[target] ?? cell.growthWeek;
      old.wells=old.wells.filter(w=>w!==cell.sourceWell);if(old.growthWeeks)delete old.growthWeeks[cell.sourceWell];
      if(!dest.wells.includes(target))dest.wells.push(target);
      if(phase!==undefined){dest.growthWeeks ||= {};dest.growthWeeks[target]=phase;cell.growthWeek=phase;}
      cell.sourcePlate=source;cell.sourceWell=target;
      action={...action,before};
    }
    else if(action.type==='delete')names.forEach(w=>setCell(next,action.from,w,null));
    else if(action.type==='move'){
      const [ar,ac]=position(action.anchor),[tr,tc]=position(action.target);
      if(!names.includes(action.anchor))throw Error('移動の基準ウェルが選択されていません。');
      const targets=names.map(w=>{const [r,c]=position(w),nr=r+tr-ar,nc=c+tc-ac;if(nr<0||nr>7||nc<0||nc>11)throw Error('移動先がプレートの範囲外です。');return well(nr,nc)});
      const destinations=targets.map(w=>cellAt(next,action.to,w));
      if(names.length===1){
        if(action.from===action.to&&names[0]===targets[0])return clone(data);
        setCell(next,action.from,names[0],destinations[0]);setCell(next,action.to,targets[0],values[0]);
      } else {
        if(destinations.some(Boolean))throw Error('範囲移動は、移動先がすべて空の場合だけ可能です。');
        names.forEach(w=>setCell(next,action.from,w,null));targets.forEach((w,i)=>setCell(next,action.to,w,values[i]));
      }
    } else throw Error('操作が不正です。');
    next.plateEdit.operations.push({...clone(action),at:new Date().toISOString()});
    return next;
  }
  function rectangle(a,b){const [ar,ac]=position(a),[br,bc]=position(b),out=[];for(let r=Math.min(ar,br);r<=Math.max(ar,br);r++)for(let c=Math.min(ac,bc);c<=Math.max(ac,bc);c++)out.push(well(r,c));return out;}
  function complete(selections){
    const result=assemble(selections,{selectedOnly:true,mergeSources:true}),indices=result.selected;
    result.data.packedPlates=indices.map(i=>result.data.packedPlates[i]);
    result.data.plateEdit.initialPackedPlates=clone(result.data.packedPlates);
    result.selected=indices.map((_,i)=>i);result.data.plateEdit.selectedPlates=clone(result.selected);
    result.data.plateEdit.collection='completed';
    result.name=result.name.replace(/_ed$/,'').slice(0,115)+'_done';
    return result;
  }
  function provenance(data){
    const namespaces=[...new Set(data.plates.map(p=>p.sourceOrigin?.namespace||'current'))];
    return data.plates.map((p,i)=>({badge:String.fromCharCode(65+namespaces.indexOf(p.sourceOrigin?.namespace||'current')%26)+(namespaces.indexOf(p.sourceOrigin?.namespace||'current')>=26?Math.floor(namespaces.indexOf(p.sourceOrigin?.namespace||'current')/26)+1:''),label:p.label||'入力 '+(i+1),plate:p.sourceOrigin?.plate||String(i+1)}));
  }
  function catalogKey(entry,index){return originKey(entry.payload.packedPlates[index].outputOrigin||{ref:entry.ref,index})}
  function visible(entry,index,catalog,view){
    const item=catalog[catalogKey(entry,index)]||{status:'active'};
    if(item.status!==view)return false;
    if(item.completed_ref)return entry.ref===item.completed_ref;
    return entry.payload.plateEdit?.collection!=='completed';
  }
  function overviewGroups(entries,catalog){
    const sorted=entries.slice().sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));
    const latest=new Map();
    for(const entry of sorted)for(const [index] of entry.payload.packedPlates.entries()){
      const key=catalogKey(entry,index),state=catalog[key];
      if(entry.payload.plateEdit?.selectedPlates&&!entry.payload.plateEdit.selectedPlates.includes(index)&&!state?.completed_ref)continue;
      if(state?.completed_ref&&state.completed_ref!==entry.ref)continue;
      if(!latest.has(key))latest.set(key,{entry,index});
    }
    return sorted.filter(e=>!e.payload.plateEdit).map(root=>{
      const refs=[root.ref,...root.aliases||[]];
      const items=root.payload.packedPlates.map((_,index)=>{
        const keys=refs.map(ref=>originKey({ref,index}));
        const k=keys.find(k=>catalog[k])||keys.find(k=>latest.has(k))||keys[0];
        return {...latest.get(k)||{entry:root,index},status:catalog[k]?.status||'active',origin:k};
      });
      const completed=items.length>0&&items.every(s=>s.status==='completed');
      const candidate=items[0]?.entry;
      const finalized=completed&&candidate?.payload.plateEdit?.completedGroupRoot===root.ref&&items.every(s=>s.entry.ref===candidate.ref)?candidate:null;
      return {root,items,completed,finalized};
    });
  }
  function completeGroup(group){
    if(!group.completed)throw Error('すべてのプレートを編集完了にしてください。');
    const result=assemble(group.items,{selectedOnly:true,mergeSources:true,groupCompletion:true});
    result.data.packedPlates.sort((a,b)=>a.outputOrigin.index-b.outputOrigin.index);
    result.data.plateEdit.initialPackedPlates=clone(result.data.packedPlates);
    result.selected=result.data.packedPlates.map((_,i)=>i);result.data.plateEdit.selectedPlates=clone(result.selected);
    result.data.plateEdit.collection='completed';
    result.data.plateEdit.completedGroupRoot=group.root.ref;
    result.name=group.root.name.replace(/_(?:ed|done)$/,'').slice(0,117)+'_ed';
    return result;
  }
  return {clone,well,position,dataSignature,deduplicateEntries,assemble,apply,cellAt,rectangle,complete,provenance,plateName,catalogKey,visible,overviewGroups,completeGroup,MAX_SELECTED};
});
