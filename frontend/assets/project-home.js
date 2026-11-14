(() => {
  const $=id=>document.getElementById(id);let folders=[];
  const id=new URLSearchParams(location.search).get('project');
  function render(){
    const list=$('projectList');list.replaceChildren();const query=$('projectSearch').value.toLocaleLowerCase();
    for(const project of folders.filter(f=>f.kind==='project').sort((a,b)=>a.name.localeCompare(b.name,'ja'))){
      const member=folders.find(f=>f.id===project.parent_id)?.name||'メンバー';
      if(!(member+' '+project.name).toLocaleLowerCase().includes(query))continue;
      const a=document.createElement('a');a.className='card card-link';a.href='/?project='+encodeURIComponent(project.id);
      const h=document.createElement('h2');h.textContent=project.name;const p=document.createElement('p');p.textContent=member;a.append(h,p);list.append(a);
    }
    $('projectNotice').textContent=list.children.length?'':query?'一致するプロジェクトがありません。':'プロジェクトを作成してください。';
  }
  async function load(){
    try{folders=await PlatePackProjects.folders();
      const project=folders.find(f=>f.id===id&&f.kind==='project');
      if(id&&!project)throw Error('プロジェクトが見つかりません。プロジェクト一覧から選び直してください。');
      if(project){$('projectChooser').hidden=true;$('projectWorkspace').hidden=false;$('activeProjectName').textContent=project.name;$('activeProjectMember').textContent=folders.find(f=>f.id===project.parent_id)?.name||'メンバー';
        document.querySelectorAll('#projectWorkspace .card-link').forEach(a=>a.href=a.getAttribute('href')+'?project='+encodeURIComponent(id));
      }else render();
    }catch(e){$('projectNotice').textContent=e.message;}
  }
  $('projectSearch').oninput=render;
  $('createProject').onclick=async()=>{try{const project=await PlatePackProjects.create();if(project)location.href='/?project='+encodeURIComponent(project.id);}catch(e){$('projectNotice').textContent=e.message;}};
  load();
})();
