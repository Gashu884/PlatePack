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
test('cross-record editing remaps duplicate display IDs without conflating source identities',()=>{const a=entry('one'),b=entry('two'),s=core.assemble([{entry:a,index:0},{entry:b,index:0}]);assert.deepEqual(s.selected,[0,1]);assert.equal(s.data.plates.length,2);assert.equal(new Set(s.data.packedPlates.map(p=>p.id)).size,2);assert.equal(s.data.packedPlates[1].grid[0][0].sourcePlate,'2');assert.deepEqual(s.data.plateEdit.rootRefs,['one','two']);const moved=move(s.data,0,1,['A1'],'A1','C3');assert.equal(moved.packedPlates[1].grid[2][2].sourcePlate,'1');});
test('same physical plate from raw and edited versions cannot be combined',()=>{const raw=entry(),s=core.assemble([{entry:raw,index:0}]);const edited={ref:'edited',name:s.name,project_id:'project',payload:s.data};assert.throws(()=>core.assemble([{entry:raw,index:0},{entry:edited,index:0}]),/別の版/);});
test('re-editing preserves root lineage and uses one _ed suffix',()=>{const raw=entry(),s=core.assemble([{entry:raw,index:0}]);s.data=move(s.data,0,1,['A1'],'A1','A1');const e={ref:'edited',name:s.name,project_id:'project',payload:s.data};const next=core.assemble([{entry:e,index:1}]);assert.equal(next.name,s.name);assert.deepEqual(next.data.plateEdit.rootRefs,['raw-one']);assert.deepEqual(next.data.plateEdit.parentRefs,['edited']);assert.equal(next.data.plateEdit.operations.length,0);assert.equal(next.data.packedPlates[1].grid[0][0].sourceWell,'A1');});
test('ROI resolves edited destinations and keeps sample identity across experiments and revisions',()=>{const {data}=setup();const moved=move(data,0,1,['A1'],'A1','C3'),id=data.packedPlates[0].id,dest=moved.packedPlates[1].id;const a=links.resolve(data,'packed',id,'A1'),b=links.resolve(moved,'packed',dest,'C3');assert.equal(links.sampleId(links.empty('experiment-one'),a),links.sampleId(links.empty('experiment-two'),b));assert.equal(b.sourceWell,'A1');assert.equal(b.editedOutput,true);assert.throws(()=>links.resolve(moved,'packed',id,'A1'),/検体がありません/);assert.match(links.bindingError(moved,a),/検体がありません/);});
test('edited ROI export displays physical output location with original source retained',()=>{const {data}=setup(),hash='a'.repeat(64),s={image:{sha256:hash,name:'test.tif',width:100,height:80,preview:'data:image/png;base64,AAAA'},config:{roiWidth:10,roiHeight:10,rois:[{id:1,x:25,y:30}]}};let state=links.importSession(links.empty('experiment'),s);state=links.bind(state,data,hash,1,'packed',data.packedPlates[0].id,'A1');const exported=links.exportSession(state,data,s,hash);assert.equal(exported.config.rois[0].well,'raw-one_01 / A1');assert.equal(exported.config.rois[0].platepack.sourceWell,'A1');assert.equal(exported.config.rois[0].platepack.sourceNamespace,'raw-one');});
test('selection limit and cross-project selections are rejected',()=>{const a=entry(),b=entry('two');b.project_id='another';assert.throws(()=>core.assemble([{entry:a,index:0},{entry:b,index:0}]),/同じプロジェクト/);assert.throws(()=>core.assemble(Array(25).fill({entry:a,index:0})),/1〜24/);});
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
  for(const session of next.sessions){const roi=session.config.rois[0];assert.equal(roi.platepack.sourceWell,'F5');assert.equal(roi.well,'raw-one_01 / A1');assert.equal(roi.sample,'PP:raw-one:original-input:F5');assert.equal(roi.x,25);assert.deepEqual(roi.baseline,{start:1,end:5});assert.equal(roi.poolGroup,'Pool1');assert.equal(session.quantification.results[0].area,123);assert.equal(session.measuredConfig,undefined);}
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
test('three groups can be edited with distinct origin badges despite matching input well numbers',()=>{
  const list=['alpha','beta','gamma'].map(ref=>({entry:entry(ref),index:0})),s=core.assemble(list);
  assert.equal(s.selected.length,3);assert.equal(s.data.packedPlates.length,3);
  const origins=core.provenance(s.data);assert.deepEqual(origins.map(p=>p.badge),['A','B','C']);
  let after=move(s.data,0,2,['A1'],'A1','C3');after=move(after,1,2,['A1'],'A1','C4');
  assert.equal(core.cellAt(after,2,'C3').sourceWell,'A1');assert.equal(core.cellAt(after,2,'C4').sourceWell,'A1');
  assert.notEqual(core.cellAt(after,2,'C3').sourcePlate,core.cellAt(after,2,'C4').sourcePlate);
  const opened=core.assemble([{entry:{ref:'saved',name:'mix_ed',project_id:'project',payload:after},index:2}]);
  assert.deepEqual(core.provenance(opened.data),origins);
});
test('completion stores only selected outputs while preserving source identities and ROI links',()=>{
  const e=entry(),before=copy(e),done=core.complete([{entry:e,index:1}]);
  assert.equal(done.data.packedPlates.length,1);assert.equal(done.data.packedPlates[0].id,'DEST-2');
  assert.equal(done.data.packedPlates[0].displayName,'raw-one_02');
  assert.deepEqual(done.data.plateEdit.selectedPlates,[0]);assert.equal(done.data.plateEdit.collection,'completed');
  assert.equal(done.name,'raw-one_done');assert.deepEqual(e,before);
  assert.equal(links.resolve(done.data,'packed','DEST-2','H12').sourceWell,'H12');
});
test('hidden and completed views track physical origins across versions and restore the completed file',()=>{
  const raw=entry(),done=core.complete([{entry:raw,index:0}]);
  const e={ref:'done',name:done.name,project_id:'project',payload:done.data},key=core.catalogKey(raw,0);
  assert.equal(core.catalogKey(e,0),key);assert.equal(core.visible(raw,0,{},'active'),true);
  let catalog={[key]:{status:'hidden',completed_ref:null}};
  assert.equal(core.visible(raw,0,catalog,'active'),false);assert.equal(core.visible(raw,0,catalog,'hidden'),true);
  catalog[key]={status:'completed',completed_ref:'done'};
  assert.equal(core.visible(raw,0,catalog,'active'),false);assert.equal(core.visible(raw,0,catalog,'completed'),false);assert.equal(core.visible(e,0,catalog,'completed'),true);
  assert.equal(core.visible(raw,1,catalog,'active'),true);
  catalog[key].status='active';assert.equal(core.visible(e,0,catalog,'active'),true);assert.equal(core.visible(raw,0,catalog,'active'),false);
});
test('display names use record name and two digits without changing existing link keys',()=>{
  const e=entry('PlateName',12);assert.equal(core.plateName(e,0),'PlateName_01');assert.equal(core.plateName(e,9),'PlateName_10');assert.equal(core.plateName(e,10),'PlateName_11');
  const assembled=core.assemble([{entry:e,index:9}]);assert.equal(assembled.data.packedPlates[9].id,'DEST-10');
  e.payload.packedPlates[9].displayName='Custom_10';assert.equal(core.plateName(e,9),'Custom_10');
});
test('source-only revisions saved before display names remain applicable',()=>{
  const {record,entry}=correctionExperiment();for(const p of entry.payload.packedPlates)delete p.displayName;for(const p of entry.payload.plateEdit.initialPackedPlates)delete p.displayName;
  assert.equal(updater.update(record,entry).links.gels[0].rois[0].binding.sourceWell,'F5');
});
test('different chosen outputs can be merged from files that share unselected history',()=>{
  const raw=entry(),s=core.assemble([{entry:raw,index:0}]);
  const edited={ref:'ed-shared',name:s.name,project_id:'project',payload:s.data};
  const done=core.complete([{entry:edited,index:1}]);
  const combined=core.assemble([{entry:edited,index:0},{entry:{ref:'completed',name:done.name,project_id:'project',payload:done.data},index:0}]);
  assert.equal(combined.data.packedPlates.length,2);assert.equal(sampleSet(combined.data).length,5);
  const changed=move(combined.data,0,1,['A1'],'A1','C3');assert.equal(core.cellAt(changed,1,'C3').sourceWell,'A1');
});

test('overview stays under original group until every physical output is completed',()=>{
  const raw=entry('1-1_20261023',3),saved=core.assemble([{entry:raw,index:0}],{selectedOnly:true});
  saved.data=core.apply(saved.data,{type:'delete',from:0,wells:['A1']});
  const edit={ref:'draft',name:'1-1_20261023_ed',created_at:'2026-11-02',project_id:'project',payload:saved.data};
  let [group]=core.overviewGroups([raw,edit],{});
  assert.equal(group.root.name,'1-1_20261023');assert.equal(group.items.length,3);assert.equal(group.items[0].entry.ref,'draft');assert.equal(group.completed,false);
  assert.equal(group.items[0].entry.payload.packedPlates[0].grid[0][0],null);
  const state={'1-1_20261023#0':{status:'completed',completed_ref:'draft'}};
  [group]=core.overviewGroups([raw,edit],state);
  assert.equal(group.completed,false);assert.equal(group.items[0].status,'completed');assert.equal(group.items[1].status,'active');
  assert.throws(()=>core.completeGroup(group),/すべて/);
  state['1-1_20261023#1']={status:'hidden'};state['1-1_20261023#2']={status:'completed'};
  assert.equal(core.overviewGroups([raw,edit],state)[0].completed,false);
});

test('final completed group merges separately finished plates in original order into one _ed file',()=>{
  const raw=entry('experiment',3);
  const first=core.complete([{entry:raw,index:0},{entry:raw,index:2}]);
  const second=core.complete([{entry:raw,index:1}]);
  const a={ref:'done-a',name:first.name,project_id:'project',created_at:'2',payload:first.data};
  const b={ref:'done-b',name:second.name,project_id:'project',created_at:'3',payload:second.data};
  const state=Object.fromEntries([0,1,2].map(i=>['experiment#'+i,{status:'completed',completed_ref:i===1?'done-b':'done-a'}]));
  const [group]=core.overviewGroups([raw,a,b],state),result=core.completeGroup(group);
  assert.equal(result.name,'experiment_ed');assert.equal(result.data.plateEdit.completedGroupRoot,'experiment');
  assert.deepEqual(result.data.packedPlates.map(p=>p.outputOrigin.index),[0,1,2]);
  assert.deepEqual(result.data.plateEdit.initialPackedPlates,result.data.packedPlates);
  assert.equal(result.data.packedPlates.flatMap(p=>p.grid.flat()).filter(Boolean).length,5);
  const final={ref:'final',name:result.name,project_id:'project',created_at:'4',payload:result.data};
  Object.values(state).forEach(s=>s.completed_ref='final');
  assert.equal(core.overviewGroups([raw,a,b,final],state)[0].finalized.ref,'final');
  state['experiment#0'].status='active';
  const reopened=core.overviewGroups([raw,a,b,final],state)[0];
  assert.equal(reopened.completed,false);assert.equal(reopened.items[0].entry.ref,'final');
});

test('groups remain separate after cross-group well moves and completion',()=>{
  const a=entry('group-a',1),b=entry('group-b',1),joined=core.assemble([{entry:a,index:0},{entry:b,index:0}]);
  joined.data=move(joined.data,0,1,['A1'],'A1','C3');
  const edit={ref:'combined',name:'group-a + group-b_ed',project_id:'project',created_at:'2',payload:joined.data};
  const states={'group-a#0':{status:'completed',completed_ref:'combined'}};
  const groups=core.overviewGroups([a,b,edit],states);
  assert.equal(groups.length,2);assert.equal(groups.find(g=>g.root.ref==='group-a').completed,true);
  const active=groups.find(g=>g.root.ref==='group-b');assert.equal(active.completed,false);assert.equal(active.items[0].entry.ref,'combined');
  assert.equal(active.items[0].entry.payload.packedPlates[1].grid[2][2].sourcePlate,'1');
});

test('completion supports large groups and corrected sources from different saved revisions',()=>{
  const raw=entry('many',30),first=core.assemble([{entry:raw,index:0}],{selectedOnly:true});
  first.data=correct(first.data,0,'A1','1','F5');
  const corrected={ref:'corrected',name:'many_ed',project_id:'project',created_at:'2',payload:first.data};
  const states=Object.fromEntries(Array.from({length:30},(_,i)=>['many#'+i,{status:'completed',completed_ref:i===0?'corrected':raw.ref}]));
  const result=core.completeGroup(core.overviewGroups([raw,corrected],states)[0]);
  assert.equal(result.data.packedPlates.length,30);
  assert.equal(result.data.packedPlates[0].grid[0][0].sourceWell,'F5');
  assert.equal(result.data.packedPlates[1].grid[7][11].sourceWell,'H12');
  assert.equal(result.data.plates.length,1);
  assert.equal(links.resolve(result.data,'packed',result.data.packedPlates[0].id,'A1').sourceNamespace,'many');
});

test('an unchanged historical output in a newer draft cannot replace its latest saved placement',()=>{
  const raw=entry('original'),one=core.assemble([{entry:raw,index:1}]),two=core.assemble([{entry:raw,index:0}]);
  one.data=move(one.data,1,1,['H12'],'H12','C3');
  const a={ref:'saved-one',name:'original_ed',project_id:'project',created_at:'1',payload:one.data};
  const b={ref:'saved-two',name:'original_ed',project_id:'project',created_at:'2',payload:two.data};
  const [group]=core.overviewGroups([raw,a,b],{});
  assert.equal(group.items[0].entry.ref,'saved-two');
  assert.equal(group.items[1].entry.ref,'saved-one');
  assert.equal(group.items[1].entry.payload.packedPlates[1].grid[2][2].sourceWell,'H12');
});
