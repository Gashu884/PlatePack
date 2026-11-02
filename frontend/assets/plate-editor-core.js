/* Immutable output-plate edits. Source identities travel with cells. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlateEditor = api;
})(globalThis, function() {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const well = (r,c) => 'ABCDEFGH'[r] + (c+1);
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
  function assemble(selections) {
    if (!selections.length || selections.length>2) throw Error('1〜2枚を選択してください。');
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
          if(JSON.stringify(existing.wells)!==JSON.stringify(p.wells) || JSON.stringify(existing.growthWeeks||{})!==JSON.stringify(p.growthWeeks||{}))throw Error('同じ入力プレートに異なる内容があります。同じ版を選択してください。');
        }
        remap.set(String(i+1),sourceIndices.get(key));
      });
      for (const [index, plate] of (snapshot.packedPlates || []).entries()) {
        grid(plate.grid);
        const origin=plate.outputOrigin || {ref:entry.ref,index};
        const originKey=origin.ref+':'+origin.index;
        if(outputOrigins.has(originKey))throw Error('同じ出力プレートの別の版を同時には編集できません。');
        outputOrigins.add(originKey);
        const copy=clone(plate);copy.outputOrigin=clone(origin);copy.label=plate.label||plate.id||'出力 '+(index+1);
        copy.sourceRecordName=plate.sourceRecordName||entry.name;
        let id=plate.id||'DEST-'+(index+1),suffix=2;
        while(data.packedPlates.some(p=>p.id===id))id=(plate.id||'DEST')+' ('+suffix+++')';
        copy.id=id;
        copy.grid.forEach(row=>row.forEach(cell=>{
          if(!cell)return;
          const mapped=remap.get(cell.sourcePlate);position(cell.sourceWell);
          if(!mapped || !data.plates[Number(mapped)-1].wells.includes(cell.sourceWell))throw Error('元ウェルを確認できない試料があります。');
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
    data.plateEdit.initialPackedPlates=clone(data.packedPlates);
    data.plateEdit.selectedPlates=clone(selected);
    return {data, selected, name:entries.map(e=>e.name.replace(/_ed$/,'')).join(' + ').slice(0,117)+'_ed'};
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
    if(action.type==='delete')names.forEach(w=>setCell(next,action.from,w,null));
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
  return {clone,well,position,assemble,apply,cellAt,rectangle};
});
