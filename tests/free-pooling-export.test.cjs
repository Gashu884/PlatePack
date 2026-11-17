const test=require('node:test'),assert=require('node:assert/strict'),core=require('../frontend/assets/free-pooling-core.js'),exporter=require('../frontend/assets/free-pooling-export.js'),links=require('../frontend/assets/gel-links-core.js');
const hash='a'.repeat(64);
function fixture(){
 const grid=Array.from({length:8},()=>Array(12).fill(null));grid[7][11]={sourcePlate:'1',sourceWell:'C3'};grid[0][0]={sourcePlate:'1',sourceWell:'D4'};
 const plate={plates:[{uid:'s1',label:'入力A',wells:['C3','D4']}],packedPlates:[{id:'P1',displayName:'出力A',grid}]};
 const config={rois:[{id:2,platepack:links.resolve(plate,'source','1','C3')},{id:3,platepack:links.resolve(plate,'packed','P1','A1')}]};
 const record={plate,sessions:[{image:{sha256:hash,name:'gel.tif'},config,quantification:{results:[{area:100},{area:200}]}}],links:links.empty('test')};
 Object.assign(core.working(record),{name:'PCR',keys:[hash+':2',hash+':3'],reference:'band:'+hash+':2',referenceVolume:2,step:.1});core.save(record,'set','saved-at');return record;
}
const objects=rows=>rows.slice(1).map(row=>Object.fromEntries(rows[0].map((name,i)=>[name,row[i]])));
test('CSV records actual input-to-output wells and dispensing volume alongside all saved settings',()=>{
 const record=fixture(),before=JSON.stringify(record),rows=objects(exporter.rows(record,core.working(record),'exported-at'));
 assert.equal(rows[0]['入力プレート'],'入力A');assert.equal(rows[0]['入力well'],'C3');assert.equal(rows[0]['出力プレート'],'出力A');assert.equal(rows[0]['出力well'],'H12');assert.equal(rows[0]['分注量_µL'],2);
 assert.equal(rows[1]['入力well'],'D4');assert.equal(rows[1]['出力well'],'A1');assert.equal(rows[1]['分注量_µL'],1);
 for(const row of rows){assert.equal(row['セット名'],'PCR');assert.equal(row['相対値の基準'],'選択したバンド');assert.equal(row['基準ROI'],'gel.tif #2');assert.equal(row['基準面積'],100);assert.equal(row['基準バンド分注量_µL'],2);assert.equal(row['丸め刻み_µL'],.1);assert.equal(row['前回セット保存日時'],'saved-at');assert.equal(row['CSV出力日時'],'exported-at');assert.equal(row['設定保存状態'],'保存済み');assert.deepEqual(JSON.parse(row['選択ROI一覧_JSON']).map(r=>r.roi),[2,3]);}
 assert.equal(JSON.stringify(record),before);
});
test('missing and ambiguous links remain explicit without inventing physical wells',()=>{
 const record=fixture();delete record.sessions[0].config.rois[0].platepack;record.sessions[0].config.rois[0].well='A2';
 let row=objects(exporter.rows(record,core.working(record),'now'))[0];assert.equal(row['入力well'],undefined);assert.equal(row['出力well'],undefined);assert.equal(row['wellメモ'],'A2');assert.match(row['ウェル対応'],/ありません/);assert.equal(row['分注量_µL'],2);
 record.sessions[0].config.rois[0].platepack=links.resolve(record.plate,'source','1','C3');record.plate.packedPlates.push({...JSON.parse(JSON.stringify(record.plate.packedPlates[0])),id:'P2'});
 row=objects(exporter.rows(record,core.working(record),'now'))[0];assert.equal(row['入力well'],'C3');assert.equal(row['出力well'],undefined);assert.match(row['ウェル対応'],/複数/);
});
test('exported settings describe unsaved edits without changing the saved snapshot',()=>{
 const record=fixture(),saved=JSON.stringify(record.freePools);Object.assign(core.working(record),{reference:'median',referenceVolume:3,step:0});
 const row=objects(exporter.rows(record,core.working(record),'now'))[0];assert.equal(row['相対値の基準'],'選択バンドの中央値');assert.equal(row['基準ROI'],'');assert.equal(row['基準面積'],150);assert.equal(row['丸め刻み_µL'],0);assert.equal(row['設定保存状態'],'保存後に変更あり');assert.equal(JSON.stringify(record.freePools),saved);
});
test('CSV quotes commas, line breaks, and formula-like names while retaining the UTF-8 BOM',()=>{
 const record=fixture();core.working(record).name='=x,"a"\nnext';const csv=exporter.csv(record,core.working(record),'now');assert.equal(csv.charCodeAt(0),0xfeff);assert.ok(csv.includes('"\'=x,""a""\nnext"'));assert.ok(csv.includes('"H12"'));assert.ok(csv.includes('"丸め刻み_µL"'));
});
