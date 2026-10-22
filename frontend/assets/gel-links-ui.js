/* PlatePack dialog: choose an ROI, then a source or packed well. */
window.PlatePackGelLinkUI = function ({getSnapshot,getState,setState,onApply}) {
  const core=window.PlatePackGelLinks, esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dialog=document.createElement('dialog');dialog.id='gelLinkDialog';
  dialog.innerHTML=`<div class="gl-top"><h2>ROI対応</h2><button type="button" data-el="close">閉じる</button></div>
    <div class="gl-tools"><button type="button" data-el="import">解析JSONを開く</button><input data-el="file" type="file" accept=".json,application/json" hidden><label>泳動画像 <select data-el="gel" aria-label="対応づける泳動画像"></select></label><button type="button" data-el="undo">元に戻す</button><button type="button" data-el="export">対応JSON ↓</button><button type="button" data-el="csv">対応CSV ↓</button></div>
    <div data-el="message" class="gl-message" role="status">画像未登録</div>
    <div class="gl-columns"><section class="gl-pane"><div class="gl-tools"><label>ROI番号 <select data-el="roi" aria-label="対応づけるROI番号"></select></label><label>拡大 <select data-el="zoom" aria-label="泳動画像の拡大"><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option></select></label><button type="button" data-el="unlink">対応解除</button></div><div class="gl-image"><div class="gl-image-inner" data-el="imageInner"><img data-el="image" alt="GelPoolの泳動画像"><div data-el="overlay" class="gl-overlay"></div></div></div><p data-el="info"></p><label><input data-el="skip" type="checkbox">空レーン（除外）</label></section>
    <section class="gl-pane"><div class="gl-tools"><label>プレート <select data-el="kind" aria-label="対応づけるプレートの種類"><option value="packed">パッキング後</option><option value="source">元プレート</option></select></label><select data-el="plate" aria-label="対応づけるプレート"></select><label><input data-el="next" type="checkbox" checked>自動で次へ</label></div><div data-el="grid" class="gl-grid"></div><p data-el="summary"></p></section></div>
    <div class="gl-table"><table><thead><tr><th>ROI</th><th>検出</th><th>指定先</th><th>元プレート・ウェル</th><th>確認</th></tr></thead><tbody data-el="rows"></tbody></table></div>`;
  document.body.append(dialog);
  const $=key=>dialog.querySelector(`[data-el="${key}"]`);
  const sessions=new Map();let hash=null,roiId=null,undo=[];
  const selectedGel=()=>getState()?.gels.find(g=>g.sha256===hash);
  const selectedRoi=()=>selectedGel()?.rois.find(r=>r.id===roiId);
  function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
  function apply(next){undo.push(JSON.parse(JSON.stringify(getState())));if(undo.length>30)undo.shift();setState(next);render();}
  function run(fn){try{fn()}catch(e){message(e.message,true)}}
  function status(r){return r.status==='detected'?'検出':r.status==='undetected'?'未検出・微弱':r.status==='review'?'要確認':'未判定'}
  function plateOptions(){
    const snapshot=getSnapshot(),kind=$('kind').value,prior=$('plate').value;
    const options=kind==='packed'?(snapshot.packedPlates||[]).map(p=>({id:p.id,label:p.id})):snapshot.plates.map((p,i)=>({id:String(i+1),label:`${i+1} · ${p.label}`}));
    $('plate').innerHTML=options.map(p=>`<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
    if(options.some(p=>p.id===prior))$('plate').value=prior;
  }
  function drawGrid(){
    const snapshot=getSnapshot(),gel=selectedGel(),selected=selectedRoi(),kind=$('kind').value,key=$('plate').value;
    let html='<span></span>'+Array.from({length:12},(_,i)=>`<span class="axis">${i+1}</span>`).join('');
    for(const row of 'ABCDEFGH'){
      html+=`<span class="axis">${row}</span>`;
      for(let c=1;c<=12;c++){
        const well=row+c;let binding=null;try{binding=core.resolve(snapshot,kind,key,well)}catch{}
        const link=binding&&gel?.rois.find(r=>r.binding?.sourcePlate===binding.sourcePlate && r.binding.sourceWell===binding.sourceWell);
        html+=`<button type="button" data-well="${well}" aria-label="ウェル ${well}" title="${esc(binding?`元 ${binding.sourcePlate}-${binding.sourceWell}`:'検体なし')}" ${!binding||!selected?'disabled':''} class="${link?'linked':''} ${link?.id===roiId?'selected':''}">${well}<small>${link?'#'+link.id:binding?'●':'—'}</small></button>`;
      }
    }
    $('grid').innerHTML=html;
    $('grid').querySelectorAll('button').forEach(b=>b.onclick=()=>run(()=>{
      const oldId=roiId,next=core.bind(getState(),getSnapshot(),hash,roiId,$('kind').value,$('plate').value,b.dataset.well);
      apply(next);message(`ROI #${oldId} → ${$('plate').value} / ${b.dataset.well} を保存しました。`);
      if($('next').checked){const rois=selectedGel().rois,index=rois.findIndex(r=>r.id===oldId);if(index<rois.length-1){roiId=rois[index+1].id;render()}}
    }));
  }
  function render(){
    const state=getState(),snapshot=getSnapshot();core.validate(state);
    if(!state.gels.some(g=>g.sha256===hash))hash=state.gels[0]?.sha256||null;
    const gel=selectedGel();if(!gel?.rois.some(r=>r.id===roiId))roiId=gel?.rois[0]?.id||null;
    $('gel').innerHTML=state.gels.map(g=>`<option value="${esc(g.sha256)}">${esc(g.name)}</option>`).join('');$('gel').value=hash||'';
    $('roi').innerHTML=(gel?.rois||[]).map(r=>`<option value="${r.id}">#${r.id} · ${status(r)}${r.binding?' · 指定済み':r.skipped?' · 空レーン':''}</option>`).join('');$('roi').value=roiId||'';
    $('image').hidden=!gel;if(gel&&$('image').getAttribute('src')!==gel.preview)$('image').src=gel.preview;
    $('imageInner').style.width=(+$('zoom').value*100)+'%';
    $('overlay').innerHTML=(gel?.rois||[]).map(r=>`<button type="button" aria-label="ROI ${r.id}" data-roi="${r.id}" class="${r.binding?'linked':''} ${r.id===roiId?'selected':''}" style="left:${100*(r.x-gel.roiWidth/2)/gel.width}%;top:${100*(r.y-gel.roiHeight/2)/gel.height}%;width:${100*gel.roiWidth/gel.width}%;height:${100*gel.roiHeight/gel.height}%"><span>${r.id}</span></button>`).join('');
    $('overlay').querySelectorAll('button').forEach(b=>b.onclick=()=>{roiId=+b.dataset.roi;render()});
    const r=selectedRoi();$('skip').checked=!!r?.skipped;$('skip').disabled=!r;
    $('info').textContent=r?`ROI #${r.id} · ${status(r)} · 積分値 ${r.area??'不明'} · `+(r.binding?`${r.binding.plateKey} / ${r.binding.well} → 元 ${r.binding.sourcePlate}-${r.binding.sourceWell}`:r.skipped?'空レーンとして除外':'ウェル未指定'):'';
    $('rows').innerHTML=(gel?.rois||[]).map(r=>{const b=r.binding,error=r.skipped?'空レーン（除外）':core.bindingError(snapshot,b);return `<tr class="${r.id===roiId?'selected':''}" data-roi="${r.id}"><td><button type="button">#${r.id}</button></td><td>${status(r)}</td><td>${b?esc((b.kind==='packed'?'出力 ':'元 ')+b.plateKey+' / '+b.well):'—'}</td><td>${b?esc(b.sourcePlate+'-'+b.sourceWell):'—'}</td><td>${esc(error||'対応済み')}</td></tr>`}).join('');
    $('rows').querySelectorAll('tr').forEach(tr=>tr.querySelector('button').onclick=()=>{roiId=+tr.dataset.roi;render()});
    $('summary').textContent=gel?`${gel.rois.filter(r=>r.binding).length} / ${gel.rois.length} 対応 · 空レーン ${gel.rois.filter(r=>r.skipped).length} · 要確認 ${gel.rois.filter(r=>r.binding&&core.bindingError(snapshot,r.binding)).length}`:'';
    $('export').disabled=!gel;$('csv').disabled=!gel;$('unlink').disabled=!r?.binding&&!r?.skipped;$('undo').disabled=!undo.length;
    drawGrid();updateSummary();
  }
  function updateSummary(){const state=getState();const all=state?.gels.flatMap(g=>g.rois)||[];document.getElementById('gelLinkSummary').textContent=all.length?`ROI対応：${all.filter(r=>r.binding).length} / ${all.length}（${state.gels.length}画像）`:'';}
  function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  $('close').onclick=()=>dialog.close();$('import').onclick=()=>$('file').click();
  $('file').onchange=async()=>{const f=$('file').files[0];if(!f)return;try{
    if(f.size>90000000)throw Error('解析JSONは90 MB以下にしてください。');
    const data=JSON.parse(await f.text()),inputs=data.sessions||[data];if(!Array.isArray(inputs)||!inputs.length)throw Error('泳動解析がありません。');
    let next=getState();for(const s of inputs)next=core.importSession(next,s);
    for(const s of inputs)sessions.set(s.image.sha256,s);
    hash=inputs[0].image.sha256;apply(next);message(`${inputs.length}画像を読込済み`);
  }catch(e){message(e.message,true)}finally{$('file').value=''}};
  $('gel').onchange=()=>{hash=$('gel').value;roiId=null;render()};$('roi').onchange=()=>{roiId=+$('roi').value;render()};$('zoom').onchange=render;
  $('kind').onchange=()=>{plateOptions();drawGrid()};$('plate').onchange=drawGrid;
  $('unlink').onclick=()=>run(()=>{const s=JSON.parse(JSON.stringify(getState())),r=s.gels.find(g=>g.sha256===hash).rois.find(r=>r.id===roiId);r.binding=null;r.skipped=false;apply(s);message('対応解除済み')});
  $('skip').onchange=()=>run(()=>{const s=JSON.parse(JSON.stringify(getState())),r=s.gels.find(g=>g.sha256===hash).rois.find(r=>r.id===roiId);r.skipped=$('skip').checked;if(r.skipped)r.binding=null;apply(s);message(r.skipped?'空レーンとして除外':'空レーン指定を解除しました。')});
  $('undo').onclick=()=>{if(undo.length){setState(undo.pop());render();message('直前の対応変更を戻しました。')}};
  $('export').onclick=()=>run(()=>{const result=core.exportSession(getState(),getSnapshot(),sessions.get(hash),hash);if(onApply){onApply(result);dialog.close();return}download(selectedGel().name.replace(/\.[^.]+$/,'')+'_platepack_gelpool.json',JSON.stringify(result,null,2),'application/json');message('対応JSON出力済み')});
  $('csv').onclick=()=>run(()=>{const state=getState(),snapshot=getSnapshot();const rows=[['image','sha256','roi_number','detection','area','plate_kind','plate','well','source_plate','source_well','sample_id','mapping_status']];for(const g of state.gels)for(const r of g.rois){const b=r.binding;rows.push([g.name,g.sha256,r.id,status(r),r.area,b?.kind,b?.plateKey,b?.well,b?.sourcePlate,b?.sourceWell,b?core.sampleId(state,b):'',r.skipped?'空レーン（除外）':core.bindingError(snapshot,b)||'対応済み'])}const cell=v=>{let t=String(v??'');if(typeof v!=='number'&&/^[=+@-]/.test(t))t="'"+t;return '"'+t.replace(/"/g,'""')+'"'};download('PlatePack_ROI_mapping.csv','\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');message('対応CSV出力済み')});
  function openDialog(){undo=[];if(!getState())setState(core.empty(crypto.randomUUID()));plateOptions();if(!$('plate').options.length){$('kind').value='source';plateOptions()}render();message('');dialog.showModal()};
  document.getElementById('gelLinkBtn').onclick=openDialog;
  if(onApply){$('gel').parentElement.hidden=true;$('import').hidden=true;$('export').textContent='適用';}
  return {refresh:updateSummary,open(session){if(!getState())setState(core.empty(crypto.randomUUID()));sessions.set(session.image.sha256,session);hash=session.image.sha256;setState(core.importSession(getState(),session));openDialog();}};
};
