"""Relative pooling: maximum feasible sample count, explicit cross-gel calibration."""
import math
from collections import defaultdict


def optimize_pool(items, minimum=1., maximum=20., step=.1):
    """Maximum overlapping [c*min,c*max] intervals, then tightest c ratio.

    With a common equal-DNA target T, v=T/c. A feasible subset occupies a
    sorted concentration window with max(c)/min(c)<=maximum/minimum.
    Tie-break: lowest volume ratio, then stronger signal, then stable key.
    Minimal feasible T minimizes the absolute ideal-volume spread.
    """
    if not all(math.isfinite(v) and v>0 for v in (minimum,maximum,step)) or minimum>maximum:raise ValueError('分注範囲が不正です。')
    ordered=sorted([x for x in items if math.isfinite(x['signal']) and x['signal']>0],key=lambda x:(x['signal'],x['key']))
    best=[];rank=None;left=0
    for right,item in enumerate(ordered):
        while item['signal']/ordered[left]['signal']>maximum/minimum*(1+1e-12):left+=1
        window=ordered[left:right+1]
        score=(len(window),-item['signal']/window[0]['signal'],window[0]['signal'])
        if rank is None or score>rank:best=window;rank=score
    if not best:return {'selected':[],'excluded':[x['key'] for x in items],'target':None,'total':0,'count':0,'uniqueVolumes':[],'spread':None,'maxRoundingErrorPct':None}
    target=best[-1]['signal']*minimum
    outputs=[]
    for item in best:
        ideal=target/item['signal']
        # Clamp ONLY after rounding, to keep the output within physical limits.
        # The unrounded ideal is guaranteed feasible; report rounding error.
        v=min(maximum,max(minimum,math.floor(ideal/step+.5)*step))
        outputs.append({'key':item['key'],'signal':item['signal'],'idealVolume':ideal,'volume':round(v,6),'contribution':v*item['signal'],'errorPct':100*(v*item['signal']/target-1)})
    keys={x['key'] for x in outputs};vols=[x['volume'] for x in outputs]
    return {'selected':outputs,'excluded':[x['key'] for x in items if x['key'] not in keys],'target':target,'total':round(sum(vols),6),'count':len(outputs),'uniqueVolumes':sorted(set(vols)),'spread':round(max(vols)-min(vols),6),'maxRoundingErrorPct':max(abs(x['errorPct']) for x in outputs)}


def fixed_target_pool(items,target,step=.1):
    if not math.isfinite(target) or target<=0:raise ValueError('固定目標量が不正です。')
    selected=[]
    for r in items:
        ideal=target/r['signal']
        if ideal<1-1e-12 or ideal>20+1e-12:continue
        v=round(min(20.,max(1.,math.floor(ideal/step+.5)*step)),6)
        selected.append({'key':r['key'],'signal':r['signal'],'idealVolume':ideal,'volume':v,'contribution':v*r['signal'],'errorPct':100*(v*r['signal']/target-1)})
    keys={r['key'] for r in selected};vols=[r['volume'] for r in selected]
    return {'selected':selected,'excluded':[r['key'] for r in items if r['key'] not in keys],'target':target,'total':round(sum(vols),6),'count':len(selected),'uniqueVolumes':sorted(set(vols)),'spread':round(max(vols)-min(vols),6) if vols else None,'maxRoundingErrorPct':max(abs(r['errorPct']) for r in selected) if selected else None,'locked':True}


def plan_project(runs, options, choices=None):
    """Runs contain server-recomputed quantification, never trust saved areas."""
    choices=choices or {}; all_records=[];by_sample=defaultdict(list);blockers=[]
    multiple=len(runs)>1
    use_marker=bool(options.get('useMarker',multiple)) or multiple
    for run in runs:
        cfg=run['config'];q=run['quantification'];ref_by_row={r['row']:r for r in q.get('markerResults',[])}
        width=q.get('widthAnalysis')
        width_ok=not width or (width['status']=='ok' and width['proposedWidth']==cfg['roiWidth'])
        seen=set()
        for roi,m in zip(cfg['rois'],q['results']):
            sid=str(roi.get('sample','')).strip() or f"{run['sha256'][:8]}:{roi['id']:03d}"
            key=f"{run['id']}:{roi['id']}"
            group=str(roi.get('poolGroup','')).strip() or f"{run['label']}-Pool{1+(roi['id']-1)//48}"
            ref=ref_by_row.get(roi['row']);error=None;signal=m['relativeSignal']
            if roi.get('decision')=='exclude':error='除外指定'
            elif m.get('repcr'):error='再PCR対象・未検出'
            elif m.get('saturatedFraction',0)>0:error='飽和：別露光または再泳動を確認'
            elif not m.get('eligible',m.get('include')):error='バンドの判定を要確認'
            elif not width_ok:error='共通ROI幅を要確認'
            if use_marker:
                if not ref or not ref.get('valid'):
                    error=error or '500bp基準が未確認・無効';signal=None
                else:signal=signal/ref['area']*ref['relativeLoad']
            if sid in seen:blockers.append(f"{run['label']}：サンプルID {sid} が同じ画像内で重複しています")
            seen.add(sid)
            rec={'key':key,'sampleId':sid,'sampleName':roi.get('sample',''),'well':roi.get('well',''),'group':group,'runId':run['id'],'runLabel':run['label'],'imageName':run['imageName'],'sha256':run['sha256'],'lane':roi['id'],'row':roi['row']+1,'area':m['area'],'markerArea':ref['area'] if ref and use_marker else None,'markerLoad':ref['relativeLoad'] if ref and use_marker else None,'signal':signal,'error':error,'repcr':m.get('repcr',False),'note':roi.get('note',''),'used':False,'volume':None,'idealVolume':None,'roundingErrorPct':None,'choice':'未採用'}
            all_records.append(rec);by_sample[sid].append(rec)
    chosen=[]
    for sid,records in by_sample.items():
        # Stable original tube assignment across repeat-PCR gels.
        group=records[0]['group']
        selected=next((r for r in records if r['key']==choices.get(sid)),None)
        if selected is None:selected=next((r for r in reversed(records) if not r['error']),records[-1])
        selected['group']=group;selected['choice']='採用候補' if not selected['error'] else selected['error'];chosen.append(selected)
        for rec in records:
            if rec is not selected:rec['choice']='別測定を採用'
    tube_counts=defaultdict(int)
    for rec in chosen:tube_counts[rec['group']]+=1
    for group,count in tube_counts.items():
        if count>int(options.get('groupSize',48)):blockers.append(f'{group}：指定したサンプル数を超えています。チューブ割当を確認してください')
    groups=defaultdict(list);locked=options.get('lockedTargets',{})
    for rec in chosen:
        if not rec['error']:groups['全サンプル' if options.get('scope')=='all' and not locked else rec['group']].append(rec)
    plans=[]
    for group,records in sorted(groups.items()):
        result=fixed_target_pool(records,float(locked[group])) if group in locked else optimize_pool(records,1,20,float(options.get('step',.1)))
        for out in result['selected']:
            rec=next(r for r in records if r['key']==out['key']);rec.update(used=True,volume=out['volume'],idealVolume=out['idealVolume'],roundingErrorPct=out['errorPct'],choice='プール採用',poolTube=rec['group'])
        for rec in records:
            if not rec['used']:rec['choice']='固定目標量では1–20µLの範囲外' if group in locked else '1–20µLで等量化する範囲外'
        if options.get('scope')=='all' and not locked:
            for tube in sorted({r['group'] for r in records}):
                selected=[r for r in records if r['group']==tube and r['used']]
                if not selected:continue
                outs=[o for o in result['selected'] if o['key'] in {r['key'] for r in selected}]
                volumes=[r['volume'] for r in selected]
                plans.append({'group':tube,**result,'selected':outs,'count':len(outs),'total':round(sum(volumes),6),'spread':round(max(volumes)-min(volumes),6),'uniqueVolumes':sorted(set(volumes)),'maxRoundingErrorPct':max(abs(r['roundingErrorPct']) for r in selected)})
        else:plans.append({'group':group,**result})
    pending=[r for r in chosen if r['error'] and r['error']!='除外指定']
    return {'records':all_records,'samples':chosen,'plans':plans,'blockers':sorted(set(blockers)),'useMarker':use_marker,'count':sum(p['count'] for p in plans),'sampleCount':len(chosen),'pendingCount':len(pending),'ready':any(p['count'] for p in plans) and not blockers,'mode':'最大サンプル数 → 最小液量比 → 最小液量差','version':'platepack-gel-1.0.0'}
