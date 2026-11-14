"""Project records: resumable inputs and images attached to stable output origins."""
import json
import re
from uuid import uuid4
from urllib.parse import quote
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field, ConfigDict
from . import logs_db as db

router = APIRouter(prefix='/api/workflow')

class Registration(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=120)
    project_id: str

class InputSave(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_updated_at: str
    payload: dict
    stage: str = Field(pattern='^(input|output)$')

@router.post('/registrations')
def register(body: Registration):
    if not body.name.strip():raise HTTPException(422,'名前を入力してください。')
    payload={'version':2,'workflow':{'version':1,'stage':'input'},'plates':[{'uid':uuid4().hex,'label':'Plate 1','wells':[],'growthWeeks':{}}], 'packedPlates':[], 'currentSaveProjectId':body.project_id}
    try:
        return db.get_log(db.create_log(body.name,payload,body.project_id).id)
    except db.StorageValidationError as e:raise HTTPException(422,str(e)) from e


def validate_input(payload, stage):
    if payload.get('recordType') or payload.get('plateEdit') or payload.get('electrophoresis'):
        raise ValueError('入力プレートの形式を確認してください。')
    sources=payload.get('plates')
    if not isinstance(sources,list) or not 1<=len(sources)<=999: raise ValueError('入力プレート数を確認してください。')
    expected=set()
    for i,p in enumerate(sources):
        if not isinstance(p,dict):raise ValueError('入力プレートを確認してください。')
        wells=p.get('wells')
        if not isinstance(wells,list) or any(not isinstance(w,str) or not re.fullmatch(r'[A-H](?:[1-9]|1[0-2])',w) for w in wells) or len(wells)!=len(set(wells)):
            raise ValueError('入力ウェルを確認してください。')
        expected.update((str(i+1),w) for w in wells)
    outputs=payload.get('packedPlates',[])
    if not isinstance(outputs,list) or len(outputs)>2000: raise ValueError('出力プレート数を確認してください。')
    if stage=='input':
        if outputs: raise ValueError('出力済みデータは出力として保存してください。')
        return
    if not outputs or not expected: raise ValueError('出力するウェルを選択してください。')
    found=set()
    for p in outputs:
        if not isinstance(p,dict):raise ValueError('出力プレートを確認してください。')
        grid=p.get('grid')
        if not isinstance(grid,list) or len(grid)!=8 or any(not isinstance(row,list) or len(row)!=12 for row in grid):raise ValueError('96ウェルの配置を確認してください。')
        for row in grid:
            for c in row:
                if c is None:continue
                if not isinstance(c,dict):raise ValueError('出力ウェルを確認してください。')
                if not isinstance(c.get('sourcePlate'),str) or not isinstance(c.get('sourceWell'),str):raise ValueError('元ウェルを確認してください。')
                key=(c.get('sourcePlate'),c.get('sourceWell'))
                if key not in expected or key in found:raise ValueError('入力と出力の対応が不正です。')
                found.add(key)
    if expected!=found:raise ValueError('未出力のサンプルがあります。')

@router.put('/registrations/{ref}')
def save_input(ref: str, body: InputSave):
    try:
        validate_input(body.payload,body.stage)
        with db._database(write=True) as conn:
            lock=' FOR UPDATE' if db._HAS_POSTGRES else ''
            row=db._execute(conn,'SELECT * FROM logs WHERE id=?'+lock,(ref,)).fetchone()
            if not row:raise HTTPException(404,'記録が見つかりません。')
            old=row['payload_json'];old=old if isinstance(old,dict) else json.loads(old)
            if old.get('workflow',{}).get('stage')!='input':raise HTTPException(409,'出力済みです。プロジェクト一覧からプレートを開いてください。')
            if row['updated_at']!=body.expected_updated_at:raise HTTPException(409,'別の画面で更新されています。入力をJSON保存してから開き直してください。')
            payload=dict(body.payload);payload['workflow']={'version':1,'stage':body.stage};payload['currentSaveProjectId']=row['project_id']
            raw=db.Json(payload) if db._HAS_POSTGRES else json.dumps(payload,ensure_ascii=False,separators=(',',':'))
            updated=db._now_iso()
            db._execute(conn,'UPDATE logs SET payload_json=?,updated_at=? WHERE id=?',(raw,updated,ref))
            result=db.LogEntry(ref,row['name'],row['created_at'],row['project_id'],updated,payload)
        return result
    except ValueError as e:raise HTTPException(422,str(e)) from e


def tables(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS workflow_attachments (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, origin_key TEXT NOT NULL,
      source_ref TEXT NOT NULL, plate_index INTEGER NOT NULL, name TEXT NOT NULL,
      hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(project_id,origin_key,hash))''')

class Attachment(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ref: str
    index: int = Field(ge=0,lt=2000)
    name: str = Field(min_length=1,max_length=255)
    sha256: str = Field(pattern='^[a-f0-9]{64}$')

@router.post('/attachments')
def attach(body: Attachment):
    from backend.gel.routes import read_blob
    from backend.gel.engine import decode
    entry=db.get_log(body.ref)
    if not entry:raise HTTPException(404,'プレートが見つかりません。')
    outputs=entry.payload.get('packedPlates',[])
    if body.index>=len(outputs) or entry.payload.get('electrophoresis'):raise HTTPException(422,'出力プレートを選択してください。')
    try:
        decode(read_blob(body.sha256),body.name)
        origin=outputs[body.index].get('outputOrigin',{'ref':body.ref,'index':body.index})
        key=db._output_origin_key(origin)
        root=db.get_log(origin['ref'])
        if not root or root.project_id!=entry.project_id or origin['index']>=len(root.payload.get('packedPlates',[])):raise ValueError('元プレートの対応を確認してください。')
        with db._database(write=True) as conn:
            tables(conn)
            db._execute(conn,'''INSERT INTO workflow_attachments(id,project_id,origin_key,source_ref,plate_index,name,hash,created_at)
                VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,origin_key,hash) DO NOTHING''',
                (uuid4().hex,entry.project_id,key,body.ref,body.index,body.name,body.sha256,db._now_iso()))
            result=db._execute(conn,'SELECT * FROM workflow_attachments WHERE project_id=? AND origin_key=? AND hash=?',(entry.project_id,key,body.sha256)).fetchone()
        return dict(result)
    except ValueError as e:raise HTTPException(422,str(e)) from e

@router.get('/attachments')
def attachments(project_id: str):
    with db._database() as conn:
        db._require_project(conn,project_id);tables(conn)
        return [dict(r) for r in db._execute(conn,'SELECT * FROM workflow_attachments WHERE project_id=? ORDER BY created_at,id',(project_id,)).fetchall()]

@router.get('/attachments/{attachment_id}')
def attachment(attachment_id: str):
    with db._database() as conn:
        tables(conn);row=db._execute(conn,'SELECT * FROM workflow_attachments WHERE id=?',(attachment_id,)).fetchone()
    if not row:raise HTTPException(404,'画像が見つかりません。')
    return dict(row)

@router.get('/attachments/{attachment_id}/file')
def attachment_file(attachment_id: str):
    from backend.gel.routes import read_blob
    meta=attachment(attachment_id)
    return Response(read_blob(meta['hash']),media_type='application/octet-stream',headers={'Content-Disposition':"attachment; filename*=UTF-8''"+quote(meta['name'],safe='')})
