/* Image registration is a persistent project tab; upload does not navigate. */
window.PCRGelRegistration = ({host,item,projectId,onState,onSaved,onAnalyze}) => {
  const api=PCRWorkflowAPI.request,node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const box=node('section','gel-registration'),heading=node('h2','',item.name+' · 泳動写真の登録'),help=node('p','gel-registration-help','48・96サンプルの泳動画像に対応。8-bit / 16-bitのグレースケールTIFF・PNGを登録できます。'),form=node('form','gel-registration-form'),input=node('input'),choose=node('button','btn','画像を選択'),filename=node('span','gel-registration-filename','未選択'),submit=node('button','btn primary','登録'),status=node('p','gel-registration-status'),list=node('div','gel-registration-images');
  const drop=node('div','gel-registration-drop'),dropTitle=node('strong','','ここに泳動画像をドラッグ＆ドロップ'),dropHelp=node('span','','ドロップすると、そのまま登録します。画像の貼り付けもできます。');
  let busy=false,selected=null;
  input.type='file';input.accept='.tif,.tiff,.png,image/png,image/tiff';input.hidden=true;choose.type='button';submit.type='submit';submit.disabled=true;status.setAttribute('role','status');list.setAttribute('aria-label','登録済みの泳動写真');
  drop.tabIndex=0;drop.setAttribute('role','group');drop.setAttribute('aria-label','泳動画像をドロップまたは貼り付け');drop.append(dropTitle,dropHelp);
  form.append(choose,input,filename,submit);box.append(heading,help,drop,form,status,node('h3','','登録済みの画像'),list);host.append(box);
  const state=()=>onState({busy,dirty:!!selected});
  function controls(){choose.disabled=busy;submit.disabled=busy||!selected;drop.setAttribute('aria-busy',String(busy));state();}
  async function load(){
    const images=(await api('/api/workflow/attachments?project_id='+encodeURIComponent(projectId))).filter(image=>image.origin_key===item.origin);
    list.replaceChildren();
    for(const image of images){const row=node('div','gel-registration-image'),name=node('span','',image.name),download=node('a','','元画像を保存'),analyze=node('button','btn','バンド定量を開く');download.href='/api/workflow/attachments/'+encodeURIComponent(image.id)+'/file';download.onclick=event=>{event.preventDefault();PCRSaveFile.url(image.name,download.href);};analyze.type='button';analyze.onclick=()=>onAnalyze(image);row.append(name,download,analyze);list.append(row);}
    if(!images.length)list.append(node('p','gel-registration-help','登録済みの画像はありません。'));
  }
  function select(files){
    if(busy)return false;
    const all=Array.from(files||[]);selected=null;input.value='';filename.textContent='未選択';
    if(all.length!==1){status.textContent='画像は1枚ずつ登録してください。';controls();return false;}
    const file=all[0];
    if(!/\.(tiff?|png)$/i.test(file.name)){status.textContent='TIFFまたはPNG画像を選んでください。';controls();return false;}
    if(!file.size||file.size>96*1024*1024){status.textContent='画像は空でない96 MB以下のファイルを選んでください。';controls();return false;}
    selected=file;filename.textContent=file.name;status.textContent='';controls();return true;
  }
  async function register(){
    if(busy||!selected)return;
    busy=true;controls();status.textContent='画像を保存中…';
    try{
      if(item.entry.ref.startsWith('local:'))throw Error('画像を登録する前に、このプレートをDBへ登録してください。');
      const file=selected,hash=await PCRWorkflowAPI.upload(file,(n,total)=>status.textContent='画像を保存中… '+n+'/'+total);
      await api('/api/workflow/attachments',{ref:item.entry.ref,index:item.index,name:file.name,sha256:hash});
      selected=null;input.value='';filename.textContent='未選択';onSaved();
      status.textContent=file.name+' を保存しました。';await load().catch(()=>{status.textContent+=' 一覧を更新できませんでした。タブを開き直してください。';});
    }catch(error){status.textContent=error.message;}finally{busy=false;controls();}
  }
  choose.onclick=()=>input.click();input.onchange=()=>{if(input.files.length)select(input.files);};
  form.onsubmit=event=>{event.preventDefault();return register();};
  box.ondragover=event=>{event.preventDefault();event.dataTransfer.dropEffect=busy?'none':'copy';if(!busy)drop.classList.add('is-dragging');};
  box.ondragleave=event=>{if(!box.contains(event.relatedTarget))drop.classList.remove('is-dragging');};
  box.ondrop=event=>{event.preventDefault();drop.classList.remove('is-dragging');if(select(event.dataTransfer.files))return register();};
  box.onpaste=event=>{const files=event.clipboardData?.files;if(files?.length){event.preventDefault();if(select(files))return register();}};
  busy=true;controls();load().catch(error=>status.textContent=error.message).finally(()=>{busy=false;controls();});
};
