const test=require('node:test'),assert=require('node:assert/strict'),backup=require('../frontend/assets/roi-backup.js'),links=require('../frontend/assets/gel-links-core.js'),pooling=require('../frontend/assets/free-pooling-core.js');
const hash='a'.repeat(64),secondHash='b'.repeat(64);
function fixture(){
 const grid=Array.from({length:8},()=>Array(12).fill(null));grid[7][11]={sourcePlate:'1',sourceWell:'C3'};grid[0][0]={sourcePlate:'1',sourceWell:'D4'};
 const plate={plates:[{uid:'source-uid',label:'入力A',wells:['C3','D4']}],packedPlates:[{id:'P1',displayName:'出力A',grid}]};
 const rois=[{id:2,row:0,col:1,x:60,y:160,sample:'sample2',well:'1-C3',platepack:{...links.resolve(plate,'source','1','C3'),namespace:'stable'},baseline:[0,2,29,3]},{id:3,row:0,col:2,x:95,y:160,sample:'sample3',well:'1-D4',platepack:{...links.resolve(plate,'packed','P1','A1'),namespace:'stable'},decision:'repcr'}];
 const session={image:{sha256:hash,name:'gel.tif',width:1000,height:600},config:{roiWidth:20,roiHeight:30,rois},raw:'AQID',quantification:{results:[{area:100,status:'detected'},{area:50,status:'review',flags:['複数ピーク']}]}};
 const record={version:1,projectId:'project',groupSize:48,name:'保存テスト',sessions:[session],plate,links:links.empty('stable'),active:hash};
 Object.assign(pooling.working(record),{name:'pool',keys:[hash+':2'],reference:'band:'+hash+':2',referenceVolume:2.5,step:.05,minVolume:.5,maxVolume:10});pooling.save(record,'set','set-at');return record;
}
test('portable JSON preserves originals and every ROI/well link, including unselected bands and plate identities',()=>{
 const record=fixture(),before=JSON.stringify(record),out=backup.create(record,'export-at');assert.equal(JSON.stringify(record),before);assert.equal(out.roiBackup.roiMappings.length,2);assert.equal(out.roiBackup.roiMappings[1].roi,3);assert.equal(out.roiBackup.roiMappings[1].measurement.area,50);
 const mapping=out.roiBackup.roiMappings[0];assert.deepEqual(mapping.input,{plate:'入力A',well:'C3'});assert.deepEqual(mapping.output,{plate:'出力A',well:'H12'});assert.deepEqual(mapping.geometry.baseline,[0,2,29,3]);assert.equal(mapping.binding.sourceUid,'source-uid');assert.equal(mapping.binding.namespace,'stable');assert.equal(out.sessions[0].raw,'AQID');
 assert.deepEqual(backup.read(JSON.parse(JSON.stringify(out))),record);
});
test('JSON carries the CSV settings and results alongside the full editable working and saved sets',()=>{
 const record=fixture(),out=backup.create(record,'export-at'),calculation=out.roiBackup.calculations.find(set=>set.kind==='working');
 assert.equal(calculation.settings.referenceVolume,2.5);assert.equal(calculation.settings.step,.05);assert.equal(calculation.settings.minVolume,.5);assert.equal(calculation.settings.maxVolume,10);
 const row=Object.fromEntries(calculation.columns.map((column,i)=>[column,calculation.rows[0][i]]));assert.equal(row['入力well'],'C3');assert.equal(row['出力well'],'H12');assert.equal(row['分注量_µL'],2.5);assert.equal(row['基準ROI'],'gel.tif #2');assert.equal(row['CSV出力日時'],'export-at');
 record.freePoolDraft.referenceVolume=0;const partial=backup.create(record,'later');assert.match(partial.roiBackup.calculations.at(-1).error,/基準液量/);assert.equal(backup.read(partial).freePoolDraft.referenceVolume,0);
});
test('missing or stale well links are retained for inspection without inventing a valid well mapping',()=>{
 const record=fixture();record.plate.plates[0].uid='replaced-source';const out=backup.create(record,'at');assert.equal(out.roiBackup.roiMappings[0].input,null);assert.equal(out.roiBackup.roiMappings[0].output,null);assert.equal(out.roiBackup.roiMappings[0].binding.sourceUid,'source-uid');assert.equal(out.roiBackup.roiMappings[0].well,'1-C3');assert.equal(backup.read(out).sessions[0].config.rois[0].platepack.sourceUid,'source-uid');
});
test('multiple images retain their own ROI identities even when the ROI numbers repeat',()=>{
 const record=fixture(),second=JSON.parse(JSON.stringify(record.sessions[0]));second.image.sha256=secondHash;second.image.name='repeat.tif';second.raw='BAUG';record.sessions.push(second);const out=backup.create(record,'at');assert.equal(out.roiBackup.roiMappings.length,4);const reopened=backup.read(out);assert.equal(reopened.sessions[1].raw,'BAUG');assert.equal(reopened.sessions[1].config.rois[0].id,2);
});
test('inconsistent correspondence, unsupported versions, missing originals, and duplicate ROI IDs fail before applying',()=>{
 const out=backup.create(fixture(),'at');for(const alter of [v=>v.roiBackup.roiMappings[0].well='A1',v=>v.roiBackup.version=2,v=>delete v.sessions[0].raw,v=>v.sessions[0].config.rois.push(v.sessions[0].config.rois[0])]){const bad=JSON.parse(JSON.stringify(out));alter(bad);assert.throws(()=>backup.read(bad));}
 assert.throws(()=>backup.create({...fixture(),sessions:[{...fixture().sessions[0],raw:null}]},'at'),/元画像/);assert.deepEqual(backup.read(fixture()),fixture());
});
test('newer local work is restored only for the same project and never overrides a newer DB record or clean cache',()=>{
 const remote={project_id:'project',updated_at:'2026-11-19T01:00:00Z'},draft={...fixture(),localSavedAt:'2026-11-19T02:00:00Z'};assert.equal(backup.preferLocal(draft,remote),true);assert.equal(backup.preferLocal({...draft,localDraftClean:true},remote),false);assert.equal(backup.preferLocal({...draft,projectId:'other'},remote),false);assert.equal(backup.preferLocal({...draft,localSavedAt:'2026-11-19T00:00:00Z'},remote),false);assert.equal(backup.preferLocal({...draft,localSavedAt:undefined},remote),false);
});
