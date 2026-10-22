"""Persistent, content-addressed images and reproducible electrophoresis analysis.

Chunks keep original TIFFs and analysis records out of serverless request-size limits.
No image cache or ephemeral filesystem is required; SQLite and PostgreSQL share storage.
"""
import base64
import hashlib
import json
import math
import re
from statistics import mean, median
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from backend.api.logs_db import _database, _execute, _initialize
from .engine import decode, detect_grid, quantify, apply_auto_width, VERSION
from .validation import validate
from .pooling import plan_project

router = APIRouter(prefix='/api/electrophoresis')
CHUNK = 256 * 1024
MAX_BYTES = 96 * 1024 * 1024


def tables(conn):
    _initialize(conn)
    conn.execute('CREATE TABLE IF NOT EXISTS gel_chunks (hash TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(hash,idx))')
    conn.execute('CREATE TABLE IF NOT EXISTS gel_blobs (hash TEXT PRIMARY KEY, chunks INTEGER NOT NULL, size INTEGER NOT NULL)')


def check_hash(value):
    if not re.fullmatch('[a-f0-9]{64}', value):
        raise ValueError('ファイル識別子が不正です。')


def read_blob(key):
    check_hash(key)
    with _database() as conn:
        tables(conn)
        meta = _execute(conn, 'SELECT * FROM gel_blobs WHERE hash=?', (key,)).fetchone()
        if not meta: raise ValueError('元ファイルが登録されていません。再登録してください。')
        rows = _execute(conn, 'SELECT data FROM gel_chunks WHERE hash=? ORDER BY idx', (key,)).fetchall()
    raw = b''.join(base64.b64decode(r['data']) for r in rows)
    if len(raw) != meta['size'] or hashlib.sha256(raw).hexdigest() != key:
        raise ValueError('元ファイルの検証に失敗しました。')
    return raw


class ChunkBody(BaseModel):
    data: str = Field(max_length=350000)


@router.put('/blobs/{key}/chunks/{index}')
def put_chunk(key: str, index: int, body: ChunkBody):
    try:
        check_hash(key)
        if not 0 <= index < MAX_BYTES // CHUNK: raise ValueError('ファイルが大きすぎます。')
        raw = base64.b64decode(body.data, validate=True)
        if not 0 < len(raw) <= CHUNK: raise ValueError('チャンクサイズが不正です。')
        with _database(write=True) as conn:
            tables(conn)
            old = _execute(conn, 'SELECT data FROM gel_chunks WHERE hash=? AND idx=?', (key,index)).fetchone()
            if old and old['data'] != body.data: raise ValueError('同じ識別子のデータを書き換えることはできません。')
            if _execute(conn,'SELECT hash FROM gel_blobs WHERE hash=?',(key,)).fetchone() and not old:
                raise ValueError('登録済みファイルへの追加はできません。')
            _execute(conn,'INSERT INTO gel_chunks (hash,idx,data) VALUES (?,?,?) ON CONFLICT(hash,idx) DO NOTHING',(key,index,body.data))
        return {'saved':True}
    except (ValueError,RuntimeError) as e: raise HTTPException(422, str(e)) from e


class CompleteBody(BaseModel):
    chunks: int = Field(ge=1, le=384)
    size: int = Field(ge=1, le=MAX_BYTES)


@router.post('/blobs/{key}/complete')
def complete(key: str, body: CompleteBody):
    try:
        check_hash(key)
        with _database(write=True) as conn:
            tables(conn)
            rows=_execute(conn,'SELECT idx,data FROM gel_chunks WHERE hash=? ORDER BY idx',(key,)).fetchall()
            if [r['idx'] for r in rows] != list(range(body.chunks)): raise ValueError('転送が完了していません。')
            raw=b''.join(base64.b64decode(r['data']) for r in rows)
            if len(raw)!=body.size or hashlib.sha256(raw).hexdigest()!=key: raise ValueError('転送したファイルの検証に失敗しました。')
            _execute(conn,'INSERT INTO gel_blobs (hash,chunks,size) VALUES (?,?,?) ON CONFLICT(hash) DO NOTHING',(key,body.chunks,body.size))
        return {'hash':key,'chunks':body.chunks,'size':body.size}
    except (ValueError,RuntimeError) as e: raise HTTPException(422,str(e)) from e


@router.get('/blobs/{key}')
def blob_info(key: str):
    try:
        check_hash(key)
        with _database() as conn:
            tables(conn)
            row=_execute(conn,'SELECT * FROM gel_blobs WHERE hash=?',(key,)).fetchone()
        if not row: raise HTTPException(404,'ファイルが見つかりません。')
        return dict(row)
    except (ValueError,RuntimeError) as e: raise HTTPException(422,str(e)) from e


@router.get('/blobs/{key}/chunks/{index}')
def get_chunk(key: str,index: int):
    info=blob_info(key)
    if not 0<=index<info['chunks']: raise HTTPException(404,'チャンクが見つかりません。')
    with _database() as conn:
        row=_execute(conn,'SELECT data FROM gel_chunks WHERE hash=? AND idx=?',(key,index)).fetchone()
    if not row: raise HTTPException(404,'チャンクが見つかりません。')
    return dict(row)


def setup(cfg, meta):
    cfg.update(poolMode='max-count',poolMin=1.,poolMax=20.,poolStep=.1,imageHash=meta['sha256'],useMarker=True)
    cfg.setdefault('poolScope','groups');cfg.setdefault('markerComparable',True);cfg.setdefault('groupSize',48)
    cfg.setdefault('ladderName','SMOBIO ExcelBand 100 bp DNA Ladder')
    for r in cfg['rois']: r.setdefault('poolGroup','Pool'+str(1+(r['id']-1)//cfg['groupSize']))
    cfg.setdefault('markers',[])
    if not cfg['markers']:
        for row in range(cfg['rows']):
            rs=[r for r in cfg['rois'] if r['row']==row]
            first=min(rs,key=lambda r:r['x'])
            cfg['markers'].append(dict(id=1000+row,row=row,col=-1,x=max(2,first['x']-cfg.get('grid',{}).get('pitch',40)),y=first['y'],roiWidth=24,roiHeight=12,relativeLoad=1.,confirmed=False,baseline=None))
    return cfg


def image_for(data):
    key=data.get('sha256') or data.get('image',{}).get('sha256')
    return decode(read_blob(key),str(data.get('name') or data.get('image',{}).get('name') or 'image.tif'))


def checked_config(cfg,a):
    validate(cfg,a)
    if not isinstance(cfg.get('rows'),int) or not 1<=cfg['rows']<=8:raise ValueError('段数が不正です。')
    if not isinstance(cfg.get('groupSize',48),int) or not 1<=cfg.get('groupSize',48)<=384:raise ValueError('チューブあたりのサンプル数が不正です。')
    for r in cfg['rois']:
        if not isinstance(r['id'],int) or r['id']<1 or not isinstance(r['row'],int) or not 0<=r['row']<cfg['rows']:raise ValueError('ROI番号・段が不正です。')
        if r.get('decision','auto') not in ('auto','include','exclude','repcr'):raise ValueError('ROI判定が不正です。')
    return cfg


@router.post('/{action}')
def analyze(action: str, data: dict):
    try:
        if action=='plan':
            sessions=data.get('sessions',[])
            if not 1<=len(sessions)<=32:raise ValueError('1〜32画像を選んでください。')
            runs=[]
            for i,s in enumerate(sessions):
                if s.get('measuredVersion') and s['measuredVersion']!=VERSION:raise ValueError('解析方式が更新されています。各画像を開いて再測定してください。')
                a,meta=image_for(s);cfg=checked_config(s['config'],a)
                runs.append(dict(id=meta['sha256'],label=meta['name'],imageName=meta['name'],sha256=meta['sha256'],config=cfg,quantification=quantify(a,cfg,meta['maximum'])))
            opts={'groupSize':data.get('groupSize',48),'useMarker':True,'scope':'groups','step':.1}
            plan=plan_project(runs,opts)
            for p in plan['plans']:
                records=[r for r in plan['samples'] if r['group']==p['group'] and not r['error'] and r['signal'] is not None]
                values=[r['signal'] for r in records];areas=[r['area'] for r in records]
                p['mean']=mean(values) if values else None;p['median']=median(values) if values else None
                p['areaMean']=mean(areas) if areas else None;p['areaMedian']=median(areas) if areas else None
                p['measuredCount']=len(values)
                for r in records:r['relativeToMedian']=r['signal']/p['median'] if p['median'] else None
            return plan
        a,meta=image_for(data)
        if action in ('detect','redetect'):
            rows=int(data.get('rows',4));cols=int(data.get('cols',24))
            if not 1<=rows<=8 or not 2<=cols<=48 or rows*cols>384:raise ValueError('段数または列数が範囲外です。')
            cfg=setup(detect_grid(a,rows,cols,meta['maximum']),meta)
        elif action in ('measure','auto-width','restore'):
            cfg=checked_config(data['config'],a)
            if action=='auto-width':apply_auto_width(a,cfg,meta['maximum'])
        else:raise ValueError('操作が不正です。')
        q=quantify(a,cfg,meta['maximum'])
        if action=='measure':return q
        if action in ('redetect','auto-width'):return {'config':cfg,'quantification':q}
        return {**data,'image':meta,'config':cfg,'quantification':q,'version':VERSION}
    except OSError as e:
        raise HTTPException(422, "画像を読み込めません。破損していないTIFF / PNGを選んでください。") from e
    except (ValueError,KeyError,TypeError,OverflowError,RuntimeError) as e:
        raise HTTPException(422,str(e) if isinstance(e,(ValueError,RuntimeError)) else '解析設定の形式が不正です。') from e
