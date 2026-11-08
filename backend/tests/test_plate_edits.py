"""Edited layouts are immutable records with a replayable, verified journal."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from copy import deepcopy
from fastapi.testclient import TestClient
from backend.app import app
from backend.api import logs_db
from backend.api.plate_edits import validate_edit


ROOT = Path(__file__).resolve().parents[2]


def edited_fixture():
    # Use the actual browser domain module to verify the JS/Python contract.
    script = r"""
const c=require('./frontend/assets/plate-editor-core.js');
const grid=()=>Array.from({length:8},()=>Array(12).fill(null));
const entry=(ref)=>{const g=grid();g[0][0]={sourcePlate:'1',sourceWell:'A1',growthWeek:2};g[0][1]={sourcePlate:'1',sourceWell:'B2',growthWeek:4};return {ref,name:ref,project_id:'default-project',payload:{plates:[{uid:'input',label:'Input',wells:['A1','B2'],growthWeeks:{A1:2,B2:4}}],packedPlates:[{id:'DEST-001',grid:g}]}}};
let {data}=c.assemble([{entry:entry('raw-one'),index:0},{entry:entry('raw-two'),index:0}]);
data=c.apply(data,{type:'move',from:0,to:1,wells:['A1'],anchor:'A1',target:'A2'});
data=c.apply(data,{type:'move',from:0,to:1,wells:['A1','A2','A3'],anchor:'A1',target:'C1'});
data=c.apply(data,{type:'delete',from:1,wells:['A1']});
process.stdout.write(JSON.stringify(data));
"""
    return json.loads(subprocess.check_output(["node", "-e", script], cwd=ROOT))


class PlateEditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(logs_db, "DB_PATH", Path(self.temp.name)/"test.sqlite").start()
        patch.object(logs_db, "_HAS_POSTGRES", False).start()
        patch.dict(os.environ, {"PATH": os.environ.get("PATH", "")}, clear=True).start()
        logs_db.init_db()
        self.payload = edited_fixture()

    def test_replay_accepts_cross_plate_exchange_range_and_deletion(self):
        before = deepcopy(self.payload)
        validate_edit(self.payload)
        self.assertEqual(self.payload, before)

    def test_replay_rejects_silent_loss_duplication_or_wrong_phase(self):
        for field, value in [("sourceWell", "H12"), ("growthWeek", 5)]:
            payload = deepcopy(self.payload)
            cell = next(c for p in payload["packedPlates"] for row in p["grid"] for c in row if c)
            cell[field] = value
            with self.assertRaises(ValueError):
                validate_edit(payload)
        payload = deepcopy(self.payload)
        payload["packedPlates"][1]["grid"][0][1] = None
        with self.assertRaises(ValueError):
            validate_edit(payload)

    def test_replay_blocks_occupied_range_even_when_client_claims_valid_result(self):
        self.payload["plateEdit"]["operations"][1]["target"] = "A1"
        with self.assertRaisesRegex(ValueError, "範囲移動先"):
            validate_edit(self.payload)

    def test_api_saves_one_record_for_two_roots_and_retains_original(self):
        with TestClient(app) as client:
            original = client.post('/api/logs', json={"name":"Original", "payload":{"keep":[1,2,3]}}).json()
            before = client.get('/api/logs/'+original['id']).json()
            response = client.post('/api/logs', json={"name":"Original_ed", "payload":self.payload})
            self.assertEqual(response.status_code, 200, response.text)
            saved = response.json()
            self.assertEqual(saved['record_type'], 'edited_plate')
            self.assertEqual(saved['parent_refs'], ['raw-one','raw-two'])
            reread = client.get('/api/logs/'+saved['id']).json()
            self.assertEqual(reread['payload'], self.payload)
            self.assertEqual(client.get('/api/logs/'+original['id']).json(), before)
            summary = next(x for x in client.get('/api/logs').json() if x['id']==saved['id'])
            self.assertEqual(summary['parent_refs'], ['raw-one','raw-two'])
            self.assertEqual(summary['record_type'], 'edited_plate')
            self.assertEqual(len(client.get('/api/logs').json()), 2)

    def test_invalid_edit_does_not_create_partial_record(self):
        self.payload['plateEdit']['operations'][0]['to'] = -1
        with TestClient(app) as client:
            response = client.post('/api/logs', json={"name":"Invalid_ed", "payload":self.payload})
            self.assertEqual(response.status_code, 422)
            self.assertEqual(client.get('/api/logs').json(), [])

    def test_output_page_and_assets_are_served(self):
        with TestClient(app) as client:
            self.assertEqual(client.get('/output-plates').status_code, 200)
            self.assertIn('範囲選択', client.get('/output-plates').text)
            self.assertEqual(client.get('/assets/plate-editor-core.js').status_code, 200)

    def corrected(self):
        script = """
const c=require('./frontend/assets/plate-editor-core.js');
const data=JSON.parse(require('fs').readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(c.apply(data,{type:'correct-source',from:1,wells:['A2'],sourcePlate:'2',sourceWell:'F5'})));
"""
        return json.loads(subprocess.check_output(['node', '-e', script], input=json.dumps(self.payload).encode(), cwd=ROOT))

    def test_source_correction_roundtrips_with_history_and_preserved_destination(self):
        corrected = self.corrected()
        validate_edit(corrected)
        self.assertEqual(corrected['packedPlates'][1]['grid'][0][1]['sourceWell'], 'F5')
        self.assertEqual(corrected['plateEdit']['operations'][-1]['before'], {'sourcePlate':'1','sourceWell':'A1'})
        self.assertNotIn('A1', corrected['plates'][0]['wells'])
        self.assertEqual(corrected['plates'][1]['growthWeeks']['F5'], 2)
        with TestClient(app) as client:
            response = client.post('/api/logs', json={'name':'Corrected_ed','payload':corrected})
            self.assertEqual(response.status_code, 200, response.text)
            saved = client.get('/api/logs/'+response.json()['id']).json()
            self.assertEqual(saved['payload'], corrected)

    def test_source_correction_cannot_forge_history_sources_or_duplicate_sample(self):
        corrected = self.corrected()
        for mutate in (
            lambda p: p['plateEdit']['operations'][-1]['before'].update(sourceWell='H12'),
            lambda p: p['plates'][1]['growthWeeks'].update(F5=5),
            lambda p: p['plates'][0]['wells'].append('A1'),
            lambda p: p['plateEdit']['operations'][-1].update(sourceWell='B2'),
            lambda p: p['plateEdit']['operations'][-1].update(sourcePlate='9'),
        ):
            payload = deepcopy(corrected)
            mutate(payload)
            with self.assertRaises(ValueError):
                validate_edit(payload)

    def test_legacy_saved_edits_still_validate_without_input_snapshot(self):
        del self.payload['plateEdit']['initialSourcePlates']
        validate_edit(self.payload)

    def test_hidden_states_persist_and_restore_without_mutating_plate_data(self):
        with TestClient(app) as client:
            saved = client.post('/api/logs', json={'name':'Layout_ed','payload':self.payload}).json()
            selection = {'ref':saved['id'],'index':0}
            body = {'project_id':'default-project','selections':[selection],'status':'hidden'}
            response = client.post('/api/output-plates/states',json=body)
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.json()['raw-one#0']['status'],'hidden')
            self.assertEqual(client.get('/api/output-plates/states?project_id=default-project').json(),response.json())
            self.assertEqual(client.get('/api/logs/'+saved['id']).json()['payload'],self.payload)
            body['status']='active'
            self.assertEqual(client.post('/api/output-plates/states',json=body).json()['raw-one#0']['status'],'active')

    def test_whole_group_can_hide_and_restore_more_than_24_plates(self):
        raw = {'plates': [], 'packedPlates': [
            {'id': f'Plate_{i+1:02}', 'grid': [[None]*12 for _ in range(8)]}
            for i in range(30)
        ]}
        with TestClient(app) as client:
            saved = client.post('/api/logs', json={'name':'Group','payload':raw}).json()
            body = {'project_id':'default-project', 'status':'hidden',
                    'selections':[{'ref':saved['id'],'index':i} for i in range(30)]}
            hidden = client.post('/api/output-plates/states', json=body)
            self.assertEqual(hidden.status_code, 200, hidden.text)
            self.assertEqual(len(hidden.json()), 30)
            self.assertTrue(all(s['status']=='hidden' for s in hidden.json().values()))
            body['status'] = 'active'
            restored = client.post('/api/output-plates/states', json=body)
            self.assertEqual(restored.status_code, 200, restored.text)
            self.assertTrue(all(s['status']=='active' for s in restored.json().values()))
            self.assertEqual(client.get('/api/logs/'+saved['id']).json()['payload'], raw)

    def test_state_batch_is_atomic_and_rejects_invalid_or_cross_project_selection(self):
        with TestClient(app) as client:
            saved = client.post('/api/logs', json={'name':'Layout_ed','payload':self.payload}).json()
            body = {'project_id':'default-project','selections':[{'ref':saved['id'],'index':0},{'ref':'missing','index':0}],'status':'hidden'}
            self.assertEqual(client.post('/api/output-plates/states',json=body).status_code,422)
            self.assertEqual(client.get('/api/output-plates/states?project_id=default-project').json(),{})
            project = client.post('/api/folders',json={'name':'Other','kind':'project','parent_id':'default-person'}).json()
            body.update(project_id=project['id'], selections=[{'ref':saved['id'],'index':0}])
            self.assertEqual(client.post('/api/output-plates/states',json=body).status_code,422)

    def test_completion_file_and_states_commit_together_and_preserve_original(self):
        with TestClient(app) as client:
            saved = client.post('/api/logs',json={'name':'Layout_ed','payload':self.payload}).json()
            entry = client.get('/api/logs/'+saved['id']).json();entry['ref']=entry['id']
            script="const c=require('./frontend/assets/plate-editor-core.js'),entry=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(c.complete([{entry,index:1}])));"
            done=json.loads(subprocess.check_output(['node','-e',script],input=json.dumps(entry).encode(),cwd=ROOT))
            response=client.post('/api/logs',json={'name':done['name'],'payload':done['data']})
            self.assertEqual(response.status_code,200,response.text)
            state=client.get('/api/output-plates/states?project_id=default-project').json()
            self.assertNotIn('raw-one#0',state)
            self.assertEqual(state['raw-two#0'],{'status':'completed','completed_ref':response.json()['id']})
            self.assertEqual(len(done['data']['packedPlates']),1)
            self.assertEqual(client.get('/api/logs/'+saved['id']).json()['payload'],self.payload)
            restore=client.post('/api/output-plates/states',json={'project_id':'default-project','selections':[{'ref':response.json()['id'],'index':0}],'status':'active'})
            self.assertEqual(restore.json()['raw-two#0']['status'],'active')
            self.assertEqual(restore.json()['raw-two#0']['completed_ref'],response.json()['id'])

    def test_group_file_requires_all_completed_and_preserves_latest_separate_revisions(self):
        script = """const c=require('./frontend/assets/plate-editor-core.js');
const x=JSON.parse(require('fs').readFileSync(0,'utf8'));
const result=x.mode==='group'?c.completeGroup(c.overviewGroups(x.entries,x.states)[0]):c.complete([{entry:x.entry,index:x.index}]);
process.stdout.write(JSON.stringify(result));"""
        def build(data):
            return json.loads(subprocess.check_output(['node','-e',script],input=json.dumps(data).encode(),cwd=ROOT))
        raw = {'plates':[{'uid':'input','label':'Input','wells':['A1','B1'],'growthWeeks':{'A1':1,'B1':2}}],
               'packedPlates':[{'id':f'P{i}', 'grid':[[None]*12 for _ in range(8)]} for i in range(2)]}
        raw['packedPlates'][0]['grid'][0][0]={'sourcePlate':'1','sourceWell':'A1','growthWeek':1}
        raw['packedPlates'][1]['grid'][0][0]={'sourcePlate':'1','sourceWell':'B1','growthWeek':2}
        with TestClient(app) as client:
            root_id=client.post('/api/logs',json={'name':'Example','payload':raw}).json()['id']
            root=client.get('/api/logs/'+root_id).json();root['ref']=root_id
            entries=[root]
            for index in range(2):
                part=build({'entry':root,'index':index})
                saved=client.post('/api/logs',json={'name':part['name'],'payload':part['data']})
                self.assertEqual(saved.status_code,200,saved.text)
                e=client.get('/api/logs/'+saved.json()['id']).json();e['ref']=e['id'];entries.append(e)
            states=client.get('/api/output-plates/states?project_id=default-project').json()
            result=build({'mode':'group','entries':entries,'states':states})
            body={'name':result['name'],'payload':result['data']}
            self.assertEqual(body['name'],'Example_ed')
            # Hide one plate after the client computed its final group: refuse stale completion.
            selection={'ref':root_id,'index':1}
            client.post('/api/output-plates/states',json={'project_id':'default-project','selections':[selection],'status':'hidden'})
            before=len(client.get('/api/logs').json())
            self.assertEqual(client.post('/api/logs',json=body).status_code,422)
            self.assertEqual(len(client.get('/api/logs').json()),before)
            # Mark it complete again, then use the fresh refs to consolidate.
            part=build({'entry':root,'index':1})
            saved=client.post('/api/logs',json={'name':part['name'],'payload':part['data']}).json()
            e=client.get('/api/logs/'+saved['id']).json();e['ref']=e['id'];entries.append(e)
            states=client.get('/api/output-plates/states?project_id=default-project').json()
            result=build({'mode':'group','entries':entries,'states':states})
            response=client.post('/api/logs',json={'name':result['name'],'payload':result['data']})
            self.assertEqual(response.status_code,200,response.text)
            final=client.get('/api/logs/'+response.json()['id']).json()
            self.assertEqual(len(final['payload']['packedPlates']),2)
            self.assertEqual(final['name'],'Example_ed')
            self.assertEqual(client.get('/api/logs/'+root_id).json()['payload'],raw)
            states=client.get('/api/output-plates/states?project_id=default-project').json()
            self.assertTrue(all(s['completed_ref']==response.json()['id'] for s in states.values()))

    def test_repack_preview_then_save_compacts_inputs_and_preserves_history(self):
        from backend.api.repack import rebuild_outputs
        wells=[chr(65+r)+str(c+1) for r in range(8) for c in range(12)]
        raw={'plates':[{'wells':wells,'growthWeeks':{}},{'wells':wells[:89],'growthWeeks':{}}],
             'inputReadDirection':'row','blockedLayoutWells':['D12','H12'],
             'packedLayout':{'layoutDirection':'row','horizontalDividers':[4],'verticalDividers':[]}}
        raw['packedPlates']=rebuild_outputs(raw)[0]
        raw['plates'][0]['wells']=wells[1:]
        with TestClient(app) as client:
            saved=client.post('/api/logs',json={'name':'Group','payload':raw}).json()
            url='/api/logs/'+saved['id']+'/repack-output'
            body={'expected_updated_at':saved['updated_at'],'preview':True}
            preview=client.post(url,json=body)
            self.assertEqual(preview.status_code,200,preview.text)
            self.assertEqual(preview.json()['counts'],[94,90])
            self.assertEqual(client.get('/api/logs/'+saved['id']).json()['payload'],raw)
            body['preview']=False
            response=client.post(url,json=body)
            self.assertEqual(response.status_code,200,response.text)
            result=response.json()['payload']
            self.assertEqual(result['plates'],raw['plates'])
            self.assertEqual(result['packedPlates'][0]['grid'][0][0]['sourceWell'],'A2')
            for p in result['packedPlates']:
                self.assertIsNone(p['grid'][3][11]);self.assertIsNone(p['grid'][7][11])
            self.assertEqual(result['outputRebuilds'][0]['before'],raw['packedPlates'])
            self.assertEqual(client.post(url,json=body).status_code,422)

    def test_repack_respects_column_input_output_and_dividers(self):
        from backend.api.repack import rebuild_outputs
        raw={'plates':[{'wells':['A2','B1'],'growthWeeks':{'A2':4,'B1':2}}],
             'inputReadDirection':'column','blockedLayoutWells':['A1'],
             'packedLayout':{'layoutDirection':'column','horizontalDividers':[4],'verticalDividers':[6]}}
        result,_=rebuild_outputs(raw)
        self.assertEqual(result[0]['grid'][1][0]['sourceWell'],'B1')
        self.assertEqual(result[0]['grid'][2][0]['sourceWell'],'A2')
        self.assertEqual(result[0]['grid'][2][0]['growthWeek'],4)
        for flag in ['plateEdit','gelLinks','electrophoresis']:
            with self.assertRaises(ValueError):rebuild_outputs({**raw,flag:{'present':True}})

    def test_reconcile_clears_only_missing_sample_and_keeps_audit_and_positions(self):
        raw={'plates':[{'uid':'input','wells':['A2']}],'packedPlates':[{'id':'P1','grid':[[None]*12 for _ in range(8)]}]}
        raw['packedPlates'][0]['grid'][6][8]={'sourcePlate':'1','sourceWell':'D9','growthWeek':2}
        raw['packedPlates'][0]['grid'][6][9]={'sourcePlate':'1','sourceWell':'A2','growthWeek':3}
        target={'plate':0,'well':'G9','source_plate':'1','source_well':'D9'}
        with TestClient(app) as client:
            saved=client.post('/api/logs',json={'name':'Group','payload':raw}).json()
            url='/api/logs/'+saved['id']+'/reconcile-output'
            response=client.post(url,json={'expected_updated_at':saved['updated_at'],'cells':[target]})
            self.assertEqual(response.status_code,200,response.text)
            result=response.json()['payload']
            self.assertIsNone(result['packedPlates'][0]['grid'][6][8])
            self.assertEqual(result['outputReconciliations'][0]['removed'][0]['before'],raw['packedPlates'][0]['grid'][6][8])
            expected=deepcopy(raw);expected['packedPlates'][0]['grid'][6][8]=None
            self.assertEqual({k:v for k,v in result.items() if k!='outputReconciliations'},expected)
            self.assertEqual(client.post(url,json={'expected_updated_at':saved['updated_at'],'cells':[target]}).status_code,422)
            self.assertEqual(client.get('/api/logs/'+saved['id']).json()['payload'],result)

    def test_reconcile_rejects_existing_input_wrong_source_and_partial_batches(self):
        raw={'plates':[{'uid':'input','wells':['A2']}],'packedPlates':[{'id':'P1','grid':[[None]*12 for _ in range(8)]}]}
        raw['packedPlates'][0]['grid'][0][0]={'sourcePlate':'1','sourceWell':'D9'}
        raw['packedPlates'][0]['grid'][0][1]={'sourcePlate':'1','sourceWell':'A2'}
        good={'plate':0,'well':'A1','source_plate':'1','source_well':'D9'}
        with TestClient(app) as client:
            saved=client.post('/api/logs',json={'name':'Group','payload':raw}).json()
            url='/api/logs/'+saved['id']+'/reconcile-output'
            for targets in [[{**good,'source_well':'F5'}],[good,{'plate':0,'well':'A2','source_plate':'1','source_well':'A2'}],[good,good]]:
                self.assertEqual(client.post(url,json={'expected_updated_at':saved['updated_at'],'cells':targets}).status_code,422)
                self.assertEqual(client.get('/api/logs/'+saved['id']).json()['payload'],raw)

    def test_invalid_completion_rolls_back_file_and_all_visibility_changes(self):
        self.payload['plateEdit']['collection']='completed'
        self.payload['packedPlates'][1]['outputOrigin']['index']=-1
        self.payload['plateEdit']['initialPackedPlates'][1]['outputOrigin']['index']=-1
        with TestClient(app) as client:
            response=client.post('/api/logs',json={'name':'Bad_done','payload':self.payload})
            self.assertEqual(response.status_code,422,response.text)
            self.assertEqual(client.get('/api/logs').json(),[])
            self.assertEqual(client.get('/api/output-plates/states?project_id=default-project').json(),{})


if __name__ == '__main__':
    unittest.main()
