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


if __name__ == '__main__':
    unittest.main()
