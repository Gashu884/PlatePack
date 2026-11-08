"""Rebuild raw output positions from saved input and packing settings."""
from copy import deepcopy
from .plate_edits import position


def rebuild_outputs(payload):
    if payload.get('plateEdit') or payload.get('electrophoresis') or payload.get('gelLinks'):
        raise ValueError('編集済み・ROI対応済みのデータは再生成できません。')
    layout = payload.get('packedLayout') or payload
    direction = layout.get('layoutDirection', 'row')
    input_direction = payload.get('inputReadDirection', 'row')
    if direction not in ('row', 'column') or input_direction not in ('row', 'column'):
        raise ValueError('配置順を確認してください。')

    def segments(size, cuts):
        if not isinstance(cuts, list) or any(type(n) is not int or not 0 < n < size for n in cuts):
            raise ValueError('区切りを確認してください。')
        points = [0] + sorted(set(cuts)) + [size]
        return [range(a, b) for a, b in zip(points, points[1:])]

    blocked = set(payload.get('blockedLayoutWells', []))
    for w in blocked:
        position(w)
    slots = []
    for rows in segments(8, layout.get('horizontalDividers', [])):
        for cols in segments(12, layout.get('verticalDividers', [])):
            points = ((r,c) for c in cols for r in rows) if direction == 'column' else ((r,c) for r in rows for c in cols)
            slots.extend((r,c) for r,c in points if chr(65+r)+str(c+1) not in blocked)
    if not slots:
        raise ValueError('配置先のウェルがありません。')
    samples = []
    colors = dict(payload.get('sourceColorMap', []))
    for i, source in enumerate(payload['plates']):
        wells = source['wells']
        if len(wells) != len(set(wells)):
            raise ValueError('入力ウェルが重複しています。')
        for w in wells:
            position(w)
        key = (lambda w: position(w)[::-1]) if input_direction == 'column' else position
        for w in sorted(wells, key=key):
            cell = {'sourcePlate':str(i+1),'sourceWell':w,'growthWeek':source.get('growthWeeks', {}).get(w)}
            if str(i+1) in colors:
                cell['color'] = colors[str(i+1)]
            samples.append(cell)
    if not samples:
        raise ValueError('入力ウェルがありません。')
    previous = payload.get('packedPlates', [])
    total = (len(samples)+len(slots)-1)//len(slots)
    outputs = []
    for i in range(total):
        plate = deepcopy(previous[i]) if i < len(previous) else {'id':f'プレート_{i+1:02}','columns':list(range(1,13))}
        plate['grid'] = [[None]*12 for _ in range(8)]
        outputs.append(plate)
    for n, cell in enumerate(samples):
        r,c = slots[n % len(slots)]
        outputs[n//len(slots)]['grid'][r][c] = cell
    changes = []
    for i in range(max(len(previous),len(outputs))):
        for r in range(8):
            for c in range(12):
                before = previous[i]['grid'][r][c] if i < len(previous) else None
                after = outputs[i]['grid'][r][c] if i < len(outputs) else None
                def sample(cell):
                    return (cell.get('sourcePlate'),cell.get('sourceWell'),cell.get('growthWeek')) if cell else None
                if sample(before) != sample(after):
                    changes.append({'plate':i,'well':chr(65+r)+str(c+1),'before':before,'after':after})
    return outputs, changes
