/* Shared project chooser. Folder IDs stay identical in DB and browser copies. */
window.PlatePackProjects = (() => {
  const storage=window.PlatePackStorage;
  async function folders(){
    const results=await Promise.allSettled([storage.readFolders(),storage.fetchJson('/api/folders')]);
    const map=new Map();for(const result of results)if(result.status==='fulfilled')for(const f of result.value)map.set(f.id,f);
    if(results[1].status==='fulfilled')await storage.mergeFolders(results[1].value).catch(()=>{});
    if(!map.size)throw Error('保存先を読み込めません。データベースの接続を確認してください。');
    return [...map.values()];
  }
  async function create(currentProject){
    const all=await folders(),dialog=document.createElement('dialog');dialog.className='project-create';
    dialog.innerHTML='<form method="dialog"><h2>新規プロジェクト</h2><label>メンバー<select name="member" required></select></label><label>プロジェクト名<input name="name" maxlength="120" required autocomplete="off"></label><p role="status"></p><div class="actions"><button type="button" data-cancel>キャンセル</button><button type="submit">作成</button></div></form>';
    const select=dialog.querySelector('select');for(const f of all.filter(x=>x.kind==='person'))select.add(new Option(f.name,f.id));
    const parent=all.find(x=>x.id===currentProject)?.parent_id;if(parent)select.value=parent;
    document.body.append(dialog);dialog.showModal();
    return new Promise(resolve=>{
      let result=null;dialog.addEventListener('close',()=>{dialog.remove();resolve(result)},{once:true});dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
      dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const name=dialog.querySelector('input').value.trim();if(!name)return;
        const button=dialog.querySelector('[type=submit]');button.disabled=true;
        try{const id=crypto.randomUUID();result=await storage.fetchJson('/api/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name,kind:'project',parent_id:select.value})});await storage.mergeFolders([result]).catch(()=>{});dialog.close();}
        catch(e){dialog.querySelector('[role=status]').textContent='作成できませんでした。'+e.message;button.disabled=false;}
      };
    });
  }
  return {folders,create};
})();


/* One project is the context for every workflow page. */
window.PCRProject = (() => {
  const params=new URLSearchParams(location.search);
  let id=params.get('project');
  const routes=[['/plates','サンプリング'],['/output-plates','プレート管理'],['/electrophoresis','バンド定量'],['/results','データベース']];
  const href=path=>path+'?project='+encodeURIComponent(id);
  const ready=(async()=>{
    if(location.pathname==='/')return null;
    if(params.get('log')){
      const ref=params.get('log');
      const entry=ref.startsWith('local:')?await PlatePackStorage.getLog(ref.slice(6)):await PlatePackStorage.fetchJson('/api/logs/'+encodeURIComponent(ref));
      if(!entry)throw Error('記録が見つかりません。');
      if(id&&id!==entry.project_id)throw Error('選択中のプロジェクトとは異なる記録です。');
      id=entry.project_id;
    }
    if(!id){location.replace('/');return new Promise(()=>{});}
    const all=await PlatePackProjects.folders(),project=all.find(f=>f.id===id&&f.kind==='project');
    if(!project)throw Error('プロジェクトが見つかりません。ホームから選び直してください。');
    params.set('project',id);history.replaceState(null,'',location.pathname+'?'+params);
    document.body.classList.add('project-scoped');
    const bar=document.createElement('nav');bar.className='project-navigation';bar.setAttribute('aria-label','プロジェクト内の作業');
    const home=document.createElement('a');home.href='/';home.textContent='プロジェクト一覧';bar.append(home);
    const name=document.createElement('a');name.href=href('/');name.className='project-name';name.textContent=(all.find(f=>f.id===project.parent_id)?.name||'メンバー')+' / '+project.name;bar.append(name);
    for(const [path,label] of routes){const a=document.createElement('a');a.href=href(path);a.textContent=label;if(path===location.pathname)a.setAttribute('aria-current','page');bar.append(a);}
    document.body.prepend(bar);
    document.querySelectorAll('a[href="/"]').forEach(a=>{if(a!==home)a.href=href('/');});
    for(const [path] of routes)document.querySelectorAll('a[href="'+path+'"]').forEach(a=>a.href=href(path));
    for(const key of ['saveProjectSelect','project','projectSelect']){const select=document.getElementById(key);if(select)select.disabled=true;}
    for(const key of ['createSaveProject','newProject','newProjectBtn','newPersonBtn','rootBtn']){const button=document.getElementById(key);if(button)button.hidden=true;}
    return project;
  })();
  ready.catch(e=>{const p=document.createElement('p');p.className='project-error';p.textContent=e.message;const a=document.createElement('a');a.href='/';a.textContent='プロジェクト一覧へ';p.append(' ',a);document.body.prepend(p);document.querySelectorAll('main,section,.database-shell').forEach(n=>n.inert=true);});
  return {get id(){return id},ready,href};
})();
