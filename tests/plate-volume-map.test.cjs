const test=require('node:test'),assert=require('node:assert/strict'),map=require('../frontend/assets/plate-volume-map.js'),links=require('../frontend/assets/gel-links-core.js');
const hash='a'.repeat(64),hash2='b'.repeat(64);
function fixture(){
 const grid=Array.from({length:8},()=>Array(12).fill(null));grid[7][11]={sourcePlate:'1',sourceWell:'C3'};grid[0][0]={sourcePlate:'1',sourceWell:'D4'};
 const plate={plates:[{uid:'s1',label:'入力A',wells:['C3','D4']}],packedPlates:[{id:'P1',displayName:'出力A',grid}]};
 const rois=[{id:2,platepack:links.resolve(plate,'source','1','C3')},{id:3,platepack:links.resolve(plate,'packed','P1','A1')}];
 const record={plate,sessions:[{image:{sha256:hash},config:{rois}}],links:links.empty('test')};
 const result={rows:[{key:hash+':2',hash,image:'gel.tif',id:2,volume:2.1},{key:hash+':3',hash,image:'gel.tif',id:3,volume:2}]};return {record,result};
}
test('registered source and packed bindings resolve to actual output wells, not ROI positions',()=>{
 const {record,result}=fixture(),before=JSON.stringify({record,result}),out=map.build(result,record);
 assert.equal(out.unplaced.length,0);assert.equal(out.plates.length,1);assert.equal(out.plates[0].name,'出力A');
 assert.equal(out.plates[0].cells.H12[0].volume,2.1);assert.equal(out.plates[0].cells.A1[0].volume,2);assert.equal(out.plates[0].cells.A2,undefined);assert.equal(JSON.stringify({record,result}),before);
});
test('input export preserves the source wells and never substitutes output positions',()=>{
 const {record,result}=fixture(),out=map.build(result,record,{target:'source'});assert.equal(out.plates[0].name,'入力A');assert.equal(out.plates[0].cells.C3[0].volume,2.1);assert.equal(out.plates[0].cells.D4[0].volume,2);
});
test('stale or missing bindings stay visibly unplaced; metadata alone does not invent a physical well',()=>{
 const {record,result}=fixture();record.plate.packedPlates[0].grid[0][0]={sourcePlate:'1',sourceWell:'C3'};
 const out=map.build(result,record);assert.equal(out.plates.length,0);assert.equal(out.unplaced.length,2);
 record.sessions[0].config.rois=[];result.rows[0].well='A2';assert.equal(map.build(result,record).unplaced.length,2);
});
test('explicit ROI layouts keep missing lane numbers, row and column order, and separate image pages',()=>{
 const record={sessions:[]},result={rows:[{hash,image:'gel.tif',id:2,volume:0},{hash,image:'gel.tif',id:97,volume:null},{hash:hash2,image:'other.tif',id:2,volume:3}]};
 const rows=map.build(result,record,{mode:'roi',order:'row'});assert.equal(rows.plates.length,3);assert.equal(rows.plates[0].cells.A2[0].volume,0);assert.equal(rows.plates[1].cells.A1[0].volume,null);assert.match(rows.plates[0].caption,/仮配置/);
 const cols=map.build(result,record,{mode:'roi',order:'column'});assert.equal(cols.plates[0].cells.B1[0].volume,0);
});
test('explicit compact layouts follow selection order across images and paginate at 96 wells',()=>{
 const rows=Array.from({length:97},(_,i)=>({hash:i%2?hash:hash2,image:'gel.tif',id:i%96+1,volume:i}));
 const out=map.build({rows},{sessions:[]},{mode:'compact'});assert.equal(out.plates.length,2);assert.equal(out.plates[0].cells.A1[0].volume,0);assert.equal(out.plates[0].cells.H12[0].volume,95);assert.equal(out.plates[1].cells.A1[0].volume,96);
});
test('multiple chosen bands at the same well retain separate values instead of silently summing',()=>{
 const {record,result}=fixture();record.sessions[0].config.rois[1].platepack=record.sessions[0].config.rois[0].platepack;
 const out=map.build(result,record);assert.deepEqual(out.plates[0].cells.H12.map(row=>row.volume),[2.1,2]);assert.equal(out.plates[0].cells.A1,undefined);
});
test('ambiguous output placement is not arbitrarily assigned to one of several plates',()=>{
 const {record,result}=fixture();record.plate.packedPlates.push({...JSON.parse(JSON.stringify(record.plate.packedPlates[0])),id:'P2'});
 const out=map.build({rows:[result.rows[0]]},record);assert.equal(out.plates.length,0);assert.match(out.unplaced[0].reason,/複数/);
});
