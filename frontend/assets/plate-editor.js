(() => {
  'use strict';
  const $=id=>document.getElementById(id), core=PlateEditor, storage=PlatePackStorage;
  const params=new URLSearchParams(location.search);
  let entries=[], picked=new Map(), current=null, original=null, undo=[], selection=null, gesture=null, rangeMode=false, targeting=false, dirty=false, busy=false, savedRef=null, pendingSave=null;
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const note=(text,error=false)=>{$('notice').textContent=text;$('notice').dataset.error=error;};
  const request=(path,body)=>storage.fetchJson(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
  const key=(entry,index)=>entry.ref+'#'+index;
  const count=plate=>plate.grid.flat().filter(Boolean).length;
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  async function guarded(fn){if(busy)return;busy=true;document.body.classList.add('saving');try{await fn()}catch(e){note(e.message,true)}finally{busy=false;document.body.classList.remove('saving')}}
  async function readEntry(ref){return ref.startsWith('local:')?storage.getLog(ref.slice(6)):request('/api/logs/'+encodeURIComponent(ref));}
  async function load(){
    picked.clear();const project=$('project').value;entries=[];renderOverview();note('読み込み中…');
    $('databaseLink').href='/results?project='+encodeURIComponent(project);
    let summaries=[],remoteError=null;
    try{for(let offset=0;;offset+=1000){const batch=await request('/api/logs?limit=1000&offset='+offset+'&project_id='+encodeURIComponent(project));summaries.push(...batch.filter(e=>e.record_type!=='electrophoresis'));if(batch.length<1000)break}}
    catch(e){remoteError=e;}
    // Keep concurrency bounded; large gel blobs are never fetched here.
    const queue=summaries.slice(), failures=[];
    await Promise.all(Array.from({length:4},async()=>{while(queue.length){const summary=queue.shift();try{const e=await readEntry(summary.id);entries.push({...e,ref:e.id})}catch(e){failures.push(e)}}}));
    try{const local=await storage.readLogs();entries.push(...local.filter(e=>e.project_id===project&&!e.payload?.electrophoresis).map(e=>({...e,ref:'local:'+e.id})))}catch(e){failures.push(e)}
    entries=entries.filter(e=>Array.isArray(e.payload?.packedPlates)&&e.payload.packedPlates.length&&!e.payload.electrophoresis);
    // Packer keeps an identical browser backup as well as its DB record.
    const copies=new Map(entries.filter(e=>!e.ref.startsWith('local:')).map(e=>[e.name+'\n'+canonical(e.payload),e]));
    entries=entries.filter(e=>{const existing=copies.get(e.name+'\n'+canonical(e.payload));if(e.ref.startsWith('local:')&&existing){existing.aliases=(existing.aliases||[]).concat(e.ref);return false}return true}).sort((a,b)=>String(b.created_at).localeCompare(a.created_at));
    renderOverview();note(remoteError?'DBに接続できません。ブラウザ保存分のみ表示しています。':failures.length?'一部のデータを読み込めませんでした。「更新」で再試行してください。':'',!!remoteError||!!failures.length);
  }
  function updatePicked(){
    $('pickedCount').textContent=picked.size+' / 2枚';$('editSelected').disabled=!picked.size;$('clearSelection').disabled=!picked.size;
    document.querySelectorAll('[data-pick]').forEach(input=>{input.checked=picked.has(input.dataset.pick);input.disabled=picked.size===2&&!input.checked;});
  }
  function plateCards(entry){
    const list=el('div',undefined,'thumbnails');
    entry.payload.packedPlates.forEach((plate,index)=>{
      const card=el('div',undefined,'plate-card'),tools=el('div',undefined,'card-tools'),label=el('label'),check=el('input');check.type='checkbox';check.dataset.pick=key(entry,index);check.setAttribute('aria-label',entry.name+' / '+plate.id+' を選択');
      check.onchange=()=>{if(check.checked){if(picked.size>=2){check.checked=false;return}picked.set(key(entry,index),{entry,index})}else picked.delete(key(entry,index));updatePicked()};
      label.append(check,document.createTextNode(plate.id));tools.append(label,el('span',count(plate)+'/96'));
      const open=el('button',undefined,'card-open');open.type='button';open.setAttribute('aria-label',entry.name+' / '+plate.id+' を拡大');open.dataset.help='クリックで拡大。2枚を並べる場合はチェックを付けて「編集」。';
      const mini=el('div',undefined,'mini');for(const cell of plate.grid.flat())mini.append(el('span',undefined,cell?'filled':''));open.append(mini);open.onclick=()=>start([{entry,index}]);card.append(tools,open);list.append(card);
    });return list;
  }
  function heading(entry,container){const row=el('div',undefined,'record-heading');row.append(el('h3',entry.name));const date=el('time',new Date(entry.created_at).toLocaleString('ja-JP'));row.append(date);if(entry.ref.startsWith('local:'))row.append(el('small','ブラウザ'));container.append(row);}
  function renderOverview(){
    const parent=params.get('parent'), opened=params.get('log');$('records').replaceChildren();
    let roots=entries.filter(e=>!e.payload.plateEdit);
    if(parent)roots=roots.filter(e=>e.ref===parent||e.aliases?.includes(parent));
    const edits=entries.filter(e=>e.payload.plateEdit);
    function edited(entry,container){const section=el('section',undefined,'edited-record');heading(entry,section);section.append(plateCards(entry));const roi=el('a','ROI対応へ');roi.href='/electrophoresis?log='+encodeURIComponent(entry.ref);section.append(roi);container.append(section);}
    for(const entry of roots){
      const section=el('section',undefined,'record');heading(entry,section);section.append(plateCards(entry));
      const children=edits.filter(e=>[entry.ref,...entry.aliases||[]].some(ref=>e.payload.plateEdit.rootRefs.includes(ref)));
      if(children.length){const folder=el('details',undefined,'edited-folder');folder.append(el('summary','編集プレート · '+children.length));if(parent||children.some(e=>e.ref===opened||e.ref===savedRef))folder.open=true;children.forEach(e=>edited(e,folder));section.append(folder)}
      $('records').append(section);
    }
    const detached=edits.filter(e=>(!parent||e.payload.plateEdit.rootRefs.includes(parent))&&!roots.some(r=>[r.ref,...r.aliases||[]].some(ref=>e.payload.plateEdit.rootRefs.includes(ref))));
    if(detached.length){const section=el('section',undefined,'record');section.append(el('h3','編集プレート'));detached.forEach(e=>edited(e,section));$('records').append(section)}
    if(!$('records').children.length)$('records').append(el('p','出力プレートなし'));
    $('recordCount').textContent=entries.reduce((n,e)=>n+e.payload.packedPlates.length,0)+'枚';updatePicked();
  }
  function start(list){
    try{current=core.assemble(list);original=core.clone(current.data);undo=[];selection=null;savedRef=list.every(s=>s.entry.ref===list[0].entry.ref)&&list[0].entry.payload.recordType==='edited_plate'?list[0].entry.ref:null;pendingSave=null;dirty=false;rangeMode=false;targeting=false;
      $('overview').hidden=true;$('editor').hidden=false;$('project').disabled=true;$('refresh').disabled=true;$('editTitle').textContent=current.name;note('');renderEditor();window.scrollTo(0,0);
    }catch(e){note(e.message,true)}
  }
  function mark(){
    document.querySelectorAll('.well').forEach(b=>b.classList.toggle('selected',selection?.plate===+b.dataset.plate&&selection.wells.includes(b.dataset.well)));
    const has=selection?.wells.some(w=>core.cellAt(current.data,selection.plate,w));
    $('delete').disabled=!has;$('move').disabled=!has;$('selectionInfo').textContent=selection?selection.wells.length+'ウェル選択':'';
    $('correctSource').disabled=!has||selection.wells.length!==1;
    $('range').setAttribute('aria-pressed',String(rangeMode));$('move').setAttribute('aria-pressed',String(targeting));
  }
  function change(action){
    if(busy)return;
    try{const next=core.apply(current.data,action);if(canonical(next)===canonical(current.data))return true;undo.push(core.clone(current.data));current.data=next;dirty=true;savedRef=null;pendingSave=null;selection=null;targeting=false;note('');renderEditor();return true}catch(e){note(e.message,true);$('sourceError').textContent=e.message;targeting=false;mark();return false}
  }
  function renderEditor(){
    $('boards').replaceChildren();$('undo').disabled=!undo.length;$('reset').disabled=canonical(current.data)===canonical(original);$('saveState').textContent=dirty?'未保存':savedRef?'保存済み':'編集前';
    $('electrophoresis').hidden=!savedRef;$('electrophoresis').href=savedRef?'/electrophoresis?log='+encodeURIComponent(savedRef):'';
    for(const index of current.selected){
      const plate=current.data.packedPlates[index],section=el('section',undefined,'board'),title=el('h3',plate.id+' · '+count(plate)+'/96');title.append(el('small',plate.sourceRecordName));section.append(title);
      const grid=el('div',undefined,'well-grid');grid.setAttribute('role','group');grid.setAttribute('aria-label',plate.id);grid.append(el('span'));for(let c=1;c<=12;c++)grid.append(el('span',c,'axis'));
      for(let r=0;r<8;r++){grid.append(el('span','ABCDEFGH'[r],'axis'));for(let c=0;c<12;c++){
        const name=core.well(r,c),cell=plate.grid[r][c],p=cell?current.data.plates[Number(cell.sourcePlate)-1]:null;
        const b=el('button',cell?cell.sourcePlate+'-'+cell.sourceWell:'', 'well'+(cell?' filled':''));b.type='button';b.dataset.well=name;b.dataset.plate=index;
        if(cell?.growthWeek)b.dataset.phase=cell.growthWeek;b.append(el('small',cell?.growthWeek||''));
        b.title=plate.id+' / '+name+(cell?' ← '+p.label+' / '+cell.sourceWell+' · phase '+(cell.growthWeek||'—'):' · 空');b.setAttribute('aria-label',b.title);
        b.onpointerdown=e=>begin(e,index,name);b.onclick=e=>{if(e.detail!==0)return;activate(index,name,e.shiftKey)};grid.append(b);
      }}section.append(grid);$('boards').append(section);
    }
    $('changes').replaceChildren();
    for(const a of current.data.plateEdit.sourceCorrectionHistory||[])$('changes').append(el('li',a.record+' · '+a.output+' / '+a.well+' 入力元 '+a.before+' → '+a.after+'（保存済み）'));
    for(const a of current.data.plateEdit.operations){const from=current.data.packedPlates[a.from]?.id;const li=el('li',a.type==='correct-source'?from+' / '+a.wells[0]+' 入力元 '+a.before.sourcePlate+'-'+a.before.sourceWell+' → '+a.sourcePlate+'-'+a.sourceWell:a.type==='delete'?from+' / '+a.wells.join(', ')+' 削除':from+' / '+a.wells.join(', ')+' → '+current.data.packedPlates[a.to]?.id+' / '+a.target);$('changes').append(li)}mark();
  }
  function activate(index,name,shift=false){
    if(busy)return;
    if(targeting&&selection){change({type:'move',from:selection.plate,to:index,wells:selection.wells,anchor:selection.anchor,target:name});return}
    if(shift&&selection?.plate===index)selection={...selection,wells:core.rectangle(selection.anchor,name)};
    else selection={plate:index,anchor:name,wells:[name]};mark();
  }
  function begin(event,index,name){
    if(busy||event.button!==0)return;event.preventDefault();event.currentTarget.focus();
    if(targeting){activate(index,name);return}
    if(event.shiftKey){activate(index,name,true);return}
    if(!selection||selection.plate!==index||!selection.wells.includes(name))selection={plate:index,anchor:name,wells:[name]};
    if(rangeMode)selection={plate:index,anchor:name,wells:[name]};
    gesture={index,name,x:event.clientX,y:event.clientY,pointerId:event.pointerId,range:rangeMode,moved:false};mark();
  }
  document.addEventListener('pointermove',event=>{
    if(!gesture||gesture.pointerId!==event.pointerId)return;
    gesture.moved ||= Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>5;
    const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.well');
    document.querySelectorAll('.drop-target').forEach(n=>n.classList.remove('drop-target'));
    if(!target||!gesture.moved)return;
    if(gesture.range){if(+target.dataset.plate===gesture.index){selection.wells=core.rectangle(gesture.name,target.dataset.well);mark()}}
    else target.classList.add('drop-target');
  });
  document.addEventListener('pointerup',event=>{
    if(!gesture||gesture.pointerId!==event.pointerId)return;const g=gesture;gesture=null;
    document.querySelectorAll('.drop-target').forEach(n=>n.classList.remove('drop-target'));
    if(g.range){rangeMode=false;mark();return}
    const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.well');
    if(g.moved&&target)change({type:'move',from:g.index,to:+target.dataset.plate,wells:selection.wells,anchor:g.name,target:target.dataset.well});
  });
  document.addEventListener('pointercancel',()=>{gesture=null;document.querySelectorAll('.drop-target').forEach(n=>n.classList.remove('drop-target'))});
  function revert(){if(busy||!undo.length)return;current.data=undo.pop();dirty=true;selection=null;targeting=false;savedRef=null;pendingSave=null;renderEditor()}
  $('undo').onclick=revert;
  $('correctSource').onclick=()=>{
    if(!selection||selection.wells.length!==1)return;
    const cell=core.cellAt(current.data,selection.plate,selection.wells[0]);if(!cell)return;
    $('sourcePlate').replaceChildren(...current.data.plates.map((p,i)=>new Option((i+1)+' · '+p.label,String(i+1))));
    $('sourcePlate').value=cell.sourcePlate;$('sourceWell').value=cell.sourceWell;
    $('sourceBefore').textContent=current.data.packedPlates[selection.plate].id+' / '+selection.wells[0]+' ← '+cell.sourcePlate+'-'+cell.sourceWell;
    $('sourceError').textContent='';targeting=false;rangeMode=false;mark();$('sourceDialog').showModal();$('sourceWell').focus();$('sourceWell').select();
  };
  $('cancelSource').onclick=()=>$('sourceDialog').close();
  $('sourceForm').onsubmit=e=>{e.preventDefault();if(selection&&change({type:'correct-source',from:selection.plate,wells:selection.wells,sourcePlate:$('sourcePlate').value,sourceWell:$('sourceWell').value.trim().toUpperCase()}))$('sourceDialog').close()};
  document.addEventListener('keydown',e=>{if($('editor').hidden||$('sourceDialog').open||busy||e.target.matches('input,textarea,select'))return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();revert()}if(e.key==='Escape'){gesture=null;selection=null;rangeMode=false;targeting=false;mark()}});
  $('range').onclick=()=>{rangeMode=!rangeMode;targeting=false;mark()};$('move').onclick=()=>{targeting=!targeting;rangeMode=false;mark()};
  $('delete').onclick=()=>{if(selection)change({type:'delete',from:selection.plate,wells:selection.wells})};
  $('reset').onclick=()=>{if(confirm('今回の編集を開始時の配置に戻しますか？')){undo.push(core.clone(current.data));current.data=core.clone(original);dirty=true;selection=null;targeting=false;rangeMode=false;savedRef=null;pendingSave=null;renderEditor()}};
  $('back').onclick=()=>{if(dirty&&!confirm('未保存の変更を破棄して一覧へ戻りますか？'))return;dirty=false;current=null;params.delete('log');history.replaceState(null,'','/output-plates?project='+encodeURIComponent($('project').value)+(params.get('parent')?'&parent='+encodeURIComponent(params.get('parent')):''));$('editor').hidden=true;$('overview').hidden=false;$('project').disabled=false;$('refresh').disabled=false;renderOverview();note('')};
  $('save').onclick=()=>guarded(async()=>{
    if(savedRef&&!dirty){note('保存済みです。');return}
    if(!pendingSave){const payload=core.clone(current.data);payload.plateEdit.savedAt=new Date().toISOString();pendingSave={payload,project: $('project').value,name:current.name,ref:null};}
    const p=pendingSave;
    if(!p.ref){const out=await request('/api/logs',{name:p.name,project_id:p.project,payload:p.payload});p.ref=out.id;}
    const verified=await readEntry(p.ref);
    if(verified.project_id!==p.project||canonical(verified.payload)!==canonical(p.payload))throw Error('保存内容を照合できませんでした。再度「保存」を押してください。');
    savedRef=p.ref;dirty=false;entries.unshift({...verified,ref:verified.id});pendingSave=null;
    renderEditor();note('「編集プレート」に保存しました。');history.replaceState(null,'','/output-plates?project='+encodeURIComponent(p.project)+'&log='+encodeURIComponent(savedRef));
  });
  $('editSelected').onclick=()=>start([...picked.values()]);$('clearSelection').onclick=()=>{picked.clear();updatePicked()};$('refresh').onclick=()=>guarded(load);$('project').onchange=()=>{params.delete('parent');params.delete('log');history.replaceState(null,'','/output-plates?project='+encodeURIComponent($('project').value));guarded(load)};
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
  guarded(async()=>{
    const folders=await PlatePackProjects.folders();for(const f of folders.filter(f=>f.kind==='project'))$('project').add(new Option((folders.find(p=>p.id===f.parent_id)?.name||'メンバー')+' / '+f.name,f.id));
    const ref=params.get('log');let opened=null;if(ref){opened=await readEntry(ref);if(!opened)throw Error('データが見つかりません。');params.set('project',opened.project_id)}
    if(params.get('project'))$('project').value=params.get('project');if(!$('project').value)throw Error('プロジェクトが見つかりません。');
    await load();if(opened){const entry={...opened,ref};const chosen=entry.payload.plateEdit?.selectedPlates || entry.payload.packedPlates.slice(0,2).map((_,i)=>i);start(chosen.map(index=>({entry,index})))}
  });
})();
