const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../frontend/assets/plate-editor-core.js');
const links=require('../frontend/assets/gel-links-core.js');
const copy=core.clone;
function entry(ref='raw-one',n=2){
  const plates=[{uid:'original-input',label:'Plate 1',wells:['A1','A2','B1','B2','H12'],growthWeeks:{A1:1,A2:2,B1:3,B2:4,H12:5}}];
  const packedPlates=Array.from({length:n},(_,i)=>({id:'DEST-'+(i+1),columns:Array.from({length:12},(_,c)=>c+1),grid:Array.from({length:8},()=>Array(12).fill(null))}));
  for(const [name,index] of [['A1',0],['A2',1],['B1',2],['B2',3]]){const [r,c]=core.position(name);packedPlates[0].grid[r][c]={sourcePlate:'1',sourceWell:name,growthWeek:index+1,color:'#aa3344'}}
  if(n>1)packedPlates[1].grid[7][11]={sourcePlate:'1',sourceWell:'H12',growthWeek:5};
  return {ref,name:ref,project_id:'project',payload:{version:2,plates,packedPlates}};
}
const setup=()=>core.assemble([{entry:entry(),index:0},{entry:entry(),index:1}]);
const move=(data,from,to,wells,anchor,target)=>core.apply(data,{type:'move',from,to,wells,anchor,target});
const sampleSet=data=>data.packedPlates.flatMap(p=>p.grid.flat().filter(Boolean).map(c=>JSON.stringify(c))).sort();
test('assembly preserves source records and all unselected output plates',()=>{const e=entry(),before=copy(e),s=core.assemble([{entry:e,index:0}]);assert.deepEqual(e,before);assert.equal(s.data.packedPlates.length,2);assert.deepEqual(s.selected,[0]);assert.equal(s.name,'raw-one_ed');assert.deepEqual(s.data.plateEdit.rootRefs,['raw-one']);});
test('single moves and exchanges preserve complete sample and phase identity across plates',()=>{const {data}=setup(),before=copy(data);const a=move(data,0,1,['A1'],'A1','A1');assert.equal(a.packedPlates[0].grid[0][0],null);assert.deepEqual(a.packedPlates[1].grid[0][0],data.packedPlates[0].grid[0][0]);const b=move(a,1,1,['A1'],'A1','H12');assert.equal(b.packedPlates[1].grid[7][11].sourceWell,'A1');assert.equal(b.packedPlates[1].grid[0][0].sourceWell,'H12');assert.deepEqual(sampleSet(b),sampleSet(data));assert.deepEqual(data,before);});
test('a rectangle moves with holes and geometry unchanged',()=>{const {data}=setup(),wells=core.rectangle('A1','B3'),after=move(data,0,1,wells,'A1','D4');assert.equal(after.packedPlates[1].grid[3][3].sourceWell,'A1');assert.equal(after.packedPlates[1].grid[4][4].sourceWell,'B2');assert.equal(after.packedPlates[1].grid[4][5],null);assert.equal(after.packedPlates[0].grid[0][0],null);assert.deepEqual(sampleSet(after),sampleSet(data));});
test('occupied range destination including a selected hole is rejected atomically',()=>{const {data}=setup(),before=copy(data);assert.throws(()=>move(data,0,1,core.rectangle('A1','B3'),'A1','G10'),/すべて空/);assert.deepEqual(data,before);});
test('overlapping occupied ranges and out-of-bounds moves are rejected',()=>{const {data}=setup();assert.throws(()=>move(data,0,0,['A1','A2'],'A1','A2'),/すべて空/);assert.throws(()=>move(data,0,1,['A1','A2'],'A1','H12'),/範囲外/);assert.throws(()=>move(data,0,9,['A1'],'A1','A1'),/見つかりません/);});
test('delete removes output cells only; an immutable snapshot supports undo/reset',()=>{const {data}=setup(),snapshot=copy(data);const after=core.apply(data,{type:'delete',from:0,wells:['A1','A2']});assert.equal(sampleSet(after).length,3);assert.deepEqual(after.plates,data.plates);assert.deepEqual(data,snapshot);assert.equal(sampleSet(snapshot).length,5);assert.equal(after.plateEdit.operations[0].type,'delete');});
test('cross-record editing remaps duplicate display IDs without conflating source identities',()=>{const a=entry('one'),b=entry('two'),s=core.assemble([{entry:a,index:0},{entry:b,index:0}]);assert.deepEqual(s.selected,[0,2]);assert.equal(s.data.plates.length,2);assert.equal(new Set(s.data.packedPlates.map(p=>p.id)).size,4);assert.equal(s.data.packedPlates[2].grid[0][0].sourcePlate,'2');assert.deepEqual(s.data.plateEdit.rootRefs,['one','two']);const moved=move(s.data,0,2,['A1'],'A1','C3');assert.equal(moved.packedPlates[2].grid[2][2].sourcePlate,'1');});
test('same physical plate from raw and edited versions cannot be combined',()=>{const raw=entry(),s=core.assemble([{entry:raw,index:0}]);const edited={ref:'edited',name:s.name,project_id:'project',payload:s.data};assert.throws(()=>core.assemble([{entry:raw,index:0},{entry:edited,index:1}]),/別の版/);});
test('re-editing preserves root lineage and uses one _ed suffix',()=>{const raw=entry(),s=core.assemble([{entry:raw,index:0}]);s.data=move(s.data,0,1,['A1'],'A1','A1');const e={ref:'edited',name:s.name,project_id:'project',payload:s.data};const next=core.assemble([{entry:e,index:1}]);assert.equal(next.name,s.name);assert.deepEqual(next.data.plateEdit.rootRefs,['raw-one']);assert.deepEqual(next.data.plateEdit.parentRefs,['edited']);assert.equal(next.data.plateEdit.operations.length,0);assert.equal(next.data.packedPlates[1].grid[0][0].sourceWell,'A1');});
test('ROI resolves edited destinations and keeps sample identity across experiments and revisions',()=>{const {data}=setup();const moved=move(data,0,1,['A1'],'A1','C3'),id=data.packedPlates[0].id,dest=moved.packedPlates[1].id;const a=links.resolve(data,'packed',id,'A1'),b=links.resolve(moved,'packed',dest,'C3');assert.equal(links.sampleId(links.empty('experiment-one'),a),links.sampleId(links.empty('experiment-two'),b));assert.equal(b.sourceWell,'A1');assert.equal(b.editedOutput,true);assert.throws(()=>links.resolve(moved,'packed',id,'A1'),/検体がありません/);assert.match(links.bindingError(moved,a),/検体がありません/);});
test('edited ROI export displays physical output location with original source retained',()=>{const {data}=setup(),hash='a'.repeat(64),s={image:{sha256:hash,name:'test.tif',width:100,height:80,preview:'data:image/png;base64,AAAA'},config:{roiWidth:10,roiHeight:10,rois:[{id:1,x:25,y:30}]}};let state=links.importSession(links.empty('experiment'),s);state=links.bind(state,data,hash,1,'packed',data.packedPlates[0].id,'A1');const exported=links.exportSession(state,data,s,hash);assert.equal(exported.config.rois[0].well,'DEST-1 / A1');assert.equal(exported.config.rois[0].platepack.sourceWell,'A1');assert.equal(exported.config.rois[0].platepack.sourceNamespace,'raw-one');});
test('more than two plates and cross-project selections are rejected',()=>{const a=entry(),b=entry('two');b.project_id='another';assert.throws(()=>core.assemble([{entry:a,index:0},{entry:b,index:0}]),/同じプロジェクト/);assert.throws(()=>core.assemble(Array(3).fill({entry:a,index:0})),/1〜2/);});
test('many single swaps conserve every sample exactly once',()=>{let {data}=setup();const before=sampleSet(data);for(let i=0;i<80;i++){const candidates=[];data.packedPlates.forEach((p,pi)=>p.grid.forEach((r,ri)=>r.forEach((v,ci)=>{if(v)candidates.push([pi,core.well(ri,ci)])})));const [from,name]=candidates[i%candidates.length];data=move(data,from,i%2,[name],name,core.well(i%8,(i*7)%12));assert.deepEqual(sampleSet(data),before)}});
const correct=(data,from,well,sourcePlate,sourceWell)=>core.apply(data,{type:'correct-source',from,wells:[well],sourcePlate,sourceWell});
test('source correction keeps output position and changes source selection with its phase',()=>{
  const {data}=setup(),before=copy(data),after=correct(data,0,'A1','1','F5');
  assert.deepEqual(data,before);assert.equal(core.cellAt(after,0,'A1').sourceWell,'F5');
  assert.equal(core.cellAt(after,0,'A1').growthWeek,1);assert.equal(sampleSet(after).length,5);
  assert.ok(after.plates[0].wells.includes('F5'));assert.ok(!after.plates[0].wells.includes('A1'));
  assert.equal(after.plates[0].growthWeeks.F5,1);assert.equal(after.plates[0].growthWeeks.A1,undefined);
  assert.deepEqual(after.plateEdit.operations[0].before,{sourcePlate:'1',sourceWell:'A1'});
  assert.deepEqual(after.plateEdit.initialSourcePlates,data.plates);
  assert.equal(links.resolve(after,'packed','DEST-1','A1').sourceWell,'F5');
});
test('source correction rejects duplicates on hidden outputs, invalid wells and range selections atomically',()=>{
  const {data}=setup(),before=copy(data);
  assert.throws(()=>correct(data,0,'A1','1','H12'),/使用済み/);
  assert.throws(()=>correct(data,0,'A1','1','F13'),/不正/);
  assert.throws(()=>correct(data,0,'A1','9','F5'),/入力プレート/);
  assert.throws(()=>core.apply(data,{type:'correct-source',from:0,wells:['A1','A2'],sourcePlate:'1',sourceWell:'F5'}),/1つ/);
  assert.throws(()=>correct(data,0,'H1','1','F5'),/試料がありません/);
  assert.deepEqual(correct(data,0,'A1','1','A1'),data);assert.deepEqual(data,before);
});
test('cross-input correction uses existing target phase and survives save/reopen',()=>{
  const s=core.assemble([{entry:entry('one'),index:0},{entry:entry('two'),index:0}]);
  s.data.plates[1].wells.push('F5');s.data.plates[1].growthWeeks.F5=5;
  const after=correct(s.data,0,'A1','2','F5');
  assert.equal(core.cellAt(after,0,'A1').sourcePlate,'2');assert.equal(core.cellAt(after,0,'A1').growthWeek,5);
  const opened=core.assemble([{entry:{ref:'corrected',name:s.name,project_id:'project',payload:after},index:0}]).data;
  assert.equal(links.resolve(opened,'packed','DEST-1','A1').sourceWell,'F5');
  assert.equal(links.resolve(opened,'packed','DEST-1','A1').sourceNamespace,'two');
});
const updater=require('../frontend/assets/plate-source-update.js');
function correctionExperiment(){
  const {data}=setup(),hash='a'.repeat(64),session={image:{sha256:hash,name:'gel.tif',width:100,height:80,preview:'data:image/png;base64,AAAA'},config:{roiWidth:10,roiHeight:10,rois:[{id:1,x:25,y:30,baseline:{start:1,end:5},poolGroup:'Pool1'}]},quantification:{results:[{area:123}]},measuredConfig:'old'};
  let state=links.importSession(links.empty('experiment'),session);state=links.bind(state,data,hash,1,'packed','DEST-1','A1');
  const record={plate:data,plateRef:'ed-before',plateName:'raw-one_ed',projectId:'project',links:state,sessions:[links.exportSession(state,data,session,hash)],confirmed:{old:true}};
  const revision=core.assemble([{entry:{ref:record.plateRef,name:record.plateName,project_id:record.projectId,payload:data},index:0}]);
  return {record,revision,entry:{ref:'ed-after',name:'raw-one_ed',project_id:'project',payload:correct(revision.data,0,'A1','1','F5')}};
}
test('existing ROI links and all re-PCR measurements follow correction without changing geometry',()=>{
  const {record,entry}=correctionExperiment();const second=copy(record.sessions[0]);second.image.sha256='b'.repeat(64);record.sessions.push(second);
  const gel=copy(record.links.gels[0]);gel.sha256=second.image.sha256;record.links.gels.push(gel);
  const before=copy(record),next=updater.update(record,entry);
  assert.deepEqual(record,before);assert.equal(next.confirmed,null);assert.equal(next.sourceUpdates.length,1);
  for(const session of next.sessions){const roi=session.config.rois[0];assert.equal(roi.platepack.sourceWell,'F5');assert.equal(roi.well,'DEST-1 / A1');assert.equal(roi.sample,'PP:raw-one:original-input:F5');assert.equal(roi.x,25);assert.deepEqual(roi.baseline,{start:1,end:5});assert.equal(roi.poolGroup,'Pool1');assert.equal(session.quantification.results[0].area,123);assert.equal(session.measuredConfig,undefined);}
  assert.equal(next.links.gels[0].rois[0].binding.well,'A1');assert.equal(next.links.gels[0].rois[0].binding.sourceWell,'F5');
  assert.equal(links.bindingError(next.plate,next.links.gels[0].rois[0].binding),'');
});
test('ROI update rejects unrelated revisions, position edits and forged changes',()=>{
  const {record,entry,revision}=correctionExperiment(),before=copy(record);
  const unrelated=copy(entry);unrelated.payload.plateEdit.parentRefs=['another'];assert.throws(()=>updater.update(record,unrelated),/元プレート/);
  const moved={...entry,payload:move(revision.data,0,1,['A1'],'A1','C3')};assert.throws(()=>updater.update(record,moved),/位置変更/);
  const forged=copy(entry);forged.payload.packedPlates[0].grid[0][1]=null;assert.throws(()=>updater.update(record,forged),/履歴/);
  const stale=copy(record);stale.links.gels[0].rois[0].binding.sourceWell='B2';assert.throws(()=>updater.update(stale,entry),/ROI #1/);
  assert.deepEqual(record,before);
});
test('source-kind ROI links follow corrected input and incomplete ROI slots are retained',()=>{
  const {record,entry}=correctionExperiment();record.links.gels[0].rois[0].binding=links.resolve(record.plate,'source','1','A1');
  record.links.gels[0].rois.push({id:2,x:40,y:30,binding:null});record.sessions[0].config.rois.push({id:2,x:40,y:30});
  const next=updater.update(record,entry);assert.equal(next.links.gels[0].rois[0].binding.well,'F5');assert.equal(next.sessions[0].config.rois[0].well,'1-F5');assert.equal(next.links.gels[0].rois[1].binding,null);assert.equal(next.sessions[0].config.rois[1].id,2);
});
