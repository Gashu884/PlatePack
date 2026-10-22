"""GelPool: deterministic grid-assisted fluorescence densitometry."""
import base64, hashlib, io
import numpy as np
from PIL import Image
VERSION = 'platepack-gel-1.0.0'

def smooth(a, k):
    k = max(1, int(k) | 1)
    return np.convolve(np.pad(a, k//2, mode='edge'), np.ones(k)/k, mode='valid')

def peaks(a, distance, count=100):
    candidates = np.flatnonzero((a[1:-1] > a[:-2]) & (a[1:-1] >= a[2:])) + 1
    selected = []
    for i in sorted(candidates, key=lambda i: (-a[i], i)):
        if all(abs(i-j) >= distance for j in selected):
            selected.append(int(i))
            if len(selected) == count: break
    return sorted(selected)

def decode(raw, name):
    try:
        im = Image.open(io.BytesIO(raw))
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError('画像を読み込めません。TIFF / PNGの形式・サイズを確認してください。') from exc
    if im.format not in ('TIFF', 'PNG'): raise ValueError('TIFFまたはPNG画像を選んでください。')
    if getattr(im, 'n_frames', 1) != 1: raise ValueError('複数ページTIFFには未対応です。1画像ずつ保存してください。')
    if im.width * im.height > 30_000_000: raise ValueError('画像は3000万画素以下にしてください。')
    a = np.array(im)
    if a.ndim != 2 or a.dtype.kind not in 'ui':
        raise ValueError('測定用の8-bitまたは16-bitグレースケール画像を使ってください。カラー画像は未対応です。')
    if a.dtype.itemsize > 2: raise ValueError('8-bitまたは16-bit画像を使ってください。')
    maximum = 65535 if a.dtype.itemsize == 2 else 255
    preview = Image.fromarray(np.round(a.astype(float)/maximum*255).astype('uint8'))
    # Display only: keep previews bounded; all detection and integration use a above.
    preview.thumbnail((2048,2048), Image.Resampling.LANCZOS)
    stream=io.BytesIO(); preview.save(stream, format='PNG')
    preview_type='png'
    if len(stream.getvalue())>1_500_000:
        stream=io.BytesIO();preview.save(stream,format='JPEG',quality=80);preview_type='jpeg'
    return a.astype(float), {'name': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'width': im.width, 'height': im.height, 'bitDepth': 16 if maximum==65535 else 8, 'maximum': maximum, 'preview': 'data:image/'+preview_type+';base64,'+base64.b64encode(stream.getvalue()).decode()}

def detect_grid(a, rows=4, cols=24, maximum=255):
    H,W=a.shape
    xp=smooth(a.mean(axis=0), max(5,W//100))
    mask=xp > np.percentile(xp,10)+.26*(np.percentile(xp,90)-np.percentile(xp,10))
    runs=np.split(np.flatnonzero(mask), np.flatnonzero(np.diff(np.flatnonzero(mask))>1)+1)
    inds=max(runs,key=len)
    if len(inds)<cols*3: raise ValueError('ゲル領域を推定できません。明るいバンドのある画像を使ってください。')
    left,right=int(inds[0]),int(inds[-1])
    # Search pitch near the expected 24-lane layout; periodicity rejects gel edges.
    p0=(right-left)/(cols+2)
    yp=a[:,left:right].mean(axis=1)
    hp=smooth(yp,3)-smooth(yp,max(15,int(p0*1.2)))
    candidates=peaks(hp,max(12,int(p0*.65)),rows*8)
    ranked=[]
    for y in candidates:
        x=smooth(a[max(0,y-5):min(H,y+6),left:right].mean(axis=0),7)
        x=x-smooth(x,max(9,int(p0)))
        best=-1
        for p in range(max(8,int(p0*.8)),int(p0*1.2)+1):
            v=np.dot(x[:-p],x[p:])/(np.linalg.norm(x[:-p])*np.linalg.norm(x[p:])+1e-9)
            best=max(best,v)
        ranked.append((float(max(hp[y],0)*max(best,0)),y))
    chosen=sorted(y for score,y in sorted(ranked,reverse=True)[:2*rows])
    targets=chosen[1::2]
    if len(targets)!=rows: raise ValueError('段数を推定できません。段数設定を確認してください。')
    # Pool horizontal band profiles; fit a periodic grid with a left ladder slot.
    bandx=np.mean([a[max(0,y-8):min(H,y+9)].mean(axis=0) for y in targets],axis=0)
    bx=smooth(bandx,9)-smooth(bandx,max(11,int(p0)))
    vertical=smooth(np.maximum(a[3:]-a[:-3],0).sum(axis=0),9)
    marker=left+int(np.argmax(vertical[left:min(W,left+int(p0*4))]))
    best=(-1e99,None,None)
    # First slot is the left ladder; all 24 sample slots retained even if absent.
    for pitch in np.arange(p0*.85,p0*1.15,.2):
        for start in np.arange(marker+pitch*.8,marker+pitch*1.3,1):
            centers=start+np.arange(cols)*pitch
            if centers[-1]>right-pitch*.3: continue
            scores=np.interp(centers,np.arange(W),bx)
            value=float(np.maximum(scores,0).sum())
            if value>best[0]: best=(value,start,pitch)
    if best[1] is None: raise ValueError('レーン配置を推定できません。')
    _,start,pitch=best
    width=max(10,round(pitch*.65)); height=max(18,round(pitch*.95))
    rois=[]
    for row,y in enumerate(targets):
        for col in range(cols):
            x=start+col*pitch
            x0,x1=max(0,int(x-width/2)),min(W,int(x+width/2))
            p=a[:,x0:x1].mean(axis=1)
            q=smooth(p,3)-smooth(p,max(15,int(pitch)))
            lo,hi=max(0,y-round(pitch*.3)),min(H,y+round(pitch*.3)+1)
            yy=int(lo+np.argmax(q[lo:hi]))
            if q[yy]<max(2,a.max()*.012): yy=y
            rois.append({'id':row*cols+col+1,'row':row,'col':col,'x':round(float(x),2),'y':float(yy),'sample':'','well':'','decision':'auto','reviewed':False,'note':'','baseline':None,'loading':1.,'dilution':1.})
    cfg = {'rows':rows,'cols':cols,'roiWidth':width,'roiHeight':height,'snrThreshold':4.,'minSignal':.012,'layout':'custom','poolTotal':100.,'poolMin':.5,'poolMax':10.,'poolStep':.1,'rois':rois,'grid':{'left':left,'right':right,'pitch':round(pitch,2),'targetRows':targets,'candidates':chosen}}
    apply_auto_width(a,cfg,maximum)
    return cfg

def measure(a, r, cfg, maximum):
    H,W=a.shape; w=int(cfg['roiWidth']); h=int(cfg['roiHeight'])
    x0=int(round(r['x']-w/2)); y0=int(round(r['y']-h/2)); x1=x0+w; y1=y0+h
    clipped=x0<0 or y0<0 or x1>W or y1>H
    patch=a[max(0,y0):min(H,y1),max(0,x0):min(W,x1)]
    if patch.size==0: raise ValueError('ROIが画像外です。')
    p=patch.mean(axis=1); n=len(p); edge=max(2,n//6)
    b=r.get('baseline')
    if b:
        l=int(np.clip(round(b[0]),0,n-2)); rr=int(np.clip(round(b[2]),l+1,n-1))
        lv=float(b[1]); rv=float(b[3])
    else:
        l=0; rr=n-1; lv=float(np.median(p[:edge])); rv=float(np.median(p[-edge:]))
    base=np.interp(np.arange(n),[l,rr],[lv,rv]); residual=p-base
    # Signed trapezoidal integration avoids summing positive noise only.
    area=max(0.,float(np.trapezoid(residual[l:rr+1]))*patch.shape[1])
    noisevals=np.r_[p[:edge]-base[:edge],p[-edge:]-base[-edge:]]
    noise=max(float(np.median(abs(noisevals-np.median(noisevals)))*1.4826), maximum/1024)
    peak=max(0.,float(residual[l:rr+1].max())); snr=peak/noise
    detected=snr>=float(cfg['snrThreshold']) and peak>=float(cfg['minSignal'])*maximum and area>0
    sat=float((patch>=maximum).mean())
    local=smooth(residual,3); pp=[i for i in peaks(local, max(3,n//6)) if l<=i<=rr and local[i]>peak*.45]
    flags=[]
    if not detected: flags.append('未検出・微弱')
    if sat>0: flags.append('飽和画素あり')
    if len(pp)>1: flags.append('複数ピーク')
    if max(residual[l],residual[rr])>peak*.3 and peak>0: flags.append('積分範囲を確認')
    if clipped: flags.append('画像端で切断')
    status='detected' if detected else 'undetected'
    if detected and flags: status='review'
    concentration=area*float(r.get('dilution',1))/float(r.get('loading',1))
    return {'profile':p.round(5).tolist(),'baseline':[l,lv,rr,rv],'area':round(area,6),'relativeSignal':concentration,'peak':peak,'snr':round(snr,2),'status':status,'flags':flags,'saturatedFraction':sat,'bounds':[x0,y0,x1,y1]}


def estimate_common_width(a, cfg, maximum):
    """Measure target-band lateral extents independently of the current ROI width."""
    H,W=a.shape; candidates=[]; gaps=[]
    for r in cfg['rois']:
        row=sorted([s for s in cfg['rois'] if s['row']==r['row']],key=lambda s:s['x'])
        j=next(i for i,s in enumerate(row) if s['id']==r['id'])
        pitch=float(cfg.get('grid',{}).get('pitch',40))
        lg=r['x']-row[j-1]['x'] if j else pitch
        rg=row[j+1]['x']-r['x'] if j+1<len(row) else pitch
        gaps.extend([lg,rg]); x=float(r['x']); y=int(round(r['y']))
        lo=max(0,int(np.ceil(x-lg/2))); hi=min(W,int(np.floor(x+rg/2))+1)
        item={'id':r['id'],'span':None,'width':None,'reason':None,'eligible':False,'touchesBoundary':False}
        if r.get('widthExcluded',False):item['reason']='手動で幅基準から除外';candidates.append(item);continue
        if r.get('decision') in ('exclude','repcr'):item['reason']='除外・再PCR指定';candidates.append(item);continue
        h=int(cfg['roiHeight']); y0=y-h//2;y1=y0+h;edge=max(2,h//6)
        if hi-lo<8 or y0<0 or y1>H:item['reason']='画像端・レーン間隔不足';candidates.append(item);continue
        # A narrow independent probe establishes that a target peak is present.
        probe=dict(cfg,roiWidth=max(4,int(min(lg,rg)*.6)))
        pm=measure(a,dict(r,baseline=None),probe,maximum)
        if pm['status']!='detected':item['reason']='目的ピークが不明瞭';candidates.append(item);continue
        upper=np.median(a[y0:y0+edge,lo:hi],axis=0)
        lower=np.median(a[y1-edge:y1,lo:hi],axis=0)
        target=a[max(y0,y-2):min(y1,y+3),lo:hi].mean(axis=0)
        signal=smooth(target-(upper+lower)/2,3)
        differences=upper-lower
        noise=max(float(np.median(abs(differences-np.median(differences)))*1.4826/np.sqrt(2)),maximum/1024)
        ix=np.arange(lo,hi);central=np.flatnonzero(abs(ix-x)<=min(lg,rg)*.25)
        k=int(central[np.argmax(signal[central])]);peak=float(signal[k])
        threshold=max(peak*.10,noise*3,maximum*.004)
        if peak<max(noise*6,maximum*float(cfg['minSignal'])):
            item['reason']='横方向の信号が微弱';candidates.append(item);continue
        left=right=k
        while left>0 and signal[left-1]>=threshold:left-=1
        while right<len(signal)-1 and signal[right+1]>=threshold:right+=1
        if right-left+1<3:item['reason']='点状ノイズ';candidates.append(item);continue
        touches=left==0 or right==len(signal)-1
        # Half-pixel edges define the measured lateral band width.
        l=lo+left-.5;rr=lo+right+.5
        width=int(np.ceil(rr-l))
        item.update(eligible=True,span=round(rr-l,2),width=width,left=l,right=rr,threshold=round(threshold,4),noise=round(noise,4),touchesBoundary=touches)
        if touches:item['reason']='隣接レーン境界まで信号が続く'
        candidates.append(item)
    valid=[i for i in candidates if i['eligible']]
    margin=2;limit=min(500,int(np.floor(min(gaps)-4))) if gaps else 0
    report={'method':'widest-target-v1','thresholdFraction':.10,'noiseMultiplier':3,'marginPerSide':margin,'safeLimit':limit,'candidates':candidates,'basisId':None,'bandWidth':None,'proposedWidth':None,'status':'no_candidates'}
    if not valid:return report
    widest=max(valid,key=lambda i:(i['width'],-i['id']))
    proposed=max(10,widest['width']+2*margin)
    blocked=[i['id'] for i in valid if i['touchesBoundary'] or i['width']+2*margin>limit]
    report.update(basisId=widest['id'],bandWidth=widest['width'],proposedWidth=proposed,blockedIds=blocked,status='needs_review' if blocked else 'ok')
    return report

def apply_auto_width(a,cfg,maximum):
    """Mutates only width metadata and, on width change, invalidates baselines/review."""
    report=estimate_common_width(a,cfg,maximum)
    cfg['widthMode']='widest';cfg['widthReport']=report
    if report['status']=='ok' and cfg['roiWidth']!=report['proposedWidth']:
        cfg['roiWidth']=report['proposedWidth']
        for r in cfg['rois']:r['baseline']=None;r['reviewed']=False
    return report



def marker_measurements(a,cfg,maximum):
    out=[]
    for marker in cfg.get('markers',[]):
        mc=dict(cfg,roiWidth=marker['roiWidth'],roiHeight=marker['roiHeight'])
        m=measure(a,marker,mc,maximum)
        valid=bool(marker.get('confirmed')) and bool(cfg.get('markerComparable')) and m['status']=='detected' and m['area']>0
        out.append(dict(m,row=marker['row'],relativeLoad=float(marker.get('relativeLoad',1)),confirmed=bool(marker.get('confirmed')),valid=valid))
    return out

def quantify(a, cfg, maximum):
    report=estimate_common_width(a,cfg,maximum) if cfg.get('widthMode')=='widest' else None
    width_items={i['id']:i for i in report['candidates']} if report else {}
    results=[]
    for r in cfg['rois']:
        m=measure(a,r,cfg,maximum); d=r.get('decision','auto')
        wi=width_items.get(r['id'])
        if wi and wi['eligible'] and (wi['left']<m['bounds'][0]-.5 or wi['right']>m['bounds'][2]-.5):
            m['flags'].append('バンド端がROI外：左右位置を確認')
            if m['status']=='detected':m['status']='review'
        m['repcr']=d=='repcr' or (d=='auto' and m['status']=='undetected')
        m['include']=(d=='include' or (d=='auto' and m['status']=='detected')) and m['relativeSignal']>0
        m['eligible']=m['include']
        results.append(m)
    marker_results=marker_measurements(a,cfg,maximum)
    if cfg.get('poolMode')=='max-count':
        from .pooling import plan_project
        planning=plan_project([{'id':'current','label':'現在の泳動','sha256':cfg.get('imageHash','current'),'imageName':'current','config':cfg,'quantification':{'results':results,'widthAnalysis':report,'markerResults':marker_results}}],{'groupSize':cfg.get('groupSize',48),'scope':cfg.get('poolScope','groups'),'step':cfg.get('poolStep',.1),'useMarker':cfg.get('useMarker',False)})
        mapped={r['lane']:r for r in planning['records']}
        for roi,m in zip(cfg['rois'],results):
            rec=mapped[roi['id']];m.update(include=rec['used'],idealVolume=rec['idealVolume'],volume=rec['volume'],poolFlag=rec['choice'],roundingErrorPct=rec['roundingErrorPct'],correctedSignal=rec['signal'],poolGroup=rec['group'])
        return {'results':results,'included':planning['count'],'widthAnalysis':report,'markerResults':marker_results,'ready':planning['ready'],'actualTotal':round(sum(p['total'] for p in planning['plans']),6),'optimization':planning,'version':VERSION}
    ids=[i for i,m in enumerate(results) if m['include']]
    total=float(cfg['poolTotal']); step=float(cfg['poolStep']); low=float(cfg['poolMin']); high=float(cfg['poolMax'])
    denominator=sum(1/results[i]['relativeSignal'] for i in ids)
    for i,m in enumerate(results):
        m['idealVolume']=None; m['volume']=None; m['poolFlag']='対象外'
        if i in ids:
            v=total/results[i]['relativeSignal']/denominator
            rounded=float(np.floor(v/step+.5)*step)
            m['idealVolume']=round(v,6)
            if v<low or v>high or rounded<low or rounded>high or rounded<=0:
                m['poolFlag']='下限未満' if min(v,rounded)<low else '上限超過'
            else: m['volume']=round(rounded,6); m['poolFlag']='OK'
    return {'results':results,'markerResults':marker_results,'included':len(ids),'widthAnalysis':report,'ready':bool(ids) and (not report or (report['status']=='ok' and cfg['roiWidth']==report['proposedWidth'])) and all(results[i]['volume'] is not None for i in ids),'actualTotal':round(sum(m['volume'] or 0 for m in results),6),'version':VERSION}
