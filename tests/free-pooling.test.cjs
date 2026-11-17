const test=require('node:test'),assert=require('node:assert/strict'),core=require('../frontend/assets/free-pooling-core.js');
const hash='a'.repeat(64),other='b'.repeat(64);
function session(h=hash){return {image:{sha256:h,name:h.slice(0,1)+'.tif'},config:{roiWidth:20,roiHeight:30,rois:[{id:1,x:20,y:30,decision:'repcr',sample:'same'},{id:2,x:60,y:30,decision:'exclude',sample:'same'},{id:3,x:100,y:30}]},quantification:{results:[{area:100,status:'review',flags:['バンド端がROI外']},{area:1,status:'undetected',flags:['未検出・微弱']},{area:0,status:'undetected'}]}};}
function pool(ids=[1,2,3]){return {...core.create('p','テスト'),keys:ids.map(id=>core.key(hash,id))};}
test('only operator selection determines membership; labels and 1–20 µL limits do not exclude bands',()=>{
 const p=pool(),r=core.calculate(p,[session()]);assert.equal(r.count,3);assert.equal(r.computed,2);assert.equal(r.rows[0].volume,1);assert.equal(r.rows[1].volume,100);assert.equal(r.rows[2].volume,null);assert.match(r.rows[1].note,/範囲外/);assert.match(r.rows[2].note,/面積が0/);
 assert.equal(r.rows[0].label,'repcr');assert.equal(r.rows[1].label,'exclude');assert.equal(r.total,101);
});
test('changing selection, reference band and reference volume updates relative values immediately',()=>{
 const p=pool([1,2]);p.reference='min';p.referenceVolume=2;p.step=0;const r=core.calculate(p,[session()]);assert.equal(r.rows[0].relative,100);assert.equal(r.rows[0].volume,.02);assert.equal(r.rows[1].volume,2);
 p.reference='band:'+core.key(hash,1);assert.equal(core.calculate(p,[session()]).rows[1].volume,200);
 p.keys=[core.key(hash,2)];p.reference='max';assert.equal(core.calculate(p,[session()]).rows[0].volume,2);
});
test('bands from different images and repeat wells stay separate when explicitly selected',()=>{
 const p=pool([1]);p.keys.push(core.key(other,1));const second=session(other);second.quantification.results[0].area=50;const r=core.calculate(p,[session(),second]);assert.equal(r.count,2);assert.deepEqual(r.rows.map(row=>row.volume),[1,2]);
});
test('median reference, rounding and missing or zero bands stay explicit without blocking other rows',()=>{
 const p=pool([1,2]);p.reference='median';p.referenceVolume=1;p.step=.1;let r=core.calculate(p,[session()]);assert.equal(r.reference,50.5);assert.equal(r.rows[0].volume,.5);assert.equal(r.rows[1].volume,50.5);
 p.keys.push('missing:1');r=core.calculate(p,[session()]);assert.equal(r.rows[2].volume,null);assert.match(r.rows[2].note,/なくなりました/);
 const before=JSON.stringify(p);core.calculate(p,[session()]);assert.equal(JSON.stringify(p),before);
});
test('geometry cache ignores labels and metadata but invalidates changed ROI geometry and baselines',()=>{
 const s=session(),key=core.areaKey(s.config);s.config.rois[0].decision='auto';s.config.rois[0].sample='other';assert.equal(core.areaKey(s.config),key);s.config.rois[0].x++;assert.notEqual(core.areaKey(s.config),key);
 s.config.rois[0].x--;s.config.rois[0].baseline=[0,1,29,1];assert.notEqual(core.areaKey(s.config),key);
});
test('saving a configured set keeps all visible settings and ROI selections without clearing the working set',()=>{
 const record={sessions:[session()]},draft=core.working(record);Object.assign(draft,{name:'PCR 1回目',keys:[core.key(hash,1),core.key(hash,2)],reference:'band:'+core.key(hash,2),referenceVolume:'2.5',step:'0.05'});
 const before=core.calculate(draft,record.sessions),saved=core.save(record,'saved-1','2026-11-17T00:00:00Z');
 assert.equal(saved.name,'PCR 1回目');assert.deepEqual(saved.keys,draft.keys);assert.equal(saved.reference,draft.reference);assert.equal(saved.referenceVolume,2.5);assert.equal(saved.step,.05);assert.equal(saved.savedAt,'2026-11-17T00:00:00Z');
 assert.deepEqual(core.calculate(core.working(record),record.sessions),before);assert.equal(core.isSaved(record),true);assert.notEqual(core.working(record),saved);
 const snapshot=JSON.stringify(saved);core.working(record).keys.pop();core.working(record).reference='max';assert.equal(JSON.stringify(saved),snapshot);assert.equal(core.isSaved(record),false);
 core.select(record,'saved-1');assert.deepEqual(core.calculate(core.working(record),record.sessions),before);assert.equal(core.isSaved(record),true);
});
test('a new name creates an independent saved combination; saving the same named set updates it',()=>{
 const record={sessions:[session()]};Object.assign(core.working(record),{name:'first',keys:[core.key(hash,1)],referenceVolume:2});core.save(record,'first','one');
 Object.assign(core.working(record),{name:'second',keys:[core.key(hash,2)],reference:'min',referenceVolume:3,step:0});core.save(record,'second','two');
 assert.equal(record.freePools.length,2);assert.deepEqual(record.freePools[0].keys,[core.key(hash,1)]);assert.equal(record.freePools[0].referenceVolume,2);
 core.working(record).referenceVolume=4;core.save(record,'unused','three');assert.equal(record.freePools.length,2);assert.equal(record.freePools[1].id,'second');assert.equal(record.freePools[1].createdAt,'two');assert.equal(record.freePools[1].savedAt,'three');
 core.select(record,'first');assert.equal(core.working(record).referenceVolume,2);assert.deepEqual(core.working(record).keys,[core.key(hash,1)]);
 const reopened=JSON.parse(JSON.stringify(record));assert.deepEqual(core.working(reopened),core.working(record));
});
test('legacy sets reopen as independent drafts and invalid saves preserve previously saved combinations',()=>{
 const original=pool([1,2]),record={sessions:[session()],freePools:[original],freePoolId:original.id},draft=core.working(record);
 draft.name='';const before=JSON.stringify(record.freePools);assert.throws(()=>core.save(record,'bad','now'),/セット名/);assert.equal(JSON.stringify(record.freePools),before);
 draft.name='valid';draft.referenceVolume=0;assert.throws(()=>core.save(record,'bad','now'),/基準液量/);assert.equal(JSON.stringify(record.freePools),before);
});
