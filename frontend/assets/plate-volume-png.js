window.PCRPlateVolumePNG=(()=>{
  const fmt=n=>n===null||!Number.isFinite(n)?'計算不可':n!==0&&(Math.abs(n)<.0001||Math.abs(n)>=1e7)?n.toExponential(3):Number(n.toPrecision(7)).toString();
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  function render(plate,pool,result,unplacedCount){
    const canvas=document.createElement('canvas'),width=2000,ctx=canvas.getContext('2d'),notes=[];
    for(const [well,rows] of Object.entries(plate.cells))if(rows.length>1)notes.push(well+'：複数の結果（合算なし） '+rows.map(r=>r.image+' #'+r.id+' = '+fmt(r.volume)+' µL').join(' / '));
    if(unplacedCount)notes.unshift('未配置 '+unplacedCount+'件：この図には含まれていません。配置方法を変更すると確認できます。');
    ctx.font='22px sans-serif';const lines=[];
    for(const text of notes){let line='';for(const char of text){if(ctx.measureText(line+char).width>1800){lines.push(line);line='';}line+=char;}if(line)lines.push(line);}
    const height=1470+lines.length*30;if(height>30000)throw Error('注記が多いため、計算セットを分けてPNG保存してください。');
    canvas.width=width;canvas.height=height;ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
    const text=(value,x,y,size=24,color='#18372e',weight=400,align='left')=>{ctx.font=weight+' '+size+'px -apple-system, BlinkMacSystemFont, sans-serif';ctx.fillStyle=color;ctx.textAlign=align;ctx.fillText(String(value),x,y);};
    const fit=(value,x,y,maxWidth,size,color,weight=400,align='left')=>{while(size>14){ctx.font=weight+' '+size+'px sans-serif';if(ctx.measureText(String(value)).width<=maxWidth)break;size-=2;}text(value,x,y,size,color,weight,align);};
    fit(pool.name||'分注量',86,70,1820,46,'#143c32',700);fit(plate.name,86,121,1820,32,'#143c32',600);
    text(plate.caption,86,162,23,'#587168');text('各ウェル内の数値：µL',1890,162,23,'#143c32',600,'right');
    ctx.fillStyle='#f6f9f8';ctx.strokeStyle='#bdd0c9';ctx.lineWidth=3;ctx.beginPath();ctx.roundRect(70,190,1850,1120,40);ctx.fill();ctx.stroke();
    const left=155,top=255,dx=145,dy=130;
    for(let c=0;c<12;c++)text(c+1,left+c*dx+dx/2,234,25,'#526d62',600,'center');
    for(let r=0;r<8;r++){
      text('ABCDEFGH'[r],112,top+r*dy+dy/2+9,29,'#526d62',700,'center');
      for(let c=0;c<12;c++){
        const well='ABCDEFGH'[r]+(c+1),rows=plate.cells[well]||[],x=left+c*dx+dx/2,y=top+r*dy+dy/2;
        ctx.beginPath();ctx.arc(x,y,54,0,Math.PI*2);ctx.fillStyle=rows.length>1?'#fff0de':rows.length?'#daf2e8':'#fff';ctx.fill();ctx.strokeStyle=rows.length>1?'#ce8b31':rows.length?'#298467':'#d7e0dc';ctx.lineWidth=rows.length?3:2;ctx.stroke();
        text(well,x,y-29,17,rows.length?'#31745d':'#98aaa2',500,'center');
        if(rows.length===1)fit(fmt(rows[0].volume),x,y+12,98,35,rows[0].volume===null?'#a46621':'#123f30',700,'center');
        else if(rows.length>1){text('複数 '+rows.length+'件',x,y+7,23,'#95601d',700,'center');text('欄外参照',x,y+31,17,'#95601d',400,'center');}
        else text('—',x,y+12,25,'#c4d0cb',400,'center');
      }
    }
    const rows=Object.values(plate.cells).flat(),total=rows.reduce((sum,r)=>sum+(r.volume||0),0);
    text('表示 '+rows.length+'本 / '+Object.keys(plate.cells).length+'ウェル · 合計 '+fmt(total)+' µL',86,1364,26,'#143c32',600);
    text('基準面積 '+fmt(result.reference)+' · 基準液量 '+pool.referenceVolume+' µL · 丸め刻み '+pool.step+' µL · 目安範囲 '+PCRFreePooling.rangeLabel(pool),86,1403,22,'#587168');
    text('空欄（—）はこの計算セットの対象外。計算不可の値はそのまま表示します。',86,1437,21,'#587168');
    lines.forEach((line,i)=>text(line,86,1472+i*30,22,'#99601a'));
    return canvas;
  }
  function open({record,pool,result}){
    const linked=PCRPlateVolumeMap.build(result,record,{mode:'linked',target:record.plate?.packedPlates?.length?'packed':'source'});
    const dialog=node('dialog'),heading=node('h2','プレート図をPNG保存'),help=node('p','分注量をウェル内に表示します。配置を確認して保存できます。'),controls=node('div'),preview=node('div'),status=node('p'),details=node('details'),list=node('ul'),mode=node('select'),order=node('select'),target=node('select'),plateSelect=node('select'),save=node('button','このプレートをPNG保存'),close=node('button','閉じる');
    dialog.className='plate-png-dialog';controls.className='plate-png-controls';preview.className='plate-png-preview';status.className='plate-png-status';status.setAttribute('role','status');
    mode.setAttribute('aria-label','プレート図の配置方法');order.setAttribute('aria-label','ウェルの並び順');target.setAttribute('aria-label','図にするプレートの種類');plateSelect.setAttribute('aria-label','PNG保存するプレート');
    mode.append(new Option('登録済みのウェル対応を使う','linked'),new Option('ROI番号で配置（対応未設定用）','roi'),new Option('選択順に新しいプレートへ並べる','compact'));
    order.append(new Option('横方向：A1 → A12 → B1','row'),new Option('縦方向：A1 → H1 → A2','column'));target.append(new Option('出力プレート','packed'),new Option('入力プレート','source'));
    mode.value=linked.plates.length?'linked':'roi';target.value=record.plate?.packedPlates?.length?'packed':'source';save.type=close.type='button';save.className='primary';
    const label=(text,select)=>{const n=node('label',text);n.append(select);return n;};controls.append(label('配置方法',mode),label('並び順',order),label('プレートの種類',target),label('保存するプレート',plateSelect));
    details.append(node('summary','配置されていないバンド'),list);const actions=node('div');actions.className='dialog-actions';actions.append(close,save);dialog.append(heading,help,controls,status,details,preview,actions);document.body.append(dialog);
    let model=null,canvas=null;
    function draw(){
      const plate=model?.plates.find(p=>p.key===plateSelect.value);canvas=null;preview.replaceChildren();save.disabled=!plate;
      if(plate){canvas=render(plate,pool,result,model.unplaced.length);canvas.setAttribute('aria-label',plate.name+' の分注量プレート図');preview.append(canvas);}
    }
    function update(){
      try{const previous=plateSelect.value;model=PCRPlateVolumeMap.build(result,record,{mode:mode.value,order:order.value,target:target.value});
        order.parentElement.hidden=mode.value==='linked';target.parentElement.hidden=mode.value!=='linked';
        plateSelect.replaceChildren(...model.plates.map(p=>new Option(p.name,p.key)));if(model.plates.some(p=>p.key===previous))plateSelect.value=previous;
        status.textContent=mode.value==='linked'?(model.unplaced.length?'未配置 '+model.unplaced.length+'本。ROI番号や選択順の配置にも切り替えられます。':'登録済みのウェル位置に分注量を表示しています。'):'ウェル対応を使わない配置です。実際のプレートの並びに合わせて、横・縦の順序を確認できます。';
        list.replaceChildren(...model.unplaced.map(r=>node('li',r.image+' #'+r.id+'：'+r.reason)));details.hidden=!model.unplaced.length;draw();
      }catch(error){status.textContent=error.message;save.disabled=true;preview.replaceChildren();}
    }
    mode.onchange=order.onchange=target.onchange=update;plateSelect.onchange=draw;close.onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();
    save.onclick=async()=>{if(!canvas)return;const selectedCanvas=canvas,selectedName=model.plates.find(p=>p.key===plateSelect.value).name;save.disabled=true;try{const saved=await PCRSaveFile.canvas((pool.name||'分注量')+'_'+selectedName+'.png',selectedCanvas);status.textContent=saved?'PNGを保存しました。ほかのプレートも切り替えて保存できます。':'保存していません。';}finally{save.disabled=!canvas;}};
    update();dialog.showModal();return dialog;
  }
  return {open,render};
})();
