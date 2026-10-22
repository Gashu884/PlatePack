import math
def validate(c,a):
    def number(v,lo,hi):
        if not isinstance(v,(int,float)) or not math.isfinite(v) or not lo<=v<=hi: raise ValueError('設定値が範囲外です。')
    for key,lo,hi in [('roiWidth',4,500),('roiHeight',8,500),('snrThreshold',.1,100),('minSignal',0,1),('poolTotal',.01,100000),('poolMin',.001,10000),('poolMax',.001,10000),('poolStep',.001,1000)]:number(c[key],lo,hi)
    if c['poolMin']>c['poolMax']: raise ValueError('分注量の下限は上限以下にしてください。')
    if len(c['rois'])>384 or len(set(r['id'] for r in c['rois']))!=len(c['rois']):raise ValueError('ROI番号が不正です。')
    if c.get('poolMode')=='max-count' and (c['poolMin']!=1 or c['poolMax']!=20 or c['poolStep']!=.1):raise ValueError('最大数モードは1〜20 µL、0.1 µL刻みです。')
    if len(c.get('markers',[]))>8 or len({r['row'] for r in c.get('markers',[])})!=len(c.get('markers',[])):raise ValueError('マーカーの段が重複しています。')
    for r in c.get('markers',[]):
        number(r['roiWidth'],4,500);number(r['roiHeight'],8,500);number(r.get('relativeLoad',1),.000001,100000)
        number(r['row'],0,c['rows']-1)
    for r in c['rois']+c.get('markers',[]):
        number(r['x'],0,a.shape[1]-1);number(r['y'],0,a.shape[0]-1)
        number(r.get('loading',1),.000001,100000);number(r.get('dilution',1),.000001,100000)
        if r.get('baseline'):
            if len(r['baseline'])!=4:raise ValueError('ベースラインが不正です。')
            for v in r['baseline']:number(v,-1000000,1000000)
