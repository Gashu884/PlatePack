const test=require('node:test'),assert=require('node:assert/strict');
const checks=require('../frontend/assets/electrophoresis-checks.js');
function fixture(){const s={image:{sha256:'a'.repeat(64)},config:{roiWidth:20,rois:[{id:1,x:40,y:50,sample:'stable-id',poolGroup:'Tube1',baseline:[0,10,20,10]}]},quantification:{version:'v1'},measuredVersion:'v1'};s.measuredConfig=checks.key(s.config);return {plate:{plates:[{uid:'p',wells:['A1']}]},links:{gels:[]},groupSize:48,sessions:[s]}}
test('ROI, baseline, identity and tube edits invalidate completed measurement and pool signature',()=>{
 for(const edit of [s=>s.config.rois[0].x++,s=>s.config.rois[0].baseline[1]++,s=>s.config.rois[0].sample='other',s=>s.config.rois[0].poolGroup='Tube2',s=>s.config.roiWidth++]){
  const r=fixture(),before=checks.signature(r);assert.equal(checks.measured(r.sessions[0]),true);edit(r.sessions[0]);assert.equal(checks.measured(r.sessions[0]),false);assert.notEqual(checks.signature(r),before);
 }
});
test('algorithm changes invalidate measurement even with unchanged pixels and ROI geometry',()=>{const r=fixture(),s=r.sessions[0],before=checks.signature(r);s.quantification.version='v2';assert.equal(checks.measured(s),false);assert.equal(checks.measured(s,'v2'),false);assert.notEqual(checks.signature(r),before)});
test('well mapping and group size changes invalidate approval',()=>{for(const change of [r=>r.plate.plates[0].uid='replacement',r=>r.links.gels.push({roi:1,well:'A2'}),r=>r.groupSize=24]){const r=fixture(),before=checks.signature(r);change(r);assert.notEqual(checks.signature(r),before)}});
test('serialization and key-order changes preserve measurement; display brightness is not quantitative',()=>{const r=fixture(),before=checks.signature(r),s=r.sessions[0];r.sessions[0]=JSON.parse(JSON.stringify(s));assert.equal(checks.signature(r),before);s.config={rois:s.config.rois,roiWidth:s.config.roiWidth};assert.equal(checks.measured(s),true);r.brightness=3;assert.equal(checks.signature(r),before)});
test('missing measurement version or evidence never counts as measured',()=>{const s=fixture().sessions[0];delete s.measuredVersion;assert.equal(checks.measured(s),false);delete s.measuredConfig;assert.equal(checks.measured(s),false)});
