/* Open the save picker during the click, before fetching or rendering the file. */
window.PCRSaveFile=(()=>{
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const filename=name=>String(name||'PCR').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_');
  function browserSave(name){
    return new Promise(resolve=>{
      const dialog=node('dialog'),heading=node('h2','保存先を選んで保存'),help=node('p','このブラウザでは、サイトから保存先の選択画面を開けません。ブラウザのダウンロード設定で「保存前に保存先を確認する」を有効にしてください。設定が無効のまま続けると、通常のダウンロード先に保存されます。'),file=node('p',name),actions=node('div'),cancel=node('button','キャンセル'),proceed=node('button','ブラウザの保存機能で続ける');
      dialog.style.cssText='max-width:min(32rem,90vw);padding:24px;border:1px solid #bdd0c9;border-radius:14px;color:#18372e;background:white;';help.style.cssText='line-height:1.7;max-width:30rem;';file.style.overflowWrap='anywhere';actions.className='dialog-actions';cancel.type=proceed.type='button';proceed.className='primary';let accepted=false;
      cancel.onclick=()=>dialog.close();proceed.onclick=()=>{accepted=true;dialog.close();};dialog.onclose=()=>{dialog.remove();resolve(accepted);};actions.append(cancel,proceed);dialog.append(heading,help,file,actions);document.body.append(dialog);dialog.showModal();
    });
  }
  async function save(name,content,type='application/octet-stream'){
    name=filename(name);let writable;
    try{
      let handle=null;
      if(typeof window.showSaveFilePicker==='function'){
        try{handle=await window.showSaveFilePicker({suggestedName:name,id:'pcr-save'});}
        catch(error){if(error.name!=='SecurityError')throw error;}
      }
      if(!handle&&!await browserSave(name))return false;
      const data=typeof content==='function'?await content():await content;
      if(data==null)throw Error('保存するファイルを作成できませんでした。');
      const blob=data instanceof Blob?data:new Blob([data],{type});
      if(handle){writable=await handle.createWritable();await writable.write(blob);await writable.close();writable=null;}
      else{const url=URL.createObjectURL(blob),link=node('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
      return true;
    }catch(error){if(writable)try{await writable.abort();}catch{}if(error.name!=='AbortError')alert('保存できませんでした。'+error.message);return false;}
  }
  const canvas=(name,image)=>save(name,()=>new Promise((resolve,reject)=>image.toBlob(blob=>blob?resolve(blob):reject(Error('PNGを作成できませんでした。')),'image/png')),'image/png');
  const url=(name,path)=>save(name,async()=>{const response=await fetch(path);if(!response.ok)throw Error('元ファイルを取得できませんでした。');return response.blob();});
  function many(files){
    const dialog=node('dialog'),heading=node('h2','ファイルごとに保存先を選択'),help=node('p','保存するファイルのボタンを押してください。'),list=node('div'),close=node('button','閉じる');dialog.style.cssText='max-width:min(36rem,90vw);padding:24px;border:1px solid #bdd0c9;border-radius:14px;';
    for(const file of files){const row=node('p'),label=node('span',file.name+' '),button=node('button','保存先を選ぶ'),status=node('span');button.type='button';button.onclick=async()=>{button.disabled=true;const saved=await save(file.name,file.content,file.type);status.textContent=saved?' 保存済み':' 未保存';button.disabled=false;};row.append(label,button,status);list.append(row);}
    close.type='button';close.onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();dialog.append(heading,help,list,close);document.body.append(dialog);dialog.showModal();
  }
  return {save,canvas,url,many};
})();
