const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/../frontend/assets/gel-registration-tab.js','utf8');
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.attrs={};const classes=new Set();this.classList={add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v)};}
 append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(k,v){this.attrs[k]=v;}
 contains(n){return n===this||this.children.some(c=>c.contains(n));}
 click(){return this.onclick?.();}
}
async function setup(){
 const host=new Element('main'),states=[],calls=[],uploads=[],saved=[],analyzed=[],images=[];let upload=async file=>{uploads.push(file);return 'hash';};
 const context=vm.createContext({window:{},document:{createElement:tag=>new Element(tag)},PCRWorkflowAPI:{upload:(...args)=>upload(...args),request:async(path,data)=>{calls.push({path,data});if(data){images.push({id:'image',name:data.name,origin_key:'root#1'});return images.at(-1);}return images;}}});
 vm.runInContext(source,context);context.window.PCRGelRegistration({host,item:{name:'plate',origin:'root#1',index:1,entry:{ref:'root'}},projectId:'project',onState:s=>states.push({...s}),onSaved:()=>saved.push(true),onAnalyze:i=>analyzed.push(i)});
 await new Promise(setImmediate);
 const box=host.children[0],find=cls=>box.children.find(c=>c.className===cls),form=find('gel-registration-form');
 return {box,drop:find('gel-registration-drop'),form,input:form.children[1],submit:form.children[3],status:find('gel-registration-status'),list:find('gel-registration-images'),states,calls,uploads,saved,analyzed,setUpload:fn=>upload=fn};
}
const file=(name='gel.tif')=>({name,size:100});
const event=files=>({dataTransfer:{files},clipboardData:{files},preventDefault(){this.prevented=true;}});
test('dropping a TIFF uploads and attaches it to this physical plate without submitting again',async()=>{
 const s=await setup(),f=file(),e=event([f]);await s.box.ondrop(e);
 assert.equal(e.prevented,true);assert.deepEqual(s.uploads,[f]);const attach=s.calls.find(c=>c.data);assert.equal(attach.path,'/api/workflow/attachments');assert.equal(attach.data.ref,'root');assert.equal(attach.data.index,1);assert.equal(attach.data.name,'gel.tif');
 assert.equal(s.saved.length,1);assert.equal(s.states.at(-1).busy,false);assert.equal(s.states.at(-1).dirty,false);assert.equal(s.submit.disabled,true);
 s.list.children[0].children[2].click();assert.equal(s.analyzed[0].id,'image');
});
test('choosing a file waits for registration; clipboard images register immediately',async()=>{
 const s=await setup();s.input.files=[file('chosen.png')];s.input.onchange();assert.equal(s.uploads.length,0);assert.equal(s.states.at(-1).dirty,true);
 await s.form.onsubmit(event([]));assert.equal(s.uploads[0].name,'chosen.png');
 const e=event([file('pasted.png')]);await s.box.onpaste(e);assert.equal(e.prevented,true);assert.equal(s.uploads[1].name,'pasted.png');assert.equal(s.saved.length,2);
});
test('invalid, oversized and multiple drops cannot create attachments',async()=>{
 const s=await setup();for(const files of [[file('photo.jpg')],[{name:'large.tif',size:97*1024*1024}],[file(),file('other.tif')],[]])await s.box.ondrop(event(files));
 assert.equal(s.uploads.length,0);assert.equal(s.calls.some(c=>c.data),false);assert.equal(s.states.at(-1).dirty,false);
});
test('a second drop cannot replace the file being saved, and failures can be retried',async()=>{
 const s=await setup();let release;s.setUpload(()=>new Promise(resolve=>release=resolve));
 const first=s.box.ondrop(event([file('first.tif')]));assert.equal(s.states.at(-1).busy,true);
 await s.box.ondrop(event([file('second.tif')]));release('first-hash');await first;assert.equal(s.calls.find(c=>c.data).data.name,'first.tif');
 s.setUpload(async()=>{throw Error('転送エラー');});await s.box.ondrop(event([file('retry.tif')]));assert.equal(s.status.textContent,'転送エラー');assert.equal(s.states.at(-1).dirty,true);assert.equal(s.states.at(-1).busy,false);
 s.setUpload(async()=> 'retry-hash');await s.form.onsubmit(event([]));assert.equal(s.saved.length,2);assert.equal(s.states.at(-1).dirty,false);
});
