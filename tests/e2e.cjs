/* Run with a local server: BASE_URL=http://127.0.0.1:8000 node tests/e2e.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');
let runningBrowser;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  runningBrowser = browser;
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = process.env.BASE_URL || 'http://127.0.0.1:8000';
  const ready = () => page.waitForFunction(() => document.getElementById('view-plates').inert === false);
  const well = id => page.locator(`.well-btn[data-well="${id}"]`);
  const week = number => page.locator(`.week-btn[data-week="${number}"]`);
  const saved = () => page.waitForFunction(() => document.getElementById('draftSaveStatus').dataset.state === 'saved');
  await page.goto(`${base}/plates`); await ready();
  assert.equal(await page.locator('.week-btn').count(), 5);
  const toolbar = await page.locator('.week-toolbar').boundingBox();
  const controls = await page.locator('.input-controls-row').boundingBox();
  const grid = await page.locator('.input-grid').boundingBox();
  assert(toolbar.y >= controls.y + controls.height && toolbar.y + toolbar.height <= grid.y);

  for (let number = 1; number <= 5; number++) {
    await week(number).click(); await well(`A${number}`).click();
    assert.equal(await well(`A${number}`).locator('.well-week').textContent(), String(number));
  }
  await week(2).click(); await well('A1').click();
  assert.equal(await well('A1').locator('.well-week').textContent(), '2');
  await well('A1').click(); assert.equal(await well('A1').locator('.well-week').count(), 0);
  await week(1).click(); await well('A1').click();
  await page.locator('#plateMemo').fill('growth observation');
  await page.locator('#plateCount').selectOption('2');
  await page.locator('#nextPlateBtn').click(); await week(5).click(); await well('B2').click();
  await page.locator('#packLayoutBtn').click(); await page.waitForSelector('.cell-week');
  assert.deepEqual(await page.locator('.cell-week').allTextContents(), ['1', '2', '3', '4', '5', '5']);
  await saved();
  // The packed plate and week metadata survive a full reload.
  await page.reload(); await ready();
  assert.equal(await well('B2').locator('.well-week').textContent(), '5');
  assert.deepEqual(await page.locator('.cell-week').allTextContents(), ['1', '2', '3', '4', '5', '5']);
  await page.locator('#prevPlateBtn').click();
  assert.equal(await page.locator('#plateMemo').inputValue(), 'growth observation');

  // Export exact data and a rendered image.
  let downloadEvent = page.waitForEvent('download'); await page.locator('#tsvBtn').click();
  let download = await downloadEvent;
  const tsv = await fs.readFile(await download.path(), 'utf8');
  assert(tsv.startsWith('well_position\tDEST-001\tDEST-001_growth_week'));
  assert(tsv.includes('A5\t1-5A\t5'));
  downloadEvent = page.waitForEvent('download'); await page.locator('#pngBtn').click();
  download = await downloadEvent;
  assert((await fs.readFile(await download.path())).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

  // Save Log creates a JSON backup and verifies server data by reading it back.
  page.once('dialog', dialog => dialog.accept('E2E growth log'));
  downloadEvent = page.waitForEvent('download'); await page.locator('#saveLogBtn').click();
  download = await downloadEvent;
  const backup = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(backup.payload.version, 2);
  assert.equal(backup.payload.plates[0].growthWeeks.A5, 5);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('DB・このブラウザ'));
  await page.goto(`${base}/results`);
  await page.waitForFunction(() => document.querySelectorAll('.item').length >= 2);
  const localLog = page.locator('.item').filter({ has: page.locator('.badge', { hasText: 'LOCAL' }) }).filter({ hasText: 'E2E growth log' }).first();
  await localLog.locator('summary').click(); await localLog.getByRole('link', { name: 'Packerで開く' }).click(); await ready();
  assert.equal(await well('A5').locator('.well-week').textContent(), '5');

  // Legacy version-1 data remains readable without inventing a growth week.
  await page.evaluate(() => applyLogSnapshot({ version: 1, plates: [{ label: 'Legacy', wells: ['H12'], memo: 'old' }] }));
  assert.equal(await well('H12').getAttribute('aria-pressed'), 'true');
  assert.equal(await well('H12').locator('.well-week').count(), 0);
  assert.equal(await page.locator('.cell-week').count(), 0);
  // Invalid import is rejected before replacing the active workspace.
  await page.evaluate(() => {
    const before = JSON.stringify(buildLogSnapshot());
    try { applyLogSnapshot({ plates: [{ wells: ['A1'], growthWeeks: { A1: 6 } }] }); } catch {}
    if (JSON.stringify(buildLogSnapshot()) !== before) throw new Error('Invalid snapshot overwrote data');
    const invalid = { plates: [{ wells: ['A1'] }], packedLayout: { layoutDirection: 'row', verticalDividers: 'bad', horizontalDividers: [] } };
    try { applyLogSnapshot(invalid); } catch {}
    if (JSON.stringify(buildLogSnapshot()) !== before) throw new Error('Invalid packed layout overwrote data');
    for (const badField of ['columns', 'color']) {
      const bad = { plates: [{ wells: ['A1'] }], packedPlates: [{ grid: Array.from({ length: 8 }, () => Array(12).fill(null)), columns: Array.from({ length: 12 }, (_, i) => i + 1) }] };
      if (badField === 'columns') bad.packedPlates[0].columns = 'bad';
      else bad.packedPlates[0].grid[0][0] = { sourceWell: 'A1', sourcePlate: '1', color: 3 };
      try { applyLogSnapshot(bad); } catch {}
      if (JSON.stringify(buildLogSnapshot()) !== before) throw new Error('Invalid packed field overwrote data');
    }
  });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#restoreJsonInput').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('復元しました'));
  assert.equal(await well('A5').locator('.well-week').textContent(), '5');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#clearPlateBtn').click();
  assert.equal(await well('A5').getAttribute('aria-pressed'), 'true');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#plateCount').selectOption('1');
  assert.equal(await page.locator('#plateCount').inputValue(), '2');
  // Layout edits while the API is pending cannot change the already captured packing layout.
  let releaseRequest;
  let announceRequest;
  const requestStarted = new Promise(resolve => { announceRequest = resolve; });
  await page.route('**/generate-html', async route => {
    announceRequest();
    await new Promise(resolve => { releaseRequest = resolve; });
    await route.continue();
  });
  await page.locator('#packLayoutBtn').click();
  await requestStarted;
  await page.locator('#directionBtn').click();
  releaseRequest();
  await page.waitForFunction(() => !document.getElementById('packLayoutBtn').disabled);
  assert.equal(await page.evaluate(() => packedLayout.layoutDirection), 'row');
  await page.unroute('**/generate-html');
  await page.screenshot({ path: '/tmp/platepack-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.week-btn:visible').count(), 5);
  const fifthWeek = await week(5).boundingBox();
  assert(fifthWeek.x >= 0 && fifthWeek.x + fifthWeek.width <= 390, 'All week buttons must fit a narrow screen');
  await page.screenshot({ path: '/tmp/platepack-mobile.png', fullPage: true });

  // No successful-save message when every browser store fails; file backup still works.
  const blockedContext = await browser.newContext({ acceptDownloads: true });
  await blockedContext.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
    Object.defineProperty(window, 'indexedDB', { value: { open() { throw new Error('blocked'); } } });
  });
  const blocked = await blockedContext.newPage();
  blocked.on('pageerror', error => errors.push(error.message));
  await blocked.goto(`${base}/plates`);
  await blocked.waitForFunction(() => !document.getElementById('view-plates').inert);
  await blocked.locator('.well-btn[data-well="A1"]').click();
  await blocked.waitForFunction(() => document.getElementById('draftSaveStatus').dataset.state === 'error');
  const fallbackDownload = blocked.waitForEvent('download');
  await blocked.locator('#backupJsonBtn').click();
  const fallback = JSON.parse(await fs.readFile(await (await fallbackDownload).path(), 'utf8'));
  assert.equal(fallback.payload.plates[0].growthWeeks.A1, 1);
  await blockedContext.close();

  assert.equal(errors.length, 0, errors.join('\n'));
  await browser.close();
  console.log('E2E: week input/reassignment, packing, reload, TSV, PNG, verified Save Log, JSON and legacy compatibility passed.');
})().catch(async error => { console.error(error); await runningBrowser?.close(); process.exitCode = 1; });
