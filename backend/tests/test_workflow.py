import base64
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import hashlib
import os
import tempfile
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from PIL import Image
from backend.app import app
from backend.api import logs_db as db

class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.addCleanup(patch.stopall)
        patch.object(db,'DB_PATH',Path(self.temp.name)/'workflow.sqlite').start();patch.object(db,'_HAS_POSTGRES',False).start();patch.dict(os.environ,{'PATH':os.environ.get('PATH','')},clear=True).start();db.init_db()
        self.c=TestClient(app);self.c.__enter__();self.addCleanup(self.c.__exit__,None,None,None)
    def register(self):
        r=self.c.post('/api/workflow/registrations',json={'name':'実験A','project_id':'default-project'});self.assertEqual(r.status_code,200,r.text);return r.json()
    def save(self,e,payload,stage='input'):
        return self.c.put('/api/workflow/registrations/'+e['id'],json={'expected_updated_at':e['updated_at'],'payload':payload,'stage':stage})
    def output(self,e):
        p=deepcopy(e['payload']);p['plates'][0]['wells']=['A1'];grid=[[None]*12 for _ in range(8)];grid[0][0]={'sourcePlate':'1','sourceWell':'A1'};p['packedPlates']=[{'id':'DEST-001','grid':grid}];r=self.save(e,p,'output');self.assertEqual(r.status_code,200,r.text);return r.json()
    def upload(self):
        stream=BytesIO();Image.new('L',(120,80),40).save(stream,format='PNG');raw=stream.getvalue();key=hashlib.sha256(raw).hexdigest()
        self.assertEqual(self.c.put(f'/api/electrophoresis/blobs/{key}/chunks/0',json={'data':base64.b64encode(raw).decode()}).status_code,200)
        self.assertEqual(self.c.post(f'/api/electrophoresis/blobs/{key}/complete',json={'size':len(raw),'chunks':1}).status_code,200);return key,raw
    def test_registered_input_resumes_same_record_then_outputs_once(self):
        e=self.register();p=deepcopy(e['payload']);p['plates'][0]['wells']=['A1'];saved=self.save(e,p);self.assertEqual(saved.status_code,200);saved=saved.json()
        self.assertEqual(saved['id'],e['id']);self.assertEqual(self.c.get('/api/logs/'+e['id']).json()['payload']['plates'][0]['wells'],['A1'])
        out=self.output(saved);self.assertEqual(out['payload']['workflow']['stage'],'output');self.assertEqual(len(db.list_logs()),1)
        self.assertEqual(self.save(out,p).status_code,409)
    def test_stale_input_cannot_overwrite_newer_input(self):
        e=self.register();p=deepcopy(e['payload']);p['plates'][0]['wells']=['B2'];self.assertEqual(self.save(e,p).status_code,200)
        self.assertEqual(self.save(e,e['payload']).status_code,409);self.assertEqual(db.get_log(e['id']).payload['plates'][0]['wells'],['B2'])
    def test_invalid_output_is_atomic_and_remains_input(self):
        e=self.register();p=deepcopy(e['payload']);p['plates'][0]['wells']=['A1'];p['packedPlates']=[{'grid':[[None]*12 for _ in range(8)]}]
        self.assertEqual(self.save(e,p,'output').status_code,422);self.assertEqual(db.get_log(e['id']).payload,e['payload'])
        p['plates']=[None];self.assertEqual(self.save(e,p).status_code,422)
    def test_photo_survives_reload_and_visibility_changes(self):
        e=self.output(self.register());key,raw=self.upload();body={'ref':e['id'],'index':0,'name':'泳動.png','sha256':key}
        first=self.c.post('/api/workflow/attachments',json=body);self.assertEqual(first.status_code,200,first.text);a=first.json()
        self.assertEqual(self.c.post('/api/workflow/attachments',json=body).json()['id'],a['id'])
        self.c.post('/api/output-plates/states',json={'project_id':'default-project','selections':[{'ref':e['id'],'index':0}],'status':'hidden'})
        listed=self.c.get('/api/workflow/attachments?project_id=default-project').json();self.assertEqual(len(listed),1);self.assertEqual(listed[0]['origin_key'],e['id']+'#0')
        self.assertEqual(self.c.get('/api/workflow/attachments/'+a['id']+'/file').content,raw)
    def test_input_and_missing_image_cannot_be_attached(self):
        e=self.register();key,_=self.upload();body={'ref':e['id'],'index':0,'name':'test.png','sha256':key};self.assertEqual(self.c.post('/api/workflow/attachments',json=body).status_code,422)
        e=self.output(e);body.update(ref=e['id'],sha256='a'*64);self.assertEqual(self.c.post('/api/workflow/attachments',json=body).status_code,422)
    def test_attachments_follow_completed_plate_origin(self):
        import json,subprocess
        e=self.output(self.register());entry={**e,'ref':e['id']}
        script="const c=require('./frontend/assets/plate-editor-core.js');const e=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(c.complete([{entry:e,index:0}])));"
        result=json.loads(subprocess.check_output(['node','-e',script],input=json.dumps(entry).encode()))
        edited=self.c.post('/api/logs',json={'name':result['name'],'project_id':e['project_id'],'payload':result['data']}).json()
        key,_=self.upload();r=self.c.post('/api/workflow/attachments',json={'ref':edited['id'],'index':0,'name':'再PCR.png','sha256':key});self.assertEqual(r.status_code,200,r.text);self.assertEqual(r.json()['origin_key'],e['id']+'#0')
