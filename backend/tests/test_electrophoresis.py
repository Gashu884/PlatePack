"""Original-byte persistence, quantitative invariants and repeat-PCR workflow."""
import base64, copy, hashlib, io, os, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
from PIL import Image
from fastapi.testclient import TestClient
from backend.app import app
from backend.api import logs_db
from backend.gel.routes import CHUNK, read_blob, setup
from backend.gel.engine import decode, measure, quantify

class ElectrophoresisTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.addCleanup(patch.stopall)
        patch.object(logs_db,'DB_PATH',Path(self.temp.name)/'test.sqlite').start()
        patch.object(logs_db,'_HAS_POSTGRES',False).start();patch.dict(os.environ,{},clear=True).start()
        logs_db.init_db();self.client=TestClient(app)

    def upload(self,raw):
        key=hashlib.sha256(raw).hexdigest()
        for i,start in enumerate(range(0,len(raw),CHUNK)):
            r=self.client.put(f'/api/electrophoresis/blobs/{key}/chunks/{i}',json={'data':base64.b64encode(raw[start:start+CHUNK]).decode()});self.assertEqual(r.status_code,200,r.text)
        r=self.client.post(f'/api/electrophoresis/blobs/{key}/complete',json={'size':len(raw),'chunks':(len(raw)+CHUNK-1)//CHUNK});self.assertEqual(r.status_code,200,r.text)
        return key

    def fixture(self,scale=1,name='synthetic.tif'):
        y=np.arange(100);a=np.ones((100,150))*10
        for x,height in [(20,100),(60,40),(100,80)]:a[:,x-5:x+5]+=height*np.exp(-.5*((y-50)/3)**2)[:,None]
        a=np.round(a*scale).astype('uint16');b=io.BytesIO();Image.fromarray(a).save(b,format='TIFF');key=self.upload(b.getvalue())
        cfg=dict(rows=1,cols=2,roiWidth=10,roiHeight=30,snrThreshold=.1,minSignal=.0001,poolTotal=100,poolMin=1,poolMax=20,poolStep=.1,widthMode='manual',rois=[dict(id=i+1,row=0,col=i,x=x,y=50,sample='S'+str(i),well='1-A'+str(i+1),decision='auto',poolGroup='Pool1') for i,x in enumerate((60,100))])
        cfg['useMarker']=True;setup(cfg,{'sha256':key});cfg['markers']=[dict(id=1000,row=0,col=-1,x=20,y=50,roiWidth=10,roiHeight=30,confirmed=True,relativeLoad=1,baseline=None)]
        return {'image':{'name':name,'sha256':key},'config':cfg}

    def test_chunked_roundtrip_is_immutable_and_rejects_incomplete_or_corrupt_upload(self):
        raw=bytes(range(256))*2200;key=self.upload(raw);self.assertEqual(read_blob(key),raw)
        bad=self.client.put(f'/api/electrophoresis/blobs/{key}/chunks/0',json={'data':'YWJj'});self.assertEqual(bad.status_code,422)
        self.assertEqual(read_blob(key),raw)
        key2='f'*64;self.client.put(f'/api/electrophoresis/blobs/{key2}/chunks/0',json={'data':'YWJj'})
        self.assertEqual(self.client.post(f'/api/electrophoresis/blobs/{key2}/complete',json={'size':3,'chunks':1}).status_code,422)
        self.assertEqual(self.client.get(f'/api/electrophoresis/blobs/{key2}').status_code,404)

    def test_quantification_recomputed_from_original_and_corrected_by_marker(self):
        s=self.fixture();r=self.client.post('/api/electrophoresis/restore',json=s);self.assertEqual(r.status_code,200,r.text)
        q=r.json()['quantification'];self.assertTrue(q['markerResults'][0]['valid']);self.assertEqual(len(q['results']),2)
        self.assertAlmostEqual(q['results'][1]['area']/q['results'][0]['area'],2,delta=.04)
        s['quantification']={'results':[{'area':9999999}]}
        p=self.client.post('/api/electrophoresis/plan',json={'sessions':[s],'groupSize':48});self.assertEqual(p.status_code,200,p.text)
        p=p.json();self.assertEqual(p['count'],2);self.assertEqual(sorted(r['volume'] for r in p['samples']),[1,2]);self.assertLess(p['plans'][0]['median'],1)
        cfg=copy.deepcopy(s['config']);cfg['rois'][0]['baseline']=[0,100,29,100]
        q2=self.client.post('/api/electrophoresis/measure',json={'sha256':s['image']['sha256'],'config':cfg}).json()
        self.assertEqual(q2['results'][0]['area'],0);self.assertEqual(len(q2['results']),2)

    def test_maximum_pixels_do_not_warn_or_exclude_samples_and_markers(self):
        template=self.fixture()
        for bits,maximum in ((8,255),(16,65535)):
            with self.subTest(bits=bits):
                y=np.arange(100);a=np.ones((100,150))*10
                for x,height in ((20,300),(60,300),(100,80)):
                    a[:,x-5:x+5]+=height*np.exp(-.5*((y-50)/3)**2)[:,None]
                pixels=np.round(np.clip(a*maximum/255,0,maximum)).astype('uint8' if bits==8 else 'uint16')
                stream=io.BytesIO();Image.fromarray(pixels).save(stream,format='TIFF');raw=stream.getvalue();key=self.upload(raw)
                session=copy.deepcopy(template);session['image']={'name':'exposure.tif','sha256':key};session['config']['imageHash']=key
                session['quantification']={'results':[{'status':'review','flags':['飽和画素あり']}]}
                restored=self.client.post('/api/electrophoresis/restore',json=session)
                self.assertEqual(restored.status_code,200,restored.text);q=restored.json()['quantification']
                self.assertGreater(q['results'][0]['saturatedFraction'],0)
                self.assertGreater(q['markerResults'][0]['saturatedFraction'],0)
                self.assertEqual(q['results'][0]['status'],'detected');self.assertTrue(q['markerResults'][0]['valid'])
                self.assertFalse(any('飽和' in flag for m in q['results']+q['markerResults'] for flag in m['flags']))
                measured=self.client.post('/api/electrophoresis/measure',json={'sha256':key,'config':session['config']})
                self.assertEqual(measured.status_code,200,measured.text)
                self.assertAlmostEqual(measured.json()['results'][0]['area'],q['results'][0]['area'])
                session['measuredVersion']='platepack-gel-1.0.0'
                self.assertEqual(self.client.post('/api/electrophoresis/plan',json={'sessions':[session]}).status_code,422)
                session['measuredVersion']=q['version']
                plan=self.client.post('/api/electrophoresis/plan',json={'sessions':[session]})
                self.assertEqual(plan.status_code,200,plan.text);self.assertEqual(plan.json()['count'],2)
                self.assertEqual(plan.json()['version'],q['version']);self.assertEqual(read_blob(key),raw)

    def test_repcr_uses_marker_correction_and_keeps_original_tube(self):
        a=self.fixture();b=self.fixture(scale=2,name='repeat.tif');b['config']['rois']=b['config']['rois'][:1];b['config']['rois'][0]['poolGroup']='WrongRepeatTube'
        r=self.client.post('/api/electrophoresis/plan',json={'sessions':[a,b],'groupSize':48});self.assertEqual(r.status_code,200,r.text)
        p=r.json();self.assertEqual(p['sampleCount'],2);self.assertEqual(len(p['records']),3)
        first=next(x for x in p['samples'] if x['sampleId']=='S0');self.assertEqual(first['imageName'],'repeat.tif');self.assertEqual(first['group'],'Pool1');self.assertEqual(first['volume'],2)

    def test_custom_group_size_blocks_oversized_tube_and_invalid_marker_is_not_used(self):
        s=self.fixture();p=self.client.post('/api/electrophoresis/plan',json={'sessions':[s],'groupSize':1}).json();self.assertFalse(p['ready']);self.assertTrue(p['blockers'])
        s['config']['markers'][0]['confirmed']=False
        p=self.client.post('/api/electrophoresis/plan',json={'sessions':[s],'groupSize':48}).json();self.assertEqual(p['count'],0);self.assertTrue(all('500bp' in r['error'] for r in p['samples']))

    def test_marker_free_measurement_and_multi_image_pool_ignore_marker_geometry(self):
        first=self.fixture();second=self.fixture(scale=2,name='second.tif')
        for session in (first,second):
            session['config']['useMarker']=False
            session['config']['markers']=[{'row':0,'x':-999,'y':-999,'baseline':['unused'],'confirmed':False}]
            measured=self.client.post('/api/electrophoresis/measure',json={'sha256':session['image']['sha256'],'config':session['config']})
            self.assertEqual(measured.status_code,200,measured.text);self.assertEqual(measured.json()['markerResults'],[])
            session['measuredVersion']=measured.json()['version']
        planned=self.client.post('/api/electrophoresis/plan',json={'sessions':[first,second],'useMarker':False})
        self.assertEqual(planned.status_code,200,planned.text);p=planned.json()
        self.assertFalse(p['useMarker']);self.assertEqual(p['count'],2)
        self.assertTrue(all(r['markerArea'] is None and r['error'] is None for r in p['samples']))
        self.assertTrue(all(r['signal']==r['area'] for r in p['samples']))
        mismatch=self.client.post('/api/electrophoresis/plan',json={'sessions':[first],'useMarker':True})
        self.assertEqual(mismatch.status_code,422)
        second['config']['useMarker']=True
        mixed=self.client.post('/api/electrophoresis/plan',json={'sessions':[first,second]})
        self.assertEqual(mixed.status_code,422)

    def test_direct_area_measurement_ignores_labels_mappings_width_review_and_markers(self):
        session=self.fixture();cfg=session['config'];cfg['rois'][0]['decision']='repcr';cfg['rois'][1]['decision']='exclude'
        for r in cfg['rois']:r['sample']='';r['well']=''
        cfg['widthMode']='widest';cfg['widthReport']={'status':'needs_review','candidates':[]}
        cfg['markers']=[{'row':0,'x':-999,'y':-999,'confirmed':False}]
        measured=self.client.post('/api/electrophoresis/areas',json={'sha256':session['image']['sha256'],'config':cfg})
        self.assertEqual(measured.status_code,200,measured.text);q=measured.json()
        self.assertEqual(q['mode'],'manual-selection');self.assertEqual(q['markerResults'],[])
        self.assertEqual(len(q['results']),2);self.assertTrue(all(m['area']>0 for m in q['results']))
        self.assertAlmostEqual(q['results'][1]['area']/q['results'][0]['area'],2,delta=.04)

    def test_analysis_blob_reference_survives_save_copy_move_and_reconnect(self):
        raw=b'{"version":1,"sessions":[]}';key=self.upload(raw)
        payload={'recordType':'electrophoresis','plates':[{'uid':'plate1','wells':['A1']}],'electrophoresis':{'version':1,'blob':key}}
        log=logs_db.create_log('gel',payload);project=logs_db.create_folder('P2','project',logs_db.DEFAULT_PERSON_ID)
        other=logs_db.copy_log(log.id,project.id);logs_db.update_log(log.id,project_id=project.id)
        self.assertEqual(logs_db.get_log(other.id).payload,payload);self.assertEqual(read_blob(key),raw)
        rows=self.client.get('/api/logs').json();self.assertTrue(all(r['record_type']=='electrophoresis' for r in rows))

    def test_16bit_signal_and_original_pixels_preserved(self):
        a=np.array([[0,2000],[40000,65535]],dtype='uint16');b=io.BytesIO();Image.fromarray(a).save(b,format='PNG')
        decoded,meta=decode(b.getvalue(),'raw.png');self.assertEqual(meta['bitDepth'],16);np.testing.assert_array_equal(decoded,a)

    def test_large_preview_is_resized_without_changing_measurement_pixels(self):
        a=np.arange(4096,dtype='uint16')[None,:].repeat(64,axis=0);b=io.BytesIO();Image.fromarray(a).save(b,format='PNG')
        decoded,meta=decode(b.getvalue(),'large.png');np.testing.assert_array_equal(decoded,a)
        preview=Image.open(io.BytesIO(base64.b64decode(meta['preview'].split(',')[1])))
        self.assertEqual(meta['width'],4096);self.assertEqual(preview.width,2048)

    def test_corrupt_image_returns_a_readable_error(self):
        key=self.upload(b'not a TIFF')
        r=self.client.post('/api/electrophoresis/detect',json={'sha256':key})
        self.assertEqual(r.status_code,422);self.assertIn('画像',r.json()['detail'])

    def test_invalid_roi_and_color_image_are_rejected(self):
        s=self.fixture();s['config']['rois'][0]['x']=-1
        self.assertEqual(self.client.post('/api/electrophoresis/restore',json=s).status_code,422)
        b=io.BytesIO();Image.new('RGB',(100,100)).save(b,format='PNG');key=self.upload(b.getvalue())
        self.assertEqual(self.client.post('/api/electrophoresis/detect',json={'sha256':key}).status_code,422)

    def test_auto_layout_distinguishes_48_and_96_and_keeps_blank_sample_slots(self):
        for rows in (2,4):
            with self.subTest(rows=rows):
                h=rows*220+140;y,x=np.mgrid[:h,:1050];a=np.zeros((h,1050));a[30:h-30,50:1000]=12
                for r in range(rows):
                    for c in range(24):
                        for center,signal,width in ((100+r*220,65,3),(160+r*220,130 if c!=8 else 0,4),(200+r*220,12,4)):
                            a+=signal*np.exp(-.5*((y-center)/width)**2)*np.exp(-.5*((x-(130+c*34))/7)**2)
                    for center in range(110+r*220,201+r*220,12):
                        a+=100*np.exp(-.5*((y-center)/2)**2)*np.exp(-.5*((x-96)/5)**2)
                pixels=np.round(a).astype('uint8');stream=io.BytesIO();Image.fromarray(pixels).save(stream,format='TIFF');raw=stream.getvalue();key=self.upload(raw)
                out=self.client.post('/api/electrophoresis/detect',json={'sha256':key,'rows':'auto','cols':24})
                self.assertEqual(out.status_code,200,out.text);cfg=out.json()['config']
                self.assertFalse(cfg['useMarker']);self.assertEqual(out.json()['quantification']['markerResults'],[])
                self.assertEqual(cfg['rows'],rows);self.assertEqual(len(cfg['rois']),rows*24)
                self.assertEqual([r['id'] for r in cfg['rois']],list(range(1,rows*24+1)))
                self.assertEqual(cfg['grid']['targetRows'],[160+220*r for r in range(rows)])
                self.assertAlmostEqual(cfg['grid']['pitch'],34,delta=.5)
                for r in range(rows):
                    blank=cfg['rois'][r*24+8];self.assertEqual(blank['col'],8);self.assertAlmostEqual(blank['x'],130+8*34,delta=3)
                capped=self.client.post('/api/electrophoresis/detect',json={'sha256':key,'rows':'auto','cols':24,'maxRois':rows*24})
                self.assertEqual(capped.status_code,200,capped.text)
                capped_cfg=capped.json()['config'];self.assertEqual([r['id'] for r in capped_cfg['rois']],list(range(1,rows*24+1)))
                measured=self.client.post('/api/electrophoresis/areas',json={'sha256':key,'config':capped_cfg})
                self.assertEqual(measured.status_code,200,measured.text);results=measured.json()['results']
                self.assertEqual(len(results),rows*24)
                for row in range(rows):self.assertEqual(results[row*24+8]['status'],'undetected')
                self.assertEqual(len(cfg['markers']),rows);self.assertEqual(read_blob(key),raw)
                decoded,_=decode(raw,'original.tif');np.testing.assert_array_equal(decoded,pixels)
                explicit=self.client.post('/api/electrophoresis/redetect',json={'sha256':key,'rows':rows,'cols':24})
                self.assertEqual(explicit.status_code,200,explicit.text)
                self.assertEqual(explicit.json()['config']['grid']['targetRows'],cfg['grid']['targetRows'])

if __name__=='__main__':unittest.main()
