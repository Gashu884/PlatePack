window.PCRFreePoolingUI=({host,getRecord,getActive,onChange,onSaveSet,onRecalculate,onExport,onExportPNG})=>{
  const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;},fmt=(x,d=3)=>x==null?'—':Number(x).toLocaleString('ja-JP',{maximumFractionDigits:d});
  const rowNodes=new Map();let rowOrder='',savingSet=false;
  const heading=node('div','free-heading'),title=node('h2','','バンドを選んで分注量を計算'),summary=node('p','free-summary'),tools=node('div','free-tools'),fields=node('div','free-fields'),status=node('p','free-status'),tableWrap=node('div','table-scroll'),table=node('table','free-table');
  const choose=node('select'),name=node('input'),reference=node('select'),volume=node('input'),step=node('input');
  choose.setAttribute('aria-label','計算セット');name.setAttribute('aria-label','計算セット名');reference.setAttribute('aria-label','相対値の基準');volume.setAttribute('aria-label','基準バンドの分注量');step.setAttribute('aria-label','液量の丸め刻み');
  name.placeholder='セット名を入力';name.maxLength=120;
  volume.type=step.type='number';volume.min='0.001';step.min='0';volume.step=step.step='0.1';status.setAttribute('role','status');
  const saveNotice=node('p','free-save-status');saveNotice.setAttribute('role','status');
  const label=(text,control)=>{const n=node('label','',text);n.append(control);return n;};
  function pools(){return getRecord().freePools||[];}
  function current(){return PCRFreePooling.working(getRecord());}
  function change(){saveNotice.textContent='';const p=current();if(String(p.reference).startsWith('band:')&&!p.keys.includes(p.reference.slice(5)))p.reference='max';onChange();}
  const button=(text,fn)=>{const b=node('button','',text);b.type='button';b.onclick=fn;return b;};
  const add=button('セット作成',async()=>{
    if(savingSet)return;
    try{
      const saved=PCRFreePooling.save(getRecord(),crypto.randomUUID(),new Date().toISOString());
      savingSet=true;change();saveNotice.textContent='セットを保存中…';
      const persisted=await onSaveSet(saved);
      saveNotice.textContent=persisted?'「'+saved.name+'」の名前・選択ROI・計算設定を保存しました。':'DB保存を確認できませんでした。現在の組み合わせは画面に保持しています。もう一度「セット作成」で保存してください。';
    }catch(error){saveNotice.textContent=error.message;if(!name.value.trim())name.focus();}
    finally{savingSet=false;render();}
  });
  add.title='現在のセット名・選択ROI・計算設定を保存';
  const all=button('画像ROI全選択',()=>{const s=getActive();if(!s)return;current().keys=[...new Set([...current().keys,...s.config.rois.map(r=>PCRFreePooling.key(s.image.sha256,r.id))])];change();});
  const clear=button('全選択解除',()=>{current().keys=[];change();});
  const recalc=button('面積測定',onRecalculate),exportButton=button('分注 CSV ↓',()=>onExport(current())),pngButton=button('プレート PNG ↓',()=>onExportPNG(current()));pngButton.classList.add('primary');
  heading.append(title,summary);tools.append(choose,add,all,clear,recalc,pngButton,exportButton);
  fields.append(label('セット名（自由に変更）',name),label('相対値の基準',reference),label('基準バンドの分注量 (µL)',volume),label('丸め刻み (µL・0で丸めなし)',step));
  const saveHelp=node('p','hint','「セット作成」で現在の名前・選択ROI・計算設定を保存します。名前を変えて保存すると、別のセットとして残せます。');
  const help=node('p','hint','ラベルは参考表示です。チェックしたバンドだけで計算します。1–20 µLを超えても自動では外しません。');
  const tableHead=node('thead'),headerRow=node('tr'),tableBody=node('tbody');for(const text of ['選択','画像 / ROI','輝度面積','参考ラベル','相対値','分注量 (µL)','備考'])headerRow.append(node('th','',text));tableHead.append(headerRow);table.append(tableHead,tableBody);
  tableWrap.append(table);host.append(heading,tools,fields,saveHelp,saveNotice,help,status,tableWrap);
  choose.onchange=()=>{if(choose.value){PCRFreePooling.select(getRecord(),choose.value);change();}};name.oninput=()=>{current().name=name.value;change();};reference.onchange=()=>{current().reference=reference.value;change();};volume.oninput=()=>{current().referenceVolume=volume.value;change();};step.oninput=()=>{current().step=step.value;change();};
  function render({busy=false,error=''}={}){
    const r=getRecord(),s=getActive(),p=current();let result;
    try{result=PCRFreePooling.calculate(p,r.sessions);}catch(e){error=error||e.message;result={rows:[],count:p.keys.length,computed:0,reference:null,total:0};}
    choose.replaceChildren(new Option('保存したセットを選ぶ',''),...pools().filter(pool=>pool.name).map(pool=>new Option(pool.name+(pool.id===p.id&&!PCRFreePooling.isSaved(r,p)?'（編集中）':''),pool.id)));choose.value=pools().some(pool=>pool.id===p.id&&pool.name)?p.id:'';
    for(const [control,value] of [[name,p.name],[volume,p.referenceVolume],[step,p.step]])if(document.activeElement!==control)control.value=value;
    reference.replaceChildren(new Option('最大面積のバンド','max'),new Option('選択バンドの中央値','median'),new Option('最小面積のバンド','min'),...result.rows.filter(row=>row.area>0).map(row=>new Option(row.image+' #'+row.id,'band:'+row.key)));reference.value=p.reference;
    summary.textContent=`選択 ${p.keys.length}本 · 計算 ${result.computed}本 · 合計 ${busy?'計算中':fmt(result.total)+' µL'}`;
    status.textContent=error||(busy?'面積を取得中…':p.keys.length?`基準面積 ${fmt(result.reference,1)} = 相対値1。面積に反比例する液量です。`:'画像のバンドをクリック、または下のチェックで選択してください。');
    for(const control of [choose,name,reference,volume,step,clear])control.disabled=savingSet;
    add.disabled=savingSet||busy||!!error||!s||!p.keys.length;recalc.disabled=savingSet||busy||!s;all.disabled=savingSet||!s;exportButton.disabled=pngButton.disabled=savingSet||busy||!!error||!result.rows.length;
    const selected=new Map(result.rows.map(row=>[row.key,row]));
    const rows=s?s.config.rois.map((roi,i)=>({key:PCRFreePooling.key(s.image.sha256,roi.id),hash:s.image.sha256,image:s.image.name,id:roi.id,well:roi.well||'',area:s.quantification?.results[i]?.area,flags:s.quantification?.results[i]?.flags||[],status:s.quantification?.results[i]?.status,label:roi.decision||'auto'})):[];
    rows.push(...result.rows.filter(row=>row.hash!==s?.image.sha256));
    const nextOrder=rows.map(row=>row.key).join('|');
    for(const row of rows){
      let entry=rowNodes.get(row.key);
      if(!entry){const line=node('tr'),td=node('td'),check=node('input'),cells=Array.from({length:6},()=>node('td'));check.type='checkbox';td.append(check);line.append(td,...cells);
        check.onchange=()=>{const pool=current();pool.keys=check.checked?[...new Set([...pool.keys,row.key])]:pool.keys.filter(k=>k!==row.key);change();};entry={line,check,cells};rowNodes.set(row.key,entry);}
      entry.line.className=p.keys.includes(row.key)?'is-selected':'';entry.check.checked=p.keys.includes(row.key);entry.check.disabled=savingSet;entry.check.setAttribute('aria-label',row.image+' ROI '+row.id+' を計算に含める');
      const notes=row.flags.filter(flag=>!/(飽和|白飛び)/.test(flag)),labels=[];if(row.status==='undetected')labels.push('微弱');else if(notes.length)labels.push('要確認：'+notes.join(' / '));else labels.push('検出');if(row.label==='repcr')labels.push('再PCR');if(row.label==='exclude')labels.push('除外候補');
      const selectedRow=selected.get(row.key),texts=[row.image+' / #'+(row.id??'不明')+(row.well?' · '+row.well:''),fmt(row.area,1),labels.join(' · '),fmt(busy?null:selectedRow?.relative),fmt(busy?null:selectedRow?.volume),selectedRow?.note||''];
      entry.cells.forEach((cell,index)=>{cell.textContent=texts[index];cell.className=index===2?'free-label':index===5?'hint':index===1||index===3||index===4?'mono':'';});
    }
    if(nextOrder!==rowOrder){tableBody.replaceChildren(...rows.map(row=>rowNodes.get(row.key).line));rowOrder=nextOrder;}
    for(const key of rowNodes.keys())if(!rows.some(row=>row.key===key))rowNodes.delete(key);
    return result;
  }
  return {render,current};
};
