const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../frontend/assets/plate-workspace-tabs.js'),'utf8');
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.style={};this.hidden=false;this.disabled=false;this.listeners={};this.contentWindow={messages:[],postMessage:(data,origin)=>this.contentWindow.messages.push({data,origin})};}
 append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
 setAttribute(key,value){this.attrs[key]=value;}
 remove(){this.parent.children=this.parent.children.filter(n=>n!==this);this.removed=true;}
 addEventListener(type,handler){this.listeners[type]=handler;}
 focus(){this.focused=true;}
 click(){this.onclick?.();}
}
function setup(){
 const elements=Object.fromEntries(['plateWorkspaceTabs','plateWorkspacePanels','recordListPanel'].map(id=>[id,new Element('section')]));
 const handlers={},saved=[],completed=[];let answer=true,uuid=0;
 const window={addEventListener:(type,fn)=>handlers[type]=fn};
 const context=vm.createContext({window,document:{getElementById:id=>elements[id],createElement:tag=>new Element(tag)},crypto:{randomUUID:()=>String(++uuid)},location:{origin:'https://example.test'},confirm:()=>answer});
 vm.runInContext(source,context);const tabs=window.PCRPlateWorkspace({onSaved:p=>saved.push(p),onCompleted:p=>completed.push(p)});
 const frames=()=>elements.plateWorkspacePanels.children.map(p=>p.children[0]);
 const send=(frame,type,data={},origin='https://example.test',token)=>{const key=new URL(frame.src,'https://example.test').searchParams.get('workspace');handlers.message({origin,source:frame.contentWindow,data:{channel:'pcr-plate-workspace',token:token??key,type,...data}});};
 return {tabs,elements,frames,send,saved,completed,handlers,setAnswer:v=>answer=v};
}
const plate=n=>({origin:'root#'+n,name:'plate '+n,index:n,entry:{ref:'root',name:'record'}});
test('reopening the same physical plate activates its existing editor and keeps separate plates alive',()=>{const s=setup();s.tabs.open(plate(0),'project');s.tabs.open(plate(1),'project');const first=s.frames()[0];s.send(first,'state',{dirty:true});s.tabs.showList();s.tabs.open(plate(0),'project');assert.equal(s.frames().length,2);assert.equal(s.frames()[0],first);assert.equal(s.elements.recordListPanel.hidden,true);assert.equal(s.elements.plateWorkspacePanels.children[0].hidden,false);});
test('completion removes only the acknowledged tab and triggers project refresh',()=>{const s=setup();s.tabs.open(plate(0),'project');s.tabs.open(plate(1),'project');const [a,b]=s.frames();s.send(a,'completed');assert.equal(s.frames().length,1);assert.equal(s.frames()[0],b);assert.deepEqual(s.completed,['project']);assert.equal(s.elements.recordListPanel.hidden,true);s.send(b,'completed');assert.equal(s.elements.recordListPanel.hidden,false);assert.equal(s.elements.plateWorkspaceTabs.hidden,true);});
test('messages from another origin or with a wrong token cannot close or save a tab',()=>{const s=setup();s.tabs.open(plate(0),'project');const f=s.frames()[0];s.send(f,'completed',{},'https://foreign.test');s.send(f,'saved',{},'https://example.test','wrong');assert.equal(s.frames().length,1);assert.deepEqual(s.saved,[]);assert.deepEqual(s.completed,[]);});
test('dirty close cancellation retains the editor; accepted close waits for child acknowledgment',()=>{const s=setup();s.tabs.open(plate(0),'project');const f=s.frames()[0];s.send(f,'state',{dirty:true});s.setAnswer(false);const close=s.elements.plateWorkspaceTabs.children[1].children[1];close.click();assert.equal(f.contentWindow.messages.length,0);s.setAnswer(true);close.click();assert.equal(s.frames().length,1);assert.equal(f.contentWindow.messages[0].data.type,'close');s.send(f,'closed');assert.equal(s.frames().length,0);});
test('an editor cannot be closed during a save and dirty tabs warn before leaving the page',()=>{const s=setup();s.tabs.open(plate(0),'project');const f=s.frames()[0];s.send(f,'state',{dirty:true,busy:true});const close=s.elements.plateWorkspaceTabs.children[1].children[1];assert.equal(close.disabled,true);close.click();assert.equal(f.contentWindow.messages.length,0);let prevented=false;const event={preventDefault(){prevented=true;}};s.handlers.beforeunload(event);assert.equal(prevented,true);});
