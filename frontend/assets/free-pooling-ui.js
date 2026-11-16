window.PCRFreePoolingUI=({host,getRecord,getActive,onChange,onRecalculate,onExport})=>{
  const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;},fmt=(x,d=3)=>x==null?'—':Number(x).toLocaleString('ja-JP',{maximumFractionDigits:d});
  const rowNodes=new Map();let rowOrder='';
  const heading=node('div','free-heading'),title=node('h2','','バンドを選んで分注量を計算'),summary=node('p','free-summary'),tools=node('div','free-tools'),fields=node('div','free-fields'),status=node('p','free-status'),tableWrap=node('div','table-scroll'),table=node('table','free-table');
  const choose=node('select'),name=node('input'),reference=node('select'),volume=node('input'),step=node('input');
  choose.setAttribute('aria-label','計算セット');name.setAttribute('aria-label','計算セット名');reference.setAttribute('aria-label','相対値の基準');volume.setAttribute('aria-label','基準バンドの分注量');step.setAttribute('aria-label','液量の丸め刻み');
  volume.type=step.type='number';volume.min='0.001';step.min='0';volume.step=step.step='0.1';status.setAttribute('role','status');
  const label=(text,control)=>{const n=node('label','',text);n.append(control);return n;};
  function pools(){const r=getRecord();if(!r.freePools?.length)r.freePools=[PCRFreePooling.create('pool-1','セット1')];return r.freePools;}
  function current(){const r=getRecord(),all=pools();return all.find(p=>p.id===r.freePoolId)||all[0];}
  function change(){const p=current();if(String(p.reference).startsWith('band:')&&!p.keys.includes(p.reference.slice(5)))p.reference='max';onChange();}
  const button=(text,fn)=>{const b=node('button','',text);b.type='button';b.onclick=fn;return b;};
  const add=button('＋ セット',()=>{const p=PCRFreePooling.create(crypto.randomUUID(),'セット'+(pools().length+1));pools().push(p);getRecord().freePoolId=p.id;change();});
  const clone=button('セットを複製',()=>{const p=JSON.parse(JSON.stringify(current()));p.id=crypto.randomUUID();p.name+=' コピー';pools().push(p);getRecord().freePoolId=p.id;change();});
  const all=button('この画像を全選択',()=>{const s=getActive();if(!s)return;current().keys=[...new Set([...current().keys,...s.config.rois.map(r=>PCRFreePooling.key(s.image.sha256,r.id))])];change();});
  const clear=button('選択を解除',()=>{current().keys=[];change();});
  const recalc=button('面積を再測定',onRecalculate),exportButton=button('分注 CSV ↓',()=>onExport(current()));exportButton.classList.add('primary');
  heading.append(title,summary);tools.append(choose,add,clone,all,clear,recalc,exportButton);
  fields.append(label('セット名',name),label('相対値の基準',reference),label('基準バンドの分注量 (µL)',volume),label('丸め刻み (µL・0で丸めなし)',step));
  const help=node('p','hint','ラベルは参考表示です。チェックしたバンドだけで計算します。1–20 µLを超えても自動では外しません。');
  const tableHead=node('thead'),headerRow=node('tr'),tableBody=node('tbody');for(const text of ['選択','画像 / ROI','輝度面積','参考ラベル','相対値','分注量 (µL)','備考'])headerRow.append(node('th','',text));tableHead.append(headerRow);table.append(tableHead,tableBody);
  tableWrap.append(table);host.append(heading,tools,fields,help,status,tableWrap);
  choose.onchange=()=>{getRecord().freePoolId=choose.value;change();};name.oninput=()=>{current().name=name.value;change();};reference.onchange=()=>{current().reference=reference.value;change();};volume.oninput=()=>{current().referenceVolume=volume.value;change();};step.oninput=()=>{current().step=step.value;change();};
  function render({busy=false,error=''}={}){
    const r=getRecord(),s=getActive(),p=current();let result;
    try{result=PCRFreePooling.calculate(p,r.sessions);}catch(e){error=error||e.message;result={rows:[],count:p.keys.length,computed:0,reference:null,total:0};}
    choose.replaceChildren(...pools().map(pool=>new Option(pool.name||'名称未設定',pool.id)));choose.value=p.id;
    for(const [control,value] of [[name,p.name],[volume,p.referenceVolume],[step,p.step]])if(document.activeElement!==control)control.value=value;
    reference.replaceChildren(new Option('最大面積のバンド','max'),new Option('選択バンドの中央値','median'),new Option('最小面積のバンド','min'),...result.rows.filter(row=>row.area>0).map(row=>new Option(row.image+' #'+row.id,'band:'+row.key)));reference.value=p.reference;
    summary.textContent=`選択 ${p.keys.length}本 · 計算 ${result.computed}本 · 合計 ${busy?'計算中':fmt(result.total)+' µL'}`;
    status.textContent=error||(busy?'面積を取得中…':p.keys.length?`基準面積 ${fmt(result.reference,1)} = 相対値1。面積に反比例する液量です。`:'画像のバンドをクリック、または下のチェックで選択してください。');
    recalc.disabled=busy||!s;all.disabled=!s;exportButton.disabled=busy||!!error||!result.rows.length;
    const selected=new Map(result.rows.map(row=>[row.key,row]));
    const rows=s?s.config.rois.map((roi,i)=>({key:PCRFreePooling.key(s.image.sha256,roi.id),hash:s.image.sha256,image:s.image.name,id:roi.id,well:roi.well||'',area:s.quantification?.results[i]?.area,flags:s.quantification?.results[i]?.flags||[],status:s.quantification?.results[i]?.status,label:roi.decision||'auto'})):[];
    rows.push(...result.rows.filter(row=>row.hash!==s?.image.sha256));
    const nextOrder=rows.map(row=>row.key).join('|');
    for(const row of rows){
      let entry=rowNodes.get(row.key);
      if(!entry){const line=node('tr'),td=node('td'),check=node('input'),cells=Array.from({length:6},()=>node('td'));check.type='checkbox';td.append(check);line.append(td,...cells);
        check.onchange=()=>{const pool=current();pool.keys=check.checked?[...new Set([...pool.keys,row.key])]:pool.keys.filter(k=>k!==row.key);change();};entry={line,check,cells};rowNodes.set(row.key,entry);}
      entry.line.className=p.keys.includes(row.key)?'is-selected':'';entry.check.checked=p.keys.includes(row.key);entry.check.setAttribute('aria-label',row.image+' ROI '+row.id+' を計算に含める');
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
