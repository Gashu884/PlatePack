(() => {
  'use strict';
  const $=id=>document.getElementById(id), params=new URLSearchParams(location.search), api=PCRWorkflowAPI.request;
  let folders=[],current=params.get('project')||params.get('member'),selected=null,entries=[],catalog={},attachments=[],view=['input','active','completed','hidden'].includes(params.get('state'))?params.get('state'):'active',generation=0,loading=false;
  const workspace=PCRPlateWorkspace({onSaved:project=>{if(project===current)loadRecords();},onCompleted:project=>{if(project===current){loadRecords();notice('編集完了にしました。');}}});
  const folder=id=>folders.find(f=>f.id===id);
  const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const notice=text=>$('projectNotice').textContent=text;
  const url=id=>{const f=folder(id);return f?'/?'+(f.kind==='project'?'project':'member')+'='+encodeURIComponent(id)+(f.kind==='project'?'&state='+view:''):'/';};
  const key=item=>item.entry?item.kind+':'+item.entry.ref+':'+(item.index??''):item.id;
  async function navigate(id,push=true){current=id;selected=null;$('projectSearch').value='';if(push)history.pushState(null,'',url(id));await loadRecords();}
  function treeButton(f){const b=node('button','tree-item '+f.kind);b.type='button';b.classList.toggle('active',current===f.id);b.append(node('span','folder-icon'),node('span','folder-name',f.name));b.onclick=()=>navigate(f.id);return b;}
  function open(item){
    if(!item.entry){navigate(item.id);return;}
    if(item.kind==='plate'){workspace.open(item,current);return;}
    if(item.kind==='group'){const plates=PCRWorkflow.rows(entries,catalog,view,PlateEditor).filter(i=>i.kind==='plate'&&i.groupRef===item.entry.ref);for(const plate of plates.slice(0,24))workspace.open(plate,current);if(plates.length>24)notice('一度に開けるのは24枚までです。残りは各プレートから開いてください。');return;}
    const path=item.kind==='input'?'/plates':item.kind==='analysis'?'/electrophoresis':'/output-plates';
    location.href=path+'?project='+encodeURIComponent(current)+'&log='+encodeURIComponent(item.entry.ref)+(item.index!==undefined?'&plate='+item.index:'');
  }
  function select(item){selected=item;document.querySelectorAll('#projectList tr').forEach(r=>r.setAttribute('aria-selected',String(r.dataset.key===key(item))));$('openFolder').disabled=false;$('renameFolder').disabled=item.kind==='plate';}
  async function guarded(action){try{await action();}catch(e){notice(e.message);}}
  function action(label,fn,cls='row-open'){const b=node('button',cls,label);b.type='button';b.onclick=e=>{e.stopPropagation();b.disabled=true;guarded(fn).finally(()=>b.disabled=false);};return b;}
  async function setState(item,status){
    const selections=[{ref:item.entry.ref,index:item.index}];
    if(item.entry.ref.startsWith('local:'))await PlatePackStorage.setOutputPlateStates(current,selections,status);
    else await api('/api/output-plates/states',{project_id:current,selections,status});
    await loadRecords();
  }
  async function complete(item){
    const result=PlateEditor.complete([{entry:item.entry,index:item.index}]);
    await api('/api/logs',{name:result.name,project_id:current,payload:result.data});await loadRecords();
  }
  function photos(item,host){
    const menu=node('details','attachment-menu'),summary=node('summary','','＋');summary.title='プレートに追加';summary.setAttribute('aria-label',item.name+' に追加');menu.append(summary);
    const input=node('input');input.type='file';input.accept='.tif,.tiff,.png,image/png,image/tiff';input.hidden=true;
    const choose=action('泳動写真を登録',()=>{input.click();menu.open=false;});menu.append(choose,input);host.append(menu);
    input.onchange=()=>guarded(async()=>{
      const file=input.files[0];if(!file)return;if(item.entry.ref.startsWith('local:'))throw Error('画像を添付する前に、この記録をDBへ登録してください。');
      choose.disabled=true;notice('画像を保存中…');try{const hash=await PCRWorkflowAPI.upload(file,(n,total)=>notice('画像を保存中… '+n+'/'+total));await api('/api/workflow/attachments',{ref:item.entry.ref,index:item.index,name:file.name,sha256:hash});await loadRecords();notice('泳動写真を保存しました。');}finally{choose.disabled=false;input.value='';}
    });
  }
  function plateDetails(item,name){
    const images=attachments.filter(a=>a.origin_key===item.origin),analyses=entries.filter(e=>PCRWorkflow.analysisMatches(e,item));
    if(!images.length&&!analyses.length)return;
    const details=node('details','plate-attachments');details.append(node('summary','',images.length+'画像'+(analyses.length?'・解析 '+analyses.length:' ')));
    for(const image of images){const line=node('div','attachment-line');const download=node('a','',image.name);download.href='/api/workflow/attachments/'+encodeURIComponent(image.id)+'/file';download.download=image.name;
      const analyze=node('a','','定量を開く');analyze.href='/electrophoresis?project='+encodeURIComponent(current)+'&log='+encodeURIComponent(item.entry.ref)+'&plate='+item.index+'&attachment='+encodeURIComponent(image.id);line.append(download,analyze);details.append(line);}
    for(const e of analyses){const a=node('a','attachment-line','解析：'+e.name);a.href='/electrophoresis?project='+encodeURIComponent(current)+'&log='+encodeURIComponent(e.ref);details.append(a);}
    details.onclick=e=>e.stopPropagation();details.ondblclick=e=>e.stopPropagation();name.append(details);
  }
  function plateCard(item){
    const card=node('article','compact-plate-card'),button=node('button','compact-plate-open');button.type='button';button.setAttribute('aria-label',item.name+' を編集');button.title=item.name;
    const plate=item.entry.payload.packedPlates[item.index],mini=node('span','compact-plate-grid');mini.setAttribute('aria-hidden','true');
    for(const cell of plate.grid.flat()){const well=node('span',cell?'filled':'');if(cell?.color&&/^#[a-f0-9]{6}$/i.test(cell.color))well.style.backgroundColor=cell.color;mini.append(well);}
    button.append(node('span','compact-plate-name',item.name),mini,node('span','compact-plate-count',plate.grid.flat().filter(Boolean).length+'/96'));button.onclick=()=>open(item);card.append(button);
    const tools=node('div','compact-plate-tools');photos(item,tools);
    if(view==='hidden'||view==='completed')tools.append(action('作業中に戻す',()=>setState(item,'active')));else tools.append(action('非表示',()=>setState(item,'hidden')));
    if(view==='completed')tools.append(action('非表示',()=>setState(item,'hidden')));
    card.append(tools);plateDetails(item,card);return card;
  }
  function render(){
    const f=folder(current),isProject=f?.kind==='project';workspace.showProject(isProject?current:null);$('projectTree').replaceChildren();
    const sorted=items=>items.sort((a,b)=>a.name.localeCompare(b.name,'ja'));
    for(const member of sorted(folders.filter(f=>f.kind==='person'))){$('projectTree').append(treeButton(member));for(const project of sorted(folders.filter(f=>f.parent_id===member.id&&f.kind==='project')))$('projectTree').append(treeButton(project));}
    const path=[{id:null,name:'ホーム'}];if(isProject&&folder(f.parent_id))path.push(folder(f.parent_id));if(f)path.push(f);
    $('finderPath').replaceChildren();path.forEach((part,i)=>{if(i)$('finderPath').append(node('span','path-separator','/'));const b=node('button','',part.name);b.onclick=()=>navigate(part.id);if(i===path.length-1)b.setAttribute('aria-current','page');$('finderPath').append(b);});
    $('workflowViews').hidden=!isProject;$('newRegistration').hidden=!isProject;$('importRecords').hidden=!isProject;$('createProject').hidden=isProject;
    document.querySelectorAll('[data-state]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.state===view)));
    const query=$('projectSearch').value.toLocaleLowerCase();
    let items=isProject?PCRWorkflow.rows(entries,catalog,view,PlateEditor):sorted(folders.filter(x=>f?x.parent_id===f.id:x.kind==='person'));
    if(query&&isProject){const match=new Set(items.filter(i=>i.name.toLocaleLowerCase().includes(query)).map(i=>i.groupRef||i.entry.ref));items=items.filter(i=>i.name.toLocaleLowerCase().includes(query)||match.has(i.groupRef||i.entry.ref));}else items=items.filter(x=>x.name.toLocaleLowerCase().includes(query));
    $('projectList').replaceChildren();selected=null;$('openFolder').disabled=true;$('renameFolder').disabled=true;$('finderUp').disabled=!f;
    for(const item of items){
      if(item.kind==='plate'&&item.groupRef)continue;
      if(item.kind==='plate'){const row=node('tr','workflow-gallery');const cell=node('td');cell.colSpan=3;cell.append(plateCard(item));row.append(cell);$('projectList').append(row);continue;}
      const row=node('tr',item.kind==='plate'?'workflow-plate':item.kind==='group'?'workflow-group':'');row.tabIndex=0;row.dataset.key=key(item);row.setAttribute('aria-selected','false');
      const cell=node('td'),name=node('div','name-cell');name.append(node('span',item.entry?'file-icon':'folder-icon',item.kind==='plate'?'96':undefined),node('span','name-text',item.name+(item.count?'（'+item.count+'枚）':'')));cell.append(name);
      if(item.kind==='plate')plateDetails(item,cell);
      row.append(cell,node('td','',(item.entry?.updated_at||item.updated_at)?new Date(item.entry?.updated_at||item.updated_at).toLocaleString('ja-JP'):'—'));
      const actions=node('td','workflow-actions');actions.append(action(item.kind==='input'?'入力を続ける':item.kind==='plate'?'編集':'開く',()=>open(item)));
      if(item.entry){actions.append(action('JSON ↓',()=>{const u=URL.createObjectURL(new Blob([JSON.stringify({name:item.entry.name,payload:item.entry.payload},null,2)],{type:'application/json'}));const a=node('a');a.href=u;a.download=item.entry.name.replace(/[\\/:*?"<>|]/g,'_')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}));}
      if(item.kind==='plate'){
        photos(item,actions);
        if(view==='active')actions.append(action('編集完了',()=>complete(item)));
        if(view!=='hidden')actions.append(action('非表示',()=>setState(item,'hidden')));else actions.append(action('作業中に戻す',()=>setState(item,'active')));
        if(view==='completed')actions.append(action('作業中に戻す',()=>setState(item,'active')));
      }
      row.append(actions);row.onclick=()=>select(item);row.ondblclick=()=>open(item);row.onkeydown=e=>{if(e.target!==row)return;if(e.key==='Enter'){e.preventDefault();open(item);}if(e.key===' '){e.preventDefault();select(item);}};$('projectList').append(row);
      if(item.kind==='group'){const gallery=node('tr','workflow-gallery'),cell=node('td'),strip=node('div','compact-plate-strip');cell.colSpan=3;for(const plate of items.filter(i=>i.kind==='plate'&&i.groupRef===item.entry.ref))strip.append(plateCard(plate));cell.append(strip);gallery.append(cell);$('projectList').append(gallery);}
    }
    $('finderEmpty').hidden=!!items.length||loading;$('finderCount').textContent=items.filter(i=>i.kind!=='group').length+'件';$('newRegistration').disabled=loading;
  }
  async function loadRecords(){
    const project=current,token=++generation;entries=[];catalog={};attachments=[];loading=folder(project)?.kind==='project';render();if(!loading){notice('');return;}
    notice('記録を読み込み中…');
    try{
      const all=[];for(let offset=0;;offset+=1000){const batch=await api('/api/logs?project_id='+encodeURIComponent(project)+'&limit=1000&offset='+offset);all.push(...batch);if(batch.length<1000)break;}
      const results=[],queue=all.slice();await Promise.all(Array.from({length:4},async()=>{while(queue.length){const e=queue.shift();results.push({...await api('/api/logs/'+encodeURIComponent(e.id)),ref:e.id});}}));
      const [local,remoteStates,localStates,images]=await Promise.all([PlatePackStorage.readLogs(),api('/api/output-plates/states?project_id='+encodeURIComponent(project)),PlatePackStorage.readOutputPlateStates(project),api('/api/workflow/attachments?project_id='+encodeURIComponent(project))]);
      if(token!==generation)return;entries=[...results,...local.filter(e=>e.project_id===project).map(e=>({...e,ref:'local:'+e.id}))];catalog={...localStates,...remoteStates};attachments=images;notice('');
    }catch(e){if(token!==generation)return;try{entries=(await PlatePackStorage.readLogs()).filter(e=>e.project_id===project).map(e=>({...e,ref:'local:'+e.id}));catalog=await PlatePackStorage.readOutputPlateStates(project);}catch{}notice('DBの記録を読み込めません。ブラウザ保存分のみ表示しています。更新してください。'+e.message);}
    finally{if(token===generation){loading=false;render();}}
  }
  async function load(){notice('読み込み中…');try{folders=await PlatePackProjects.folders();if(current&&!folder(current)){current=null;history.replaceState(null,'','/');}await loadRecords();}catch(e){notice(e.message);}}
  async function editName(title,initial,save,submitText='保存'){
    const dialog=node('dialog','project-create'),form=node('form');form.method='dialog';const heading=node('h2','',title),label=node('label','','名前'),input=node('input');input.required=true;input.maxLength=120;input.value=initial;label.append(input);const status=node('p');status.setAttribute('role','status');const actions=node('div','actions'),cancel=node('button','','キャンセル'),submit=node('button','',submitText);cancel.type='button';cancel.onclick=()=>dialog.close();submit.type='submit';actions.append(cancel,submit);form.append(heading,label,status,actions);dialog.append(form);document.body.append(dialog);dialog.onclose=()=>dialog.remove();form.onsubmit=async e=>{e.preventDefault();const name=input.value.trim();if(!name)return;submit.disabled=true;try{await save(name);dialog.close();await load();}catch(e){status.textContent=e.message;submit.disabled=false;}};dialog.showModal();input.focus();
  }
  $('finderUp').onclick=()=>navigate(folder(current)?.kind==='project'?folder(current).parent_id:null);
  $('projectSearch').oninput=render;$('finderRefresh').onclick=load;
  $('openFolder').onclick=()=>{if(selected)open(selected);};
  $('renameFolder').onclick=()=>{const item=selected;if(!item||item.kind==='plate')return;editName('名前変更',item.name,async name=>{if(item.entry){if(item.entry.ref.startsWith('local:'))throw Error('ブラウザ保存の記録はJSONで登録してから名前を変更してください。');await api('/api/logs/'+encodeURIComponent(item.entry.ref),{name},'PATCH');}else{const result=await api('/api/folders/'+encodeURIComponent(item.id),{name},'PATCH');await PlatePackStorage.mergeFolders([result]).catch(()=>{});}});};
  $('createMember').onclick=()=>editName('新規メンバー','',async name=>{const result=await api('/api/folders',{id:crypto.randomUUID(),name,kind:'person',parent_id:null});await PlatePackStorage.mergeFolders([result]).catch(()=>{});});
  $('createProject').onclick=async()=>{try{const f=folder(current);const project=await PlatePackProjects.create(f?.kind==='project'?f.id:null,f?.kind==='person'?f.id:null);if(project){await load();navigate(project.id);}}catch(e){notice(e.message);}};
  $('newRegistration').onclick=()=>{const project=current;editName('新しく登録','',async name=>{const entry=await api('/api/workflow/registrations',{name,project_id:project});location.href='/plates?project='+encodeURIComponent(project)+'&log='+encodeURIComponent(entry.id);},'登録');};
  document.querySelectorAll('[data-state]').forEach(b=>b.onclick=()=>{view=b.dataset.state;history.replaceState(null,'',url(current));render();});
  $('importRecords').onclick=()=>$('importRecordsFile').click();
  $('importRecordsFile').onchange=()=>guarded(async()=>{const project=current,file=$('importRecordsFile').files[0];if(!file)return;if(file.size>32*1024*1024)throw Error('JSONは32 MB以下にしてください。');const raw=JSON.parse(await file.text()),payload=raw.payload||raw;if(!Array.isArray(payload.plates)||!payload.plates.length)throw Error('プレートのJSONを選択してください。');await api('/api/logs',{name:String(raw.name||file.name.replace(/\.json$/i,'')).slice(0,120),payload,project_id:project});await loadRecords();});
  window.addEventListener('popstate',()=>{const p=new URLSearchParams(location.search);view=p.get('state')||'active';navigate(p.get('project')||p.get('member'),false);});
  load();
})();
