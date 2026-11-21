const test=require('node:test'),assert=require('node:assert/strict');
const extraction=require('../frontend/assets/roi-extraction.js');
test('ROI caps accept only whole counts within the supported range',()=>{
 for(const value of ['48',1,384])assert.equal(extraction.limit(value),Number(value));
 for(const value of ['',0,-1,385,1.5,'bad',null,Infinity])assert.throws(()=>extraction.limit(value),/最大ROI数/);
});
test('sparse extraction keeps source identities by lane id and location, never by array position',()=>{
 const before={grid:{pitch:40},rois:[1,2,3].map(id=>({id,row:0,col:id-1,x:id*40,y:100,sample:'S'+id,well:'A'+id,poolGroup:'Tube1',decision:'auto',platepack:{sourceWell:'A'+id}})),markers:[{row:0,x:0,y:100,confirmed:true}]};
 const next={grid:{pitch:40},rois:[{id:2,row:0,col:1,x:81,y:100,sample:''},{id:3,row:0,col:2,x:120,y:160,sample:''}],markers:[{row:0,x:1,y:100,confirmed:false}]};
 const snapshot=JSON.stringify(before),result=extraction.reconcile(before,next);
 assert.deepEqual(result.kept,[2]);assert.equal(result.config.rois[0].sample,'S2');assert.equal(result.config.rois[0].platepack.sourceWell,'A2');assert.equal(result.config.rois[1].sample,'');assert.equal(result.config.markers[0].confirmed,true);assert.equal(JSON.stringify(before),snapshot);
});
test('the initial extraction dialog requires a valid limit and can be cancelled without extracting',async()=>{
 const elements=Object.fromEntries(['extractionDialog','extractionLimit','extractionForm','cancelExtraction','extractionImage'].map(id=>[id,{focus(){},select(){},setCustomValidity(v){this.error=v;},reportValidity(){},showModal(){this.open=true;},close(){this.open=false;}}]));
 global.document={getElementById:id=>elements[id]};
 try{
  const pending=extraction.ask('test.tif');assert.equal(elements.extractionDialog.open,true);assert.equal(elements.extractionImage.textContent,'test.tif');
  assert.equal(await extraction.ask('other.tif'),null);
  elements.extractionLimit.value='0';elements.extractionForm.onsubmit({preventDefault(){}});assert.match(elements.extractionLimit.error,/最大ROI数/);assert.equal(elements.extractionDialog.open,true);
  elements.extractionLimit.value='48';elements.extractionForm.onsubmit({preventDefault(){}});assert.equal(await pending,48);assert.equal(elements.extractionDialog.open,false);
  const cancelled=extraction.ask('cancel.tif');elements.cancelExtraction.onclick();assert.equal(await cancelled,null);
 }finally{delete global.document;}
});
test('adding missing lane ROIs preserves existing sample and well identities by lane number',()=>{
 const before={grid:{pitch:34},rois:[1,3].map(id=>({id,row:0,col:id-1,x:130+(id-1)*34,y:160,sample:'S'+id,well:'A'+id,decision:'repcr',platepack:{sourceWell:'A'+id}}))};
 const next={grid:{pitch:34},rois:[1,2,3].map(id=>({id,row:0,col:id-1,x:130+(id-1)*34,y:160,sample:'',well:'',decision:'auto'}))};
 const out=extraction.reconcile(before,next);assert.deepEqual(out.config.rois.map(r=>r.id),[1,2,3]);assert.deepEqual(out.kept,[1,3]);assert.equal(out.config.rois[1].sample,'');assert.equal(out.config.rois[1].well,'');assert.equal(out.config.rois[2].sample,'S3');assert.equal(out.config.rois[2].platepack.sourceWell,'A3');assert.equal(out.config.rois[2].decision,'repcr');
});
test('temporary masks normalize drag direction, clip to the image, and stay isolated by image',()=>{
 const rect=extraction.rectangle({x:300,y:180},{x:-20,y:40},250,150);assert.deepEqual(rect,{x:0,y:40,width:250,height:110});
 const masks=extraction.createMasks();assert.equal(masks.add('one',rect),true);assert.deepEqual(masks.get('two'),[]);const copy=masks.get('one');copy[0].x=99;assert.equal(masks.get('one')[0].x,0);
 assert.equal(masks.add('one',{x:1,y:1,width:1,height:50}),false);masks.add('one',{x:10,y:10,width:20,height:20});masks.undo('one');assert.equal(masks.get('one').length,1);masks.clear('one');assert.deepEqual(masks.get('one'),[]);assert.deepEqual(extraction.createMasks().get('one'),[]);
 for(let i=0;i<32;i++)masks.add('one',{x:i,y:0,width:4,height:4});assert.throws(()=>masks.add('one',{x:0,y:0,width:5,height:5}),/32/);
});
