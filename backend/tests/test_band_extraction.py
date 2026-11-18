import copy
import unittest
import numpy as np
from backend.gel.engine import detect_grid, quantify, measure_areas
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
    def test_lane_rois_include_blank_samples_without_adding_a_spurious_gel_edge_row(self):
        a=gel();original=a.copy()
        cfg=setup(detect_grid(a,None,24,255,max_rois=96),{'sha256':'a'*64})
        self.assertEqual(len(cfg['rois']),48)
        self.assertEqual(cfg['rows'],2);self.assertEqual(cfg['maxRois'],96)
        ids=[r['id'] for r in cfg['rois']]
        self.assertEqual(ids,list(range(1,49)))
        self.assertEqual(cfg['detectionMode'],'lanes')
        measured=measure_areas(a,cfg,255)
        self.assertEqual(len(measured['results']),48)
        for index in (8,32):
            roi=cfg['rois'][index];result=measured['results'][index]
            self.assertEqual(roi['col'],8);self.assertEqual(result['status'],'undetected')
            self.assertTrue(np.isfinite(result['area']));self.assertEqual(len(result['profile']),cfg['roiHeight'])
        self.assertTrue(all(r['y']<450 for r in cfg['rois']))
        self.assertEqual(len(cfg['markers']),2)
        np.testing.assert_array_equal(a,original)
        forced=detect_grid(a,3,24,255,max_rois=48)
        self.assertEqual(forced['grid']['targetRows'],[160,380,540])
        self.assertEqual(len(forced['rois']),48);self.assertEqual(forced['rows'],2)

    def test_smaller_limit_keeps_first_lanes_in_order_including_blanks(self):
        a=gel();full=detect_grid(a,None,24,255,max_rois=96);limited=detect_grid(a,None,24,255,max_rois=10)
        self.assertEqual(len(limited['rois']),10)
        self.assertEqual([r['id'] for r in limited['rois']],list(range(1,11)))
        self.assertEqual(limited['rois'][8]['col'],8)
        identities={r['id']:(r['row'],r['col'],r['x'],r['y']) for r in full['rois']}
        for roi in limited['rois']:self.assertEqual(identities[roi['id']],(roi['row'],roi['col'],roi['x'],roi['y']))
        self.assertEqual(limited['laneCandidates'],48)

    def test_lane_cap_does_not_move_marker_to_a_sample(self):
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

    def test_weak_image_keeps_all_lanes_measurable_even_when_no_band_passes_detection(self):
        a=gel()*.01;cfg=setup(detect_grid(a,None,24,255,max_rois=48),{'sha256':'a'*64})
        self.assertEqual([r['id'] for r in cfg['rois']],list(range(1,49)))
        q=measure_areas(a,cfg,255);self.assertEqual(len(q['results']),48)
        self.assertTrue(all(m['status']=='undetected' for m in q['results']))
        self.assertTrue(all(np.isfinite(m['area']) for m in q['results']))
        self.assertTrue(any(m['area']>0 for m in q['results']))
        self.assertEqual(len(cfg['markers']),2)
