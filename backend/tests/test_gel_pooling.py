import unittest, copy, itertools, random, tempfile
from pathlib import Path
from backend.gel.pooling import optimize_pool, plan_project

class PoolTests(unittest.TestCase):
    def test_maximum_count_matches_exhaustive_subsets(self):
        random.seed(3)
        for _ in range(40):
            signals=[10**random.uniform(-2,2) for i in range(8)]
            result=optimize_pool([{'key':str(i),'signal':c} for i,c in enumerate(signals)])
            expected=max(len(s) for n in range(1,9) for s in itertools.combinations(signals,n) if max(s)/min(s)<=20)
            self.assertEqual(result['count'],expected)
            selected=result['selected'];self.assertTrue(all(1<=r['volume']<=20 for r in selected))
            self.assertTrue(all(abs(r['volume']*10-round(r['volume']*10))<1e-8 for r in selected))
            self.assertAlmostEqual(min(r['idealVolume'] for r in selected),1)
            for r in selected:self.assertAlmostEqual(r['idealVolume']*r['signal'],result['target'])
    def test_tie_prefers_close_volumes(self):
        p=optimize_pool([{'key':str(c),'signal':c} for c in [1,10,1000,1100]])
        self.assertEqual({r['signal'] for r in p['selected']},{1000,1100})
        self.assertAlmostEqual(p['spread'],.1)
    def test_boundary_and_rounding_error(self):
        p=optimize_pool([{'key':str(c),'signal':c} for c in [1,20]])
        self.assertEqual(p['count'],2);self.assertEqual(p['uniqueVolumes'],[1.,20.])
        p=optimize_pool([{'key':str(c),'signal':c} for c in [1,1.26]])
        self.assertEqual(p['uniqueVolumes'],[1.,1.3]);self.assertAlmostEqual(p['maxRoundingErrorPct'],100*(1.3/1.26-1))
    def run_fixture(self,id,signals,names=None,marker=10,valid=True,group='Tube1'):
        names=names or [f'S{i}' for i in range(len(signals))]
        rois=[{'id':i+1,'row':0,'sample':n,'poolGroup':group} for i,n in enumerate(names)]
        return {'id':id,'label':id,'sha256':id*64,'imageName':id+'.tif','config':{'rois':rois,'roiWidth':20},'quantification':{'results':[{'area':c,'relativeSignal':c,'include':True,'eligible':True,'repcr':False} for c in signals],'markerResults':[{'row':0,'area':marker,'relativeLoad':1,'valid':valid}]}}
    def test_exposure_cancels_and_repcr_not_double_counted(self):
        original=self.run_fixture('A',[20,40]);repeat=self.run_fixture('B',[80],['S0'],marker=40,group='RepeatTube')
        p=plan_project([original,repeat],{'scope':'groups','step':.1})
        self.assertEqual(p['sampleCount'],2);self.assertEqual(p['count'],2);self.assertEqual(len(p['records']),3)
        selected=next(r for r in p['samples'] if r['sampleId']=='S0')
        self.assertEqual(selected['runId'],'B');self.assertEqual(selected['group'],'Tube1');self.assertEqual(selected['signal'],2);self.assertEqual(selected['volume'],2)
        p=plan_project([original,repeat],{'scope':'groups','step':.1},{'S0':'A:1'})
        self.assertEqual(p['samples'][0]['runId'],'A')
    def test_failed_repeat_keeps_previous_valid_and_missing_reference_blocks(self):
        a=self.run_fixture('A',[20]);b=self.run_fixture('B',[60],valid=False)
        p=plan_project([a,b],{'scope':'groups','step':.1,'useMarker':False})
        self.assertTrue(p['useMarker']);self.assertEqual(p['samples'][0]['runId'],'A')
        self.assertIn('500bp',p['records'][1]['error'])
        a['quantification']['markerResults'][0]['valid']=False
        p=plan_project([a,b],{'scope':'groups','step':.1})
        self.assertEqual(p['count'],0);self.assertFalse(p['ready'])
    def test_duplicate_sample_id_and_oversized_tube_block_export(self):
        a=self.run_fixture('A',[20,30],['same','same'])
        p=plan_project([a],{'scope':'groups','step':.1});self.assertFalse(p['ready']);self.assertIn('重複',p['blockers'][0])
        a=self.run_fixture('A',[20]*49)
        p=plan_project([a],{'scope':'groups','step':.1});self.assertFalse(p['ready']);self.assertIn('指定したサンプル数',p['blockers'][0])
    def test_saturated_sample_cannot_be_forced_into_pool(self):
        a=self.run_fixture('A',[20]);a['config']['rois'][0]['decision']='include'
        a['quantification']['results'][0]['saturatedFraction']=.0001
        p=plan_project([a],{'scope':'groups','step':.1,'useMarker':True})
        self.assertEqual(p['count'],0);self.assertIn('飽和',p['samples'][0]['error'])

    def test_blank_names_never_merge_between_gels(self):
        a=self.run_fixture('A',[20],['']);b=self.run_fixture('B',[20],[''])
        p=plan_project([a,b],{'scope':'groups','step':.1});self.assertEqual(p['sampleCount'],2)
    def test_shared_target_keeps_separate_physical_tubes(self):
        a=self.run_fixture('A',[20],['a'],group='Tube1');b=self.run_fixture('B',[40],['b'],group='Tube2')
        p=plan_project([a,b],{'scope':'all','step':.1})
        self.assertEqual([t['group'] for t in p['plans']],['Tube1','Tube2']);self.assertEqual(p['plans'][0]['target'],p['plans'][1]['target'])
        self.assertEqual(p['samples'][0]['poolTube'],'Tube1')
    def test_locked_target_survives_repeat_added_and_keeps_original_volumes(self):
        a=self.run_fixture('A',[20,40],['a','b']);options={'scope':'groups','step':.1,'useMarker':True}
        before=plan_project([a],options);target=before['plans'][0]['target'];options['lockedTargets']={'Tube1':target}
        b=self.run_fixture('B',[15,100],['c','d'])
        after=plan_project([a,b],options)
        self.assertEqual(after['plans'][0]['target'],target)
        self.assertEqual([r['volume'] for r in after['samples'][:2]],[r['volume'] for r in before['samples']])
        self.assertIsNone(after['samples'][3]['volume']);self.assertIn('固定目標量',after['samples'][3]['choice'])
        self.assertTrue(after['plans'][0]['locked'])

if __name__=='__main__':unittest.main()
