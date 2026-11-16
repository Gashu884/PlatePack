import copy
import unittest
import numpy as np
from backend.gel.engine import detect_grid, quantify
from backend.gel.routes import setup


def gel():
    y,x=np.mgrid[:580,:1050];a=np.zeros((580,1050));a[30:550,50:1000]=12
    for row in range(2):
        for col in range(24):
            for center,signal,width in ((100+row*220,65,3),(160+row*220,130 if col!=8 else 0,4),(200+row*220,12,4)):
                a+=signal*np.exp(-.5*((y-center)/width)**2)*np.exp(-.5*((x-(130+col*34))/7)**2)
        for center in range(110+row*220,201+row*220,12):
            a+=100*np.exp(-.5*((y-center)/2)**2)*np.exp(-.5*((x-96)/5)**2)
    # Bright continuous gel edge, distinct from a localized DNA band.
    a+=40*np.exp(-.5*((y-540)/3)**2)*(x>50)*(x<1000)
    return a


class BandExtractionTests(unittest.TestCase):
    def test_limit_is_a_cap_and_empty_lanes_and_gel_edge_are_removed(self):
        a=gel();original=a.copy()
        cfg=setup(detect_grid(a,None,24,255,max_rois=96),{'sha256':'a'*64})
        self.assertEqual(len(cfg['rois']),46)
        self.assertEqual(cfg['rows'],2);self.assertEqual(cfg['maxRois'],96)
        ids=[r['id'] for r in cfg['rois']]
        self.assertNotIn(9,ids);self.assertNotIn(33,ids)
        self.assertEqual(ids,[i for i in range(1,49) if i not in (9,33)])
        self.assertTrue(all(r['y']<450 for r in cfg['rois']))
        self.assertEqual(len(cfg['markers']),2)
        np.testing.assert_array_equal(a,original)
        forced=detect_grid(a,3,24,255,max_rois=48)
        self.assertEqual(forced['grid']['targetRows'],[160,380,540])
        self.assertEqual(len(forced['rois']),46);self.assertEqual(forced['rows'],2)

    def test_smaller_limit_selects_stronger_bands_and_retains_original_lane_numbers(self):
        a=gel();full=detect_grid(a,None,24,255,max_rois=96);limited=detect_grid(a,None,24,255,max_rois=5)
        self.assertEqual(len(limited['rois']),5)
        identities={r['id']:(r['row'],r['col'],r['x'],r['y']) for r in full['rois']}
        for roi in limited['rois']:self.assertEqual(identities[roi['id']],(roi['row'],roi['col'],roi['x'],roi['y']))
        self.assertEqual(limited['detectedCandidates'],46)

    def test_absent_first_lane_does_not_move_marker_to_the_next_sample(self):
        cfg=detect_grid(gel(),None,24,255,max_rois=1)
        cfg=setup(cfg,{'sha256':'a'*64})
        for marker in cfg['markers']:
            self.assertAlmostEqual(marker['x'],cfg['grid']['start']-cfg['grid']['pitch'],delta=.02)

    def test_invalid_limits_are_rejected_and_restore_does_not_reextract_legacy_records(self):
        for limit in (0,385,2.5,True,'48'):
            with self.subTest(limit=limit),self.assertRaises(ValueError):detect_grid(gel(),None,24,255,max_rois=limit)
        legacy=detect_grid(gel(),2,24,255);before=copy.deepcopy(legacy)
        self.assertEqual(len(legacy['rois']),48);quantify(gel(),legacy,255)
        self.assertEqual(legacy,before)

    def test_no_bands_produces_no_sample_or_marker_rois(self):
        a=gel()*.01;cfg=setup(detect_grid(a,None,24,255,max_rois=48),{'sha256':'a'*64})
        self.assertEqual(cfg['rois'],[]);self.assertEqual(cfg['markers'],[])
        q=quantify(a,cfg,255);self.assertEqual(q['results'],[]);self.assertFalse(q['ready'])
