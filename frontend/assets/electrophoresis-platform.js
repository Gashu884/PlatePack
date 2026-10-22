/* PlatePack experiment workflow: persisted originals, fixed identities, explicit pool approval. */
window.Electro = (() => {
  const el=id=>document.getElementById(id), copy=x=>JSON.parse(JSON.stringify(x));
  const CHUNK=256*1024;
  let record={version:1,sessions:[],plate:null,links:null,groupSize:48,confirmed:null,name:'泳動解析'}, mapping, files=[], active=null, saving=Promise.resolve(), dirty=false, running=false, proposal=null;
  const encoder=new TextEncoder();
  async function request(path,data,method='POST'){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
    try{const r=await fetch(path,{method:data===undefined?'GET':method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:controller.signal});const j=await r.json();if(!r.ok)throw Error(typeof j.detail==='string'?j.detail:'処理に失敗しました。');return j;}finally{clearTimeout(timer)}
  }
  async function idb(action,key,value){
    return new Promise((resolve,reject)=>{const req=indexedDB.open('platepack-electrophoresis',1);req.onupgradeneeded=()=>req.result.createObjectStore('data');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,t=db.transaction('data',action==='get'?'readonly':'readwrite'),store=t.objectStore('data');const q=action==='get'?store.get(key):store.put(value,key);let result;q.onsuccess=()=>result=q.result;t.oncomplete=()=>{db.close();resolve(result)};t.onerror=()=>{db.close();reject(t.error)}}});
  }
  const hex=buffer=>[...new Uint8Array(buffer)].map(b=>b.toString(16).padStart(2,'0')).join('');
  async function hash(bytes){return hex(await crypto.subtle.digest('SHA-256',bytes))}
  function b64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s)}
  const unb64=text=>Uint8Array.from(atob(text),x=>x.charCodeAt(0));
  async function putBlob(bytes){
    if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);
    if(!bytes.length||bytes.length>96*1024*1024)throw Error('ファイルは96 MB以下にしてください。');
    const key=await hash(bytes);let exists=false;
    try{await request('/api/electrophoresis/blobs/'+key);exists=true}catch{}
    if(!exists){const count=Math.ceil(bytes.length/CHUNK);for(let i=0;i<count;i++){el('busy').textContent=`登録中… ${i+1} / ${count}`;await request(`/api/electrophoresis/blobs/${key}/chunks/${i}`,{data:b64(bytes.subarray(i*CHUNK,(i+1)*CHUNK))},'PUT')}await request(`/api/electrophoresis/blobs/${key}/complete`,{size:bytes.length,chunks:count});}
    await idb('put','blob:'+key,bytes).catch(()=>{});return key;
  }
  async function getBlob(key){
    const cached=await idb('get','blob:'+key).catch(()=>null);if(cached&&await hash(cached)===key)return cached;
    const info=await request('/api/electrophoresis/blobs/'+key),bytes=new Uint8Array(info.size);let offset=0;
    for(let i=0;i<info.chunks;i++){const j=await request(`/api/electrophoresis/blobs/${key}/chunks/${i}`),part=unb64(j.data);bytes.set(part,offset);offset+=part.length;}
    if(offset!==info.size||await hash(bytes)!==key)throw Error('保存ファイルの検証に失敗しました。');
    await idb('put','blob:'+key,bytes).catch(()=>{});return bytes;
  }
  function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000)}
  function sync(){
    if(state){const index=record.sessions.findIndex(s=>s.image.sha256===state.image.sha256);if(index<0)record.sessions.push(state);else record.sessions[index]=state;active=state.image.sha256;}
    record.name=el('experimentName').value.trim()||'泳動解析';record.projectId=el('projectSelect').value;record.active=active;
  }
  function signature(){return ElectrophoresisChecks.signature(record)}
  function invalidate(){record.confirmed=null;proposal=null;dirty=true;}
  async function autosave(){
    sync();if(record.confirmed?.signature!==signature())record.confirmed=null;
    const snapshot=copy(record);dirty=true;
    saving=saving.catch(()=>{}).then(()=>idb('put','draft',snapshot));
    try{await saving}catch{toast('下書きの自動保存ができません。実験一式JSONを保存してください。')}
  }
  async function guarded(fn){if(running)return;running=true;el('busy').hidden=false;el('busy').textContent='処理中…';try{return await fn()}catch(e){toast(e.message);el('recordStatus').textContent=e.message;console.error(e)}finally{running=false;el('busy').hidden=true}}
  function render(){
    if(!state)return;sync();if(record.confirmed?.signature!==signature())record.confirmed=null;
    const measured=ElectrophoresisChecks.measured(state);
    el('measurementStatus').textContent=measured?'測定済み':'未測定（プレビュー）';
    el('exportAll').disabled=!measured;el('exportPCR').disabled=!measured;el('exportPool').disabled=!record.confirmed;el('exportConfirmed').disabled=!record.confirmed;
    el('runSelect').replaceChildren(...record.sessions.map(s=>new Option(s.image.name,s.image.sha256)));el('runSelect').value=active||'';
    el('saveExperiment').disabled=!record.plate;el('gelLinkBtn').disabled=!record.plate;el('measureAll').disabled=!record.plate;
    if(mapping)mapping.refresh();
  }
  async function api(path,data,headers){
    if(path==='/api/upload'){
      if(!record.plate)throw Error('先に対応するプレートデータを読み込んでください。');
      sync();if(record.sessions.length>=32)throw Error('1実験は32画像までです。別の実験として保存してください。');const key=await putBlob(data);
      if(record.sessions.some(s=>s.image.sha256===key))throw Error('この画像は登録済みです。泳動画像の選択から開いてください。');
      const out=await request('/api/electrophoresis/detect',{sha256:key,name:decodeURIComponent(headers['X-Filename']),rows:+headers['X-Rows'],cols:+headers['X-Cols']});
      out.config.groupSize=record.groupSize;out.config.rois.forEach(r=>r.poolGroup='Pool'+(1+Math.floor((r.id-1)/record.groupSize)));invalidate();return out;
    }
    if(path==='/api/restore'){
      if(data.raw){const key=await putBlob(unb64(data.raw));if(key!==data.image.sha256)throw Error('元画像が一致しません。');delete data.raw;}
      return request('/api/electrophoresis/restore',data);
    }
    return request(path.replace('/api/','/api/electrophoresis/'),data);
  }
  async function loadProjects(selected){
    const all=await PlatePackProjects.folders();el('projectSelect').replaceChildren(...all.filter(f=>f.kind==='project').map(f=>new Option((all.find(p=>p.id===f.parent_id)?.name||'メンバー')+' / '+f.name,f.id)));
    if(selected&&[...el('projectSelect').options].some(o=>o.value===selected))el('projectSelect').value=selected;
    await loadFiles();
  }
  async function loadFiles(){
    const project=el('projectSelect').value;files=[];
    let offset=0;while(true){const batch=await request(`/api/logs?limit=1000&offset=${offset}&project_id=${encodeURIComponent(project)}`);files.push(...batch.map(f=>({...f,ref:f.id})));if(batch.length<1000)break;offset+=1000;}
    const local=await PlatePackStorage.readLogs();files.push(...local.filter(f=>f.project_id===project).map(f=>({...f,ref:'local:'+f.id})));
    el('plateRecord').replaceChildren(new Option('選択',''),...files.map(f=>new Option(f.name+(f.ref.startsWith('local:')?'（ブラウザ）':''),f.ref)));
  }
  async function entry(ref){return ref.startsWith('local:')?PlatePackStorage.getLog(ref.slice(6)):request('/api/logs/'+encodeURIComponent(ref))}
  function ensurePlate(plate){
    if(!plate||!Array.isArray(plate.plates)||!plate.plates.length)throw Error('保存済みのプレートデータを選んでください。');
    const p=copy(plate);delete p.electrophoresis;delete p.recordType;delete p.gelLinks;
    for(const x of p.plates){if(!Array.isArray(x.wells)||!x.wells.every(w=>/^[A-H](?:[1-9]|1[0-2])$/.test(w)))throw Error('ウェル情報が不正です。');x.uid ||= crypto.randomUUID();}
    return p;
  }
  async function openEntry(ref){
    const e=await entry(ref);if(!e)throw Error('データが見つかりません。');el('viewPlate').href='/plates?log='+encodeURIComponent(ref);el('viewPlate').hidden=false;
    if(e.payload.electrophoresis?.blob){
      const stored=JSON.parse(new TextDecoder().decode(await getBlob(e.payload.electrophoresis.blob)));stored.projectId=e.project_id;await restoreRecord(stored);dirty=false;
      el('recordStatus').textContent='DB読込済み';return;
    }
    if(record.sessions.length)throw Error('画像を登録済みです。別のプレートで開始する場合は実験を保存してからHomeから新しく開いてください。');
    record.plate=ensurePlate(e.payload);record.plateRef=ref;record.plateName=e.name;el('gelLinkBtn').disabled=false;record.links=PlatePackGelLinks.empty(crypto.randomUUID());
    el('recordStatus').textContent='プレート：'+e.name;await autosave();
  }
  async function restoreRecord(value){
    if(value.version!==1||!Array.isArray(value.sessions)||value.sessions.length>32)throw Error('実験一式JSONの形式が不正です。');
    if(!Number.isInteger(value.groupSize)||value.groupSize<1||value.groupSize>384)throw Error('チューブのサンプル数が不正です。');
    const candidate=copy(value);candidate.plate=ensurePlate(candidate.plate);PlatePackGelLinks.validate(candidate.links);
    // Verify all referenced originals before replacing the open experiment.
    for(const session of candidate.sessions){const bytes=session.raw?unb64(session.raw):await getBlob(session.image.sha256);if(await putBlob(bytes)!==session.image.sha256)throw Error('元画像が一致しません。');delete session.raw;}
    const selected=candidate.sessions.find(s=>s.image.sha256===candidate.active)||candidate.sessions[0];
    let restored=selected?await api('/api/restore',selected):null;
    state=null;record=candidate;active=candidate.active;proposal=null;el('experimentName').value=record.name;el('groupSize').value=record.groupSize;await loadProjects(record.projectId);
    if(restored)await adopt(restored);else{el('gel').hidden=true;el('empty').hidden=false;}
    if(record.confirmed?.signature!==signature())record.confirmed=null;render();
  }
  async function applyMapping(result){
    if(!state||result.image.sha256!==state.image.sha256){toast('現在の泳動と対応が一致しません。');return;}
    state.config=result.config;invalidate();await commit('プレートとROIの対応を適用');syncInputs();
  }
  function checkMapping(session){
    if(!record.links)throw Error('ROIとウェルの対応を指定してください。');
    const mapped=PlatePackGelLinks.exportSession(record.links,record.plate,session,session.image.sha256);
    // Reject manual IDs that would disconnect repeat-PCR identity from its original well.
    for(let i=0;i<session.config.rois.length;i++){const a=session.config.rois[i],b=mapped.config.rois[i];if(a.sample!==b.sample||a.well!==b.well||!!a.platepack?.skipped!==!!b.platepack?.skipped)throw Error('ROIとウェルの対応を解析に適用してください。');}
  }
  function assignGroups(){
    if(!state)return;const size=Number(el('groupSize').value);if(!Number.isInteger(size)||size<1||size>384)throw Error('サンプル数は1〜384で指定してください。');
    sync();for(const s of record.sessions)checkMapping(s);record.groupSize=size;const groups=new Map();let ordinal=0;
    for(const s of record.sessions){s.config.groupSize=size;for(const r of s.config.rois){const id=r.sample||s.image.sha256+':'+r.id;if(!groups.has(id))groups.set(id,'Pool'+(1+Math.floor(ordinal++/size)));r.poolGroup=groups.get(id);}}
    invalidate();return commit('チューブのサンプル数・割当を変更');
  }
  async function measure(){
    if(!state)return;clearTimeout(textSaveTimer);checkMapping(state);
    if(state.config.markers.some(m=>!m.confirmed))throw Error('各段の500 bpマーカーの位置・積分範囲を確認してください。');
    const q=await api('/api/measure',{sha256:state.image.sha256,config:state.config});
    if(q.markerResults.some(m=>!m.valid))throw Error('500 bpマーカーに微弱・飽和・複数ピークなどがあります。ROIと積分範囲を確認してください。');
    state.quantification=q;state.measuredConfig=ElectrophoresisChecks.key(state.config);state.measuredVersion=q.version;state.measuredAt=new Date().toISOString();invalidate();render();await autosave();toast('測定完了');
  }
  async function plan(){
    sync();if(!record.sessions.length)throw Error('泳動画像を登録してください。');
    for(const s of record.sessions){checkMapping(s);if(!ElectrophoresisChecks.measured(s,state.quantification.version))throw Error(s.image.name+'：変更後の輝度測定が必要です。');}
    const snapshot=signature();const data=await request('/api/electrophoresis/plan',{sessions:record.sessions.map(s=>({image:{sha256:s.image.sha256,name:s.image.name},config:s.config,measuredVersion:s.measuredVersion})),groupSize:record.groupSize});
    if(snapshot!==signature())throw Error('計算中に設定が変わりました。もう一度計算してください。');
    proposal={signature:snapshot,plan:data};showPlan(data);el('planDialog').showModal();
  }
  function showPlan(p){
    el('planSummary').innerHTML=p.plans.map(t=>`<div class="plan-card"><h3>${esc(t.group)}</h3><p>${t.count}検体 / ${fmt(t.total,1)} µL<br>有効測定 ${t.measuredCount}検体<br>面積 平均 ${fmt(t.areaMean,1)} / 中央値 ${fmt(t.areaMedian,1)}<br>500 bp補正 平均 ${fmt(t.mean,4)} / 中央値 ${fmt(t.median,4)}</p></div>`).join('')+p.blockers.map(t=>`<p>${esc(t)}</p>`).join('');
    el('planRows').innerHTML=p.samples.map(r=>`<tr data-used="${r.used}"><td>${esc(r.group)}</td><td>${esc(r.well||'未指定')} / #${r.lane}</td><td>${esc(r.imageName)}<small>${p.records.filter(x=>x.sampleId===r.sampleId).length}回測定</small></td><td>${fmt(r.relativeToMedian,3)}</td><td>${fmt(r.volume,1)}</td><td>${fmt(r.roundingErrorPct,2)}</td><td>${esc(r.error||r.choice)}</td></tr>`).join('');
    el('confirmPlan').disabled=!p.ready;el('exportConfirmed').disabled=!record.confirmed;
  }
  function exportPlan(){
    sync();if(!record.confirmed||record.confirmed.signature!==signature())throw Error('現在のプール案を確認・確定してください。');
    const p=record.confirmed.plan,rows=[['tube','source_well','sample_id','image','roi','area','marker_area','corrected_signal','relative_to_median','volume_uL','rounding_error_pct','included','reason','confirmed_at','source_sha256','algorithm_version']];
    for(const r of p.samples)rows.push([r.group,r.well,r.sampleId,r.imageName,r.lane,r.area,r.markerArea,r.signal,r.relativeToMedian,r.volume,r.roundingErrorPct,r.used,r.error||r.choice,record.confirmed.at,r.sha256,p.version]);
    download(record.name+'_pool.csv','\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8');
  }
  async function saveRecord(){
    sync();if(!record.plate||!record.sessions.length)throw Error('プレートと泳動画像を登録してください。');
    if(record.confirmed?.signature!==signature())record.confirmed=null;
    const snapshot=copy(record),project=el('projectSelect').value,name=snapshot.name;
    const key=await putBlob(encoder.encode(JSON.stringify(snapshot)));
    const payload={...copy(snapshot.plate),recordType:'electrophoresis',electrophoresis:{version:1,blob:key,images:snapshot.sessions.map(s=>({name:s.image.name,sha256:s.image.sha256})),confirmed:!!snapshot.confirmed}};
    const saved=await request('/api/logs',{name,payload,project_id:project}),verified=await request('/api/logs/'+encodeURIComponent(saved.id));
    if(verified.project_id!==project||JSON.stringify(verified.payload.electrophoresis)!==JSON.stringify(payload.electrophoresis))throw Error('保存の照合に失敗しました。実験一式JSONを保存してください。');
    dirty=false;el('recordStatus').textContent='DB保存済み：'+name;
    history.replaceState(null,'','/electrophoresis?log='+encodeURIComponent(saved.id));el('viewPlate').href='/plates?log='+encodeURIComponent(saved.id);el('viewPlate').hidden=false;await loadFiles();await autosave();dirty=false;
  }
  async function backup(){sync();const full=copy(record);for(const s of full.sessions)s.raw=b64(await getBlob(s.image.sha256));download(record.name+'_experiment.json',JSON.stringify(full),'application/json')}
  async function start(){
    // The mapping module also serves the older Packer page. This workflow applies directly.
    mapping=PlatePackGelLinkUI({getSnapshot:()=>record.plate,getState:()=>record.links,setState:v=>{record.links=v;invalidate();autosave()},onApply:result=>guarded(()=>applyMapping(result))});
    el('gelLinkBtn').onclick=()=>{if(state&&record.plate)mapping.open(state);else toast('プレートと泳動画像を登録してください。')};
    el('addImage').onclick=()=>el('upload').click();el('newProject').onclick=()=>guarded(async()=>{const p=await PlatePackProjects.create(el('projectSelect').value);if(p)await loadProjects(p.id)});
    el('projectSelect').onchange=()=>guarded(async()=>{await loadFiles();await autosave()});
    el('experimentName').oninput=()=>autosave();
    el('loadPlate').onclick=()=>guarded(async()=>{const ref=el('plateRecord').value;if(ref)await openEntry(ref)});
    el('runSelect').onchange=()=>guarded(async()=>{sync();const s=record.sessions.find(x=>x.image.sha256===el('runSelect').value);if(s)await adopt(await api('/api/restore',s))});
    el('assignGroups').onclick=()=>guarded(assignGroups);el('measureAll').onclick=()=>guarded(measure);
    el('reviewPlan').onclick=()=>guarded(plan);el('register').onclick=()=>guarded(plan);
    el('closePlan').onclick=()=>el('planDialog').close();
    el('confirmPlan').onclick=()=>guarded(async()=>{if(!proposal||proposal.signature!==signature())throw Error('設定が変わりました。プール案を再計算してください。');record.confirmed={...copy(proposal),at:new Date().toISOString()};render();await autosave();el('recordStatus').textContent='プール確定 · DB未保存';el('planDialog').close()});
    el('exportPool').onclick=()=>guarded(exportPlan);el('exportConfirmed').onclick=()=>guarded(exportPlan);
    el('downloadOriginal').onclick=()=>guarded(async()=>{if(state)download(state.image.name,await getBlob(state.image.sha256),'application/octet-stream')});
    el('saveExperiment').onclick=()=>guarded(saveRecord);el('backupExperiment').onclick=()=>guarded(backup);
    el('restoreExperiment').onchange=e=>guarded(async()=>{const f=e.target.files[0];if(!f)return;if(f.size>160*1024*1024)throw Error('実験一式JSONは160 MB以下にしてください。');if(dirty&&!confirm('現在の作業を置き換えます。保存済みですか？'))return;await restoreRecord(JSON.parse(await f.text()));el('recordStatus').textContent='復元済み'});
    el('save').onclick=()=>guarded(async()=>{if(!state)return;const out=copy(state);out.raw=b64(await getBlob(state.image.sha256));download(prefix()+'_gelpool.json',JSON.stringify(out),'application/json')});
    el('sessionFile').onchange=e=>guarded(async()=>{const f=e.target.files[0];if(!f)return;if(!record.plate)throw Error('先にプレートを選択してください。');const s=JSON.parse(await f.text());if(record.sessions.length>=32&&!record.sessions.some(x=>x.image.sha256===s.image?.sha256))throw Error('1実験は32画像までです。');await adopt(await api('/api/restore',s));invalidate()});
    el('mapping').hidden=true; // identities are assigned through the plate dialog only
    window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
    for(const id of ['exportAll','exportPCR','exportPool','measureAll','gelLinkBtn','saveExperiment'])el(id).disabled=true;
    await guarded(async()=>{await loadProjects();const ref=new URLSearchParams(location.search).get('log');if(ref){await openEntry(ref);return;}const draft=await idb('get','draft');if(draft?.sessions?.length){el('recordStatus').textContent='下書きあり';const restore=document.createElement('button');restore.textContent='復元';restore.onclick=()=>guarded(()=>restoreRecord(draft));el('recordStatus').append(' ',restore)} });
  }
  return {api,autosave,render,download,start};
})();
