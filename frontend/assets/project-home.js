(() => {
  'use strict';
  const $=id=>document.getElementById(id), params=new URLSearchParams(location.search);
  let folders=[], current=params.get('project')||params.get('member'), selected=null;
  const modes=[['/plates','サンプリング'],['/output-plates','プレート管理'],['/electrophoresis','バンド定量'],['/results','データベース']];
  const folder=id=>folders.find(f=>f.id===id);
  const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const notice=text=>$('projectNotice').textContent=text;
  const url=id=>{const f=folder(id);return f?'/?'+(f.kind==='project'?'project':'member')+'='+encodeURIComponent(id):'/';};
  function navigate(id,push=true){
    current=id;selected=null;$('projectSearch').value='';
    if(push)history.pushState(null,'',url(id));render();
  }
  function treeButton(f){
    const b=node('button','tree-item '+f.kind);b.type='button';b.classList.toggle('active',current===f.id);
    b.append(node('span','folder-icon'),node('span','folder-name',f.name));b.onclick=()=>navigate(f.id);return b;
  }
  function open(item){
    if(item.path){location.href=item.path+'?project='+encodeURIComponent(current);return;}
    navigate(item.id);
  }
  function select(item){selected=item;document.querySelectorAll('#projectList tr').forEach(r=>r.setAttribute('aria-selected',String(r.dataset.key===(item.id||item.path))));$('openFolder').disabled=false;$('renameFolder').disabled=!!item.path;}
  function render(){
    const f=folder(current);$('projectTree').replaceChildren();
    const sorted=items=>items.sort((a,b)=>a.name.localeCompare(b.name,'ja'));
    for(const member of sorted(folders.filter(f=>f.kind==='person'))){$('projectTree').append(treeButton(member));for(const project of sorted(folders.filter(f=>f.parent_id===member.id&&f.kind==='project')))$('projectTree').append(treeButton(project));}
    const path=[{id:null,name:'ホーム'}];if(f?.kind==='project'&&folder(f.parent_id))path.push(folder(f.parent_id));if(f)path.push(f);
    $('finderPath').replaceChildren();path.forEach((part,i)=>{if(i)$('finderPath').append(node('span','path-separator','/'));const b=node('button','',part.name);b.onclick=()=>navigate(part.id);if(i===path.length-1)b.setAttribute('aria-current','page');$('finderPath').append(b);});
    const query=$('projectSearch').value.toLocaleLowerCase();
    const items=(f?.kind==='project'?modes.map(([path,name])=>({path,name,kind:'mode'})):sorted(folders.filter(x=>f?x.parent_id===f.id:x.kind==='person'))).filter(x=>x.name.toLocaleLowerCase().includes(query));
    $('projectList').replaceChildren();selected=null;$('openFolder').disabled=true;$('renameFolder').disabled=true;$('finderUp').disabled=!f;
    for(const item of items){
      const row=node('tr');row.tabIndex=0;row.dataset.key=item.id||item.path;row.setAttribute('aria-selected','false');
      const cell=node('td'),name=node('div','name-cell');name.append(node('span',item.path?'mode-icon':'folder-icon',item.path?'↗':undefined),node('span','name-text',item.name));cell.append(name);
      row.append(cell,node('td','',item.updated_at?new Date(item.updated_at).toLocaleString('ja-JP'):'—'));
      const actions=node('td'),button=node('button','row-open','開く');button.onclick=e=>{e.stopPropagation();open(item);};actions.append(button);row.append(actions);
      row.onclick=()=>select(item);row.ondblclick=()=>open(item);row.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();open(item);}if(e.key===' '){e.preventDefault();select(item);}};$('projectList').append(row);
    }
    $('finderEmpty').hidden=!!items.length;$('finderCount').textContent=items.length+'件';
  }
  async function load(){
    notice('読み込み中…');try{folders=await PlatePackProjects.folders();if(current&&!folder(current)){current=null;history.replaceState(null,'','/');notice('フォルダが見つかりません。');}else notice('');render();}catch(e){notice(e.message);}
  }
  async function editName(title,initial,save){
    const dialog=node('dialog','project-create');const form=node('form');form.method='dialog';const heading=node('h2','',title),label=node('label','','名前'),input=node('input');input.required=true;input.maxLength=120;input.value=initial;label.append(input);const status=node('p');status.setAttribute('role','status');const actions=node('div','actions'),cancel=node('button','','キャンセル'),submit=node('button','','保存');cancel.type='button';cancel.onclick=()=>dialog.close();submit.type='submit';actions.append(cancel,submit);form.append(heading,label,status,actions);dialog.append(form);document.body.append(dialog);dialog.onclose=()=>dialog.remove();form.onsubmit=async e=>{e.preventDefault();const name=input.value.trim();if(!name)return;submit.disabled=true;try{await save(name);dialog.close();await load();}catch(e){status.textContent=e.message;submit.disabled=false;}};dialog.showModal();input.focus();
  }
  $('finderUp').onclick=()=>navigate(folder(current)?.kind==='project'?folder(current).parent_id:null);
  $('projectSearch').oninput=render;$('finderRefresh').onclick=load;
  $('openFolder').onclick=()=>{if(selected)open(selected);};
  $('renameFolder').onclick=()=>{const item=selected;if(!item||item.path)return;editName('名前変更',item.name,async name=>{const result=await PlatePackStorage.fetchJson('/api/folders/'+encodeURIComponent(item.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});await PlatePackStorage.mergeFolders([result]).catch(()=>{});});};
  $('createMember').onclick=()=>editName('新規メンバー','',async name=>{const result=await PlatePackStorage.fetchJson('/api/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),name,kind:'person',parent_id:null})});await PlatePackStorage.mergeFolders([result]).catch(()=>{});});
  $('createProject').onclick=async()=>{try{const f=folder(current);const project=await PlatePackProjects.create(f?.kind==='project'?f.id:null,f?.kind==='person'?f.id:null);if(project){await load();navigate(project.id);}}catch(e){notice(e.message);}};
  window.addEventListener('popstate',()=>{const p=new URLSearchParams(location.search);navigate(p.get('project')||p.get('member'),false);});
  load();
})();
