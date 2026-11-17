const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/../frontend/assets/save-file.js','utf8');
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.style={};}
  append(...nodes){this.children.push(...nodes);}
  showModal(){this.open=true;}
  close(){this.open=false;this.onclose?.();}
  remove(){this.removed=true;}
  click(){this.clicked=true;return this.onclick?.();}
}
function setup(picker){
  const nodes=[],events=[],alerts=[],body=new Element('body');
  const window={};if(picker)window.showSaveFilePicker=picker;
  const context=vm.createContext({window,Blob,fetch:async path=>{events.push('fetch:'+path);return {ok:true,blob:async()=>new Blob(['original'])};},alert:text=>alerts.push(text),document:{body,createElement:tag=>{const n=new Element(tag);nodes.push(n);return n;}},URL:{createObjectURL:()=>{events.push('download');return 'blob:test';},revokeObjectURL(){}},setTimeout:fn=>fn()});
  vm.runInContext(source,context);return {save:window.PCRSaveFile,nodes,events,alerts,body};
}
function writer(){
  const events=[],stream={async write(blob){events.push('write');this.blob=blob;},async close(){events.push('close');},async abort(){events.push('abort');}};
  return {events,stream,handle:{async createWritable(){events.push('open');return stream;}}};
}
const tick=()=>new Promise(setImmediate);
test('opens a picker for every save before asynchronous preparation and preserves file bytes',async()=>{
  const w=writer(),order=[];let picked,release;const s=setup(options=>{order.push('picker');picked=options;return new Promise(resolve=>release=resolve);});
  const pending=s.save.save('計算/結果.csv',async()=>{order.push('prepare');return '\ufeffwell,volume\r\nA1,2';},'text/csv;charset=utf-8');
  assert.deepEqual(order,['picker']);assert.equal(picked.suggestedName,'計算_結果.csv');release(w.handle);
  assert.equal(await pending,true);assert.deepEqual(order,['picker','prepare']);assert.deepEqual(w.events,['open','write','close']);assert.deepEqual(Buffer.from(await w.stream.blob.arrayBuffer()),Buffer.from('\ufeffwell,volume\r\nA1,2'));assert.equal(w.stream.blob.type,'text/csv;charset=utf-8');
  const second=s.save.save('second.json','{}','application/json');assert.deepEqual(order,['picker','prepare','picker']);release(w.handle);await second;assert.equal(s.events.length,0);
});
test('cancelling the picker does not prepare, fetch, or download anything',async()=>{
  const s=setup(async()=>{throw Object.assign(Error('cancel'),{name:'AbortError'});});let prepared=false;
  assert.equal(await s.save.save('test.json',()=>{prepared=true;return '{}';}),false);assert.equal(prepared,false);
  assert.equal(await s.save.url('original.tif','/original'),false);assert.deepEqual(s.events,[]);assert.deepEqual(s.alerts,[]);
});
test('failed writes abort the transaction and report failure without starting a download',async()=>{
  const w=writer();w.stream.write=async()=>{throw Error('容量不足');};const s=setup(async()=>w.handle);
  assert.equal(await s.save.save('test.json','{}'),false);assert.deepEqual(w.events,['open','abort']);assert.match(s.alerts[0],/容量不足/);assert.deepEqual(s.events,[]);
});
test('PNG encoding and original image fetch happen after the picker',async()=>{
  const w=writer();let release,encoded=false;const s=setup(()=>new Promise(resolve=>release=resolve));
  const png=s.save.canvas('plate.png',{toBlob(callback,type){encoded=true;assert.equal(type,'image/png');callback(new Blob(['png'],{type}));}});
  assert.equal(encoded,false);release(w.handle);assert.equal(await png,true);assert.equal(w.stream.blob.type,'image/png');
  const original=s.save.url('gel.tif','/api/original');assert.deepEqual(s.events,[]);release(w.handle);assert.equal(await original,true);assert.deepEqual(s.events,['fetch:/api/original']);assert.equal(await w.stream.blob.text(),'original');
});
test('unsupported browsers show the setting explanation; cancellation starts no download',async()=>{
  const s=setup();let prepared=false;const pending=s.save.save('test.json',()=>{prepared=true;return '{}';});
  const dialog=s.body.children[0];assert.equal(dialog.open,true);assert.match(dialog.children[1].textContent,/設定が無効/);assert.equal(prepared,false);dialog.children[3].children[0].click();assert.equal(await pending,false);assert.equal(prepared,false);assert.deepEqual(s.events,[]);
});
test('browser fallback requires explicit continuation, including security-restricted frames',async()=>{
  const s=setup(async()=>{throw Object.assign(Error('frame'),{name:'SecurityError'});});const pending=s.save.save('test.json','{}','application/json');await tick();
  assert.deepEqual(s.events,[]);const dialog=s.body.children[0];dialog.children[3].children[1].click();assert.equal(await pending,true);assert.deepEqual(s.events,['download']);assert.equal(s.nodes.find(n=>n.tag==='a').download,'test.json');
});
test('multiple files require an individual save click for each destination',async()=>{
  const w=writer(),picked=[];const s=setup(async options=>{picked.push(options.suggestedName);return w.handle;});s.save.many([{name:'1.json',content:'{}'},{name:'2.csv',content:'well'}]);
  const list=s.body.children[0].children[2];assert.deepEqual(picked,[]);await list.children[0].children[1].click();assert.deepEqual(picked,['1.json']);assert.equal(list.children[0].children[2].textContent,' 保存済み');await list.children[1].children[1].click();assert.deepEqual(picked,['1.json','2.csv']);
});
