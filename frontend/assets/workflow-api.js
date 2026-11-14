window.PCRWorkflowAPI=(()=>{
  const request=(path,data,method='POST')=>PlatePackStorage.fetchJson(path,data===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
  async function upload(file,progress){
    if(!file.size||file.size>96*1024*1024)throw Error('画像は96 MB以下にしてください。');
    const bytes=new Uint8Array(await file.arrayBuffer()),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const base='/api/electrophoresis/blobs/'+hash;let exists=false;try{await request(base);exists=true;}catch{}
    if(!exists){const size=256*1024,chunks=Math.ceil(bytes.length/size);for(let i=0;i<chunks;i++){progress?.(i+1,chunks);await request(base+'/chunks/'+i,{data:b64(bytes.subarray(i*size,(i+1)*size))},'PUT');}await request(base+'/complete',{chunks,size:bytes.length});}
    return hash;
  }
  return {request,upload};
})();
