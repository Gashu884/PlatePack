/* Manual ROI identity links. No densitometry or pooling values are inferred. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlatePackGelLinks = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const clone = x => JSON.parse(JSON.stringify(x));
  const isWell = x => typeof x === 'string' && /^[A-H](?:[1-9]|1[0-2])$/.test(x);
  const hashOK = x => typeof x === 'string' && /^[a-f0-9]{64}$/i.test(x);
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  function empty(namespace) { return { version: 1, namespace, gels: [] }; }
  function validate(state) {
    if (state == null) return;
    if (state.version !== 1 || typeof state.namespace !== 'string' || !/^[\w-]{1,80}$/.test(state.namespace) || !Array.isArray(state.gels)) throw Error('ROI対応表の形式が不正です。');
    const hashes = new Set();
    for (const g of state.gels) {
      if (!hashOK(g.sha256) || hashes.has(g.sha256) || typeof g.name !== 'string' || ![g.width,g.height,g.roiWidth,g.roiHeight].every(n => finite(n) && n > 0) || g.width*g.height > 30000000 || !Array.isArray(g.rois) || g.rois.length > 384) throw Error('泳動画像・ROIの情報が不正です。');
      hashes.add(g.sha256);
      if (typeof g.preview !== 'string' || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(g.preview) || g.preview.length > 45000000) throw Error('泳動プレビューの形式が不正です。');
      const ids = new Set(), sources = new Set();
      for (const r of g.rois) {
        if (!Number.isInteger(r.id) || r.id<1 || ids.has(r.id) || !finite(r.x) || !finite(r.y) || r.x<0 || r.y<0 || r.x>=g.width || r.y>=g.height) throw Error('ROI番号または座標が不正です。');
        ids.add(r.id);
        if(r.skipped!==undefined&&typeof r.skipped!=='boolean' || r.skipped&&r.binding)throw Error('空レーンとウェル対応を同時には指定できません。');
        const b = r.binding;
        if (b) {
          if (!['source','packed'].includes(b.kind) || typeof b.plateKey !== 'string' || !isWell(b.well) || typeof b.sourcePlate !== 'string' || typeof b.sourceUid !== 'string' || !/^[\w-]{1,80}$/.test(b.sourceUid) || !isWell(b.sourceWell)) throw Error('ROIとウェルの対応が不正です。');
          const k = b.sourcePlate + ':' + b.sourceWell;
          if (sources.has(k)) throw Error('同じ泳動内で同じ元ウェルを複数ROIへ指定できません。');
          sources.add(k);
        }
      }
    }
  }
  function importSession(state, session) {
    const image = session?.image, c = session?.config;
    if (!image || !c || !Array.isArray(c.rois)) throw Error('GelPoolの「解析を保存」または「台帳一式JSON」のファイルを選んでください。');
    const next = clone(state), existing = next.gels.find(g => g.sha256 === image.sha256);
    const results = session.quantification?.results || [];
    const gel = { sha256:image.sha256, name:image.name, width:image.width, height:image.height, preview:image.preview,
      roiWidth:c.roiWidth, roiHeight:c.roiHeight,
      rois:c.rois.map((r,i) => ({ id:r.id, x:r.x, y:r.y, status:results[i]?.status || 'unknown', area:finite(results[i]?.area)?results[i].area:null,
        skipped:!!existing?.rois.find(old=>old.id===r.id)?.skipped, binding:clone(existing?.rois.find(old => old.id===r.id)?.binding || null) })) };
    if (existing) next.gels[next.gels.indexOf(existing)] = gel; else next.gels.push(gel);
    validate(next);return next;
  }
  function resolve(snapshot, kind, plateKey, well) {
    if (!isWell(well)) throw Error('ウェルはA1〜H12で指定してください。');
    let sourcePlate, sourceWell;
    if (kind === 'source') { sourcePlate=plateKey;sourceWell=well; }
    else if (kind === 'packed') {
      const matches=(snapshot.packedPlates || []).filter(p => p.id===plateKey);
      if (matches.length!==1) throw Error('対応するパッキング済みプレートが見つからないか、名前が重複しています。');
      const cell=matches[0].grid[well.charCodeAt(0)-65]?.[Number(well.slice(1))-1];
      if (!cell) throw Error('このウェルには検体がありません。');
      sourcePlate=cell.sourcePlate;sourceWell=cell.sourceWell;
    } else throw Error('プレートの種類が不正です。');
    const index=Number(sourcePlate)-1, p=snapshot.plates?.[index];
    if (!Number.isInteger(index) || index<0 || String(index+1)!==sourcePlate || !p || !p.wells.includes(sourceWell)) throw Error('元プレートの検体が現在の配置に存在しません。');
    return {kind,plateKey,well,sourcePlate,sourceWell,sourceUid:p.uid || sourcePlate,sourceLabel:p.label || `Plate ${index+1}`};
  }
  function bind(state, snapshot, hash, roiId, kind, plateKey, well) {
    const next=clone(state),gel=next.gels.find(g=>g.sha256===hash),roi=gel?.rois.find(r=>r.id===roiId);
    if (!roi) throw Error('ROIが見つかりません。');
    const b=resolve(snapshot,kind,plateKey,well);
    const duplicate=gel.rois.find(r=>r.id!==roiId && r.binding?.sourcePlate===b.sourcePlate && r.binding.sourceWell===b.sourceWell);
    if (duplicate) throw Error(`元ウェル ${b.sourcePlate}-${b.sourceWell} はROI #${duplicate.id}に割り当て済みです。先にその対応を解除してください。`);
    roi.binding=b;roi.skipped=false;validate(next);return next;
  }
  function bindingError(snapshot, binding) {
    if (!binding) return '未指定';
    try {
      const now=resolve(snapshot,binding.kind,binding.plateKey,binding.well);
      return now.sourcePlate!==binding.sourcePlate || now.sourceWell!==binding.sourceWell || now.sourceUid!==binding.sourceUid ? '配置変更：元ウェルが変わっています。対応を再指定してください。' : '';
    } catch(e) { return e.message; }
  }
  function sampleId(state,binding) { return `PP:${state.namespace}:${binding.sourceUid}:${binding.sourceWell}`; }
  function exportSession(state,snapshot,session,hash) {
    validate(state);
    const g=state.gels.find(x=>x.sha256===hash);
    if (!g || session?.image?.sha256!==hash) throw Error('この画像の元のGelPool解析JSONを再読み込みしてください。');
    const result=clone(session),before=clone(result.config),ids=result.config.rois.map(r=>r.id);
    if (ids.length!==g.rois.length || ids.some(id=>!g.rois.some(r=>r.id===id))) throw Error('ROI番号が一致しません。最新の解析JSONを読み込んでください。');
    for (const r of result.config.rois) {
      const link=g.rois.find(x=>x.id===r.id);
      if(link.skipped){const previousDecision=r.platepack?.skipped?r.platepack.previousDecision:r.decision;r.decision='exclude';r.sample='';r.well='';r.platepack={namespace:state.namespace,skipped:true,previousDecision:previousDecision||'auto'};continue;}
      const error=bindingError(snapshot,link.binding);
      if (error) throw Error(`ROI #${r.id}: ${error}。全ROIの対応を指定してからGelPoolへ書き出してください。`);
      if(r.platepack?.skipped)r.decision=r.platepack.previousDecision||'auto';
      r.sample=sampleId(state,link.binding);r.well=`${link.binding.sourcePlate}-${link.binding.sourceWell}`;
      r.platepack={...clone(link.binding),namespace:state.namespace};
    }
    result.history ||= [];result.history.push({at:new Date().toISOString(),action:'PlatePack: 手動ROI・ウェル対応を適用',before,after:clone(result.config)});
    result.updatedAt=new Date().toISOString();return result;
  }
  return {empty,validate,importSession,resolve,bind,bindingError,sampleId,exportSession};
});
