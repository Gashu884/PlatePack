/* Image registration is a persistent project tab; upload does not navigate. */
window.PCRGelRegistration = ({host,item,projectId,onState,onSaved,onAnalyze}) => {
  const api=PCRWorkflowAPI.request,node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const box=node('section','gel-registration'),heading=node('h2','',item.name+' · 泳動写真の登録'),help=node('p','gel-registration-help','8-bit / 16-bitのグレースケールTIFF・PNGを登録できます。'),form=node('form','gel-registration-form'),input=node('input'),choose=node('button','btn','画像を選択'),filename=node('span','gel-registration-filename','未選択'),submit=node('button','btn primary','登録'),status=node('p','gel-registration-status'),list=node('div','gel-registration-images');
  let busy=false,selected=null;
  input.type='file';input.accept='.tif,.tiff,.png,image/png,image/tiff';input.hidden=true;choose.type='button';submit.type='submit';submit.disabled=true;status.setAttribute('role','status');list.setAttribute('aria-label','登録済みの泳動写真');
  form.append(choose,input,filename,submit);box.append(heading,help,form,status,node('h3','','登録済みの画像'),list);host.append(box);
  const state=()=>onState({busy,dirty:!!selected});
  function controls(){choose.disabled=busy;submit.disabled=busy||!selected;state();}
  async function load(){
    const images=(await api('/api/workflow/attachments?project_id='+encodeURIComponent(projectId))).filter(image=>image.origin_key===item.origin);
    list.replaceChildren();
    for(const image of images){const row=node('div','gel-registration-image'),name=node('span','',image.name),download=node('a','','元画像を保存'),analyze=node('button','btn','バンド定量を開く');download.href='/api/workflow/attachments/'+encodeURIComponent(image.id)+'/file';download.download=image.name;analyze.type='button';analyze.onclick=()=>onAnalyze(image);row.append(name,download,analyze);list.append(row);}
    if(!images.length)list.append(node('p','gel-registration-help','登録済みの画像はありません。'));
  }
  choose.onclick=()=>input.click();input.onchange=()=>{selected=input.files[0]||null;filename.textContent=selected?.name||'未選択';controls();};
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||!selected)return;
    busy=true;controls();status.textContent='画像を保存中…';
    try{
      if(item.entry.ref.startsWith('local:'))throw Error('画像を登録する前に、このプレートをDBへ登録してください。');
      const file=selected,hash=await PCRWorkflowAPI.upload(file,(n,total)=>status.textContent='画像を保存中… '+n+'/'+total);
      await api('/api/workflow/attachments',{ref:item.entry.ref,index:item.index,name:file.name,sha256:hash});
      selected=null;input.value='';filename.textContent='未選択';onSaved();
      status.textContent=file.name+' を保存しました。';await load();
    }catch(error){status.textContent=error.message;}finally{busy=false;controls();}
  };
  busy=true;controls();load().catch(error=>status.textContent=error.message).finally(()=>{busy=false;controls();});
};
