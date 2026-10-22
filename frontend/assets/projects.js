/* Shared project chooser. Folder IDs stay identical in DB and browser copies. */
window.PlatePackProjects = (() => {
  const storage=window.PlatePackStorage;
  async function folders(){
    const results=await Promise.allSettled([storage.readFolders(),storage.fetchJson('/api/folders')]);
    const map=new Map();for(const result of results)if(result.status==='fulfilled')for(const f of result.value)map.set(f.id,f);
    if(results[1].status==='fulfilled')await storage.mergeFolders(results[1].value).catch(()=>{});
    if(!map.size)throw Error('保存先を読み込めません。Databaseの接続を確認してください。');
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
