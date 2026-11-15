/* Project-local tabs keep independent editors alive while the list stays in place. */
window.PCRPlateWorkspace = ({onSaved,onCompleted}) => {
  const bar=document.getElementById('plateWorkspaceTabs'),panels=document.getElementById('plateWorkspacePanels'),list=document.getElementById('recordListPanel');
  const tabs=new Map();let active=null,project=null,serial=0;
  const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const listTab=node('button','workspace-tab','一覧');listTab.type='button';listTab.id='workspace-list-tab';listTab.setAttribute('role','tab');listTab.setAttribute('aria-controls',list.id);list.setAttribute('aria-labelledby',listTab.id);listTab.onclick=()=>activate(null);bar.append(listTab);
  function render(){
    bar.hidden=![...tabs.values()].some(t=>t.project===project);list.hidden=active!==null;
    listTab.setAttribute('aria-selected',String(active===null));listTab.tabIndex=active===null?0:-1;
    for(const tab of tabs.values()){
      tab.holder.hidden=tab.project!==project;tab.panel.hidden=tab.id!==active;
      tab.button.setAttribute('aria-selected',String(tab.id===active));tab.button.tabIndex=tab.id===active?0:-1;
      tab.button.textContent=(tab.dirty?'● ':'')+tab.name;tab.close.disabled=tab.closing||tab.busy;
    }
  }
  function activate(id){active=id;render();if(id!==null)bar.scrollIntoView?.({block:'start'});}
  function remove(tab){tabs.delete(tab.id);tab.holder.remove();tab.panel.remove();if(active===tab.id)active=null;render();}
  function close(tab){
    if(tab.closing||tab.busy)return;
    if(tab.dirty&&!confirm('未保存の変更があります。このタブを閉じますか？'))return;
    if(!tab.frame||!tab.ready){remove(tab);return;}
    tab.closing=true;render();tab.frame.contentWindow.postMessage({channel:'pcr-plate-workspace',token:tab.token,type:'close'},location.origin);
  }
  function openFrame({id,projectId,name,title,path}){
    if(tabs.has(id)){project=projectId;activate(id);return;}
    const token=crypto.randomUUID(),holder=node('div','workspace-tab-holder'),button=node('button','workspace-tab',name),cross=node('button','workspace-tab-close','×'),panel=node('section','workspace-editor-panel'),frame=node('iframe','workspace-editor-frame');
    const n=++serial;button.id='plate-workspace-tab-'+n;button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-controls','plate-workspace-panel-'+n);button.title=title;
    panel.id='plate-workspace-panel-'+n;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);
    cross.type='button';cross.setAttribute('aria-label',name+' のタブを閉じる');holder.append(button,cross);bar.append(holder);
    frame.title=title;frame.src=path+'&embedded=1&workspace='+encodeURIComponent(token);panel.append(frame);panels.append(panel);
    const tab={id,project:projectId,name,token,holder,button,close:cross,panel,frame,dirty:false,busy:false,ready:false,closing:false};tabs.set(id,tab);button.onclick=()=>activate(id);cross.onclick=()=>close(tab);project=projectId;activate(id);
  }
  function open(item,projectId){
    openFrame({id:projectId+':'+item.origin,projectId,name:item.name,title:item.name+' の編集',path:'/output-plates?project='+encodeURIComponent(projectId)+'&log='+encodeURIComponent(item.entry.ref)+'&plate='+item.index});
  }
  function openAnalysis(item,projectId,attachment){
    const ref=item.entry.ref,key=attachment?'image:'+item.origin+':'+attachment.id:'record:'+ref;
    openFrame({id:projectId+':analysis:'+key,projectId,name:'定量 · '+(attachment?.name||item.name),title:(attachment?.name||item.name)+' のバンド定量',path:'/electrophoresis?project='+encodeURIComponent(projectId)+'&log='+encodeURIComponent(ref)+(attachment?'&plate='+item.index+'&attachment='+encodeURIComponent(attachment.id):'')});
  }
  function openUpload(item,projectId){
    const id=projectId+':upload:'+item.origin;
    if(tabs.has(id)){project=projectId;activate(id);return;}
    const name='画像登録 · '+item.name,holder=node('div','workspace-tab-holder'),button=node('button','workspace-tab',name),cross=node('button','workspace-tab-close','×'),panel=node('section','workspace-editor-panel');
    const n=++serial;button.id='plate-workspace-tab-'+n;button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-controls','plate-workspace-panel-'+n);button.title=name;
    panel.id='plate-workspace-panel-'+n;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);cross.type='button';cross.setAttribute('aria-label',name+' のタブを閉じる');holder.append(button,cross);bar.append(holder);panels.append(panel);
    const tab={id,project:projectId,name,holder,button,close:cross,panel,dirty:false,busy:false,ready:true,closing:false};tabs.set(id,tab);button.onclick=()=>activate(id);cross.onclick=()=>close(tab);project=projectId;activate(id);
    PCRGelRegistration({host:panel,item,projectId,onState:state=>{Object.assign(tab,state);render();},onSaved:()=>onSaved?.(projectId),onAnalyze:image=>openAnalysis(item,projectId,image)});
  }
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.data?.channel!=='pcr-plate-workspace')return;
    const tab=[...tabs.values()].find(t=>t.frame&&t.frame.contentWindow===event.source&&t.token===event.data.token);if(!tab)return;
    const data=event.data;
    if(data.type==='state'){tab.ready=true;tab.dirty=!!data.dirty;tab.busy=!!data.busy;render();}
    if(data.type==='height'&&Number.isFinite(data.height))tab.frame.style.height=Math.max(680,Math.min(1800,data.height))+'px';
    if(data.type==='close-request')close(tab);
    if(data.type==='closed')remove(tab);
    if(data.type==='close-blocked'){tab.closing=false;render();}
    if(data.type==='saved'){tab.dirty=false;render();onSaved?.(tab.project);}
    if(data.type==='completed'){tab.dirty=false;remove(tab);onCompleted?.(tab.project);}
  });
  bar.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const buttons=[listTab,...[...tabs.values()].filter(t=>t.project===project).map(t=>t.button)],i=buttons.indexOf(event.target);if(i<0)return;
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    event.preventDefault();buttons[next].click();buttons[next].focus();
  });
  window.addEventListener('beforeunload',event=>{if([...tabs.values()].some(t=>t.dirty)){event.preventDefault();event.returnValue='';}});
  return {open,openAnalysis,openUpload,showProject(id){project=id;if(active&&tabs.get(active)?.project!==id)active=null;render();},showList(){activate(null);}};
};
