/*
 * Run against an isolated local database:
 * BASE_URL=http://127.0.0.1:8765 node tests/database.e2e.cjs
 * Start the backend with PLATEPACK_DB_PATH pointing to a temporary file.
 * Folder fixtures remain in that temporary database; synthetic logs are removed.
 */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const base = process.env.BASE_URL || 'http://127.0.0.1:8765';
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname),
  'Database E2E must use a local server and a temporary database.');

const prefix = `Database E2E ${Date.now()} ${Math.random().toString(16).slice(2, 8)}`;
const payload = {
  version: 2,
  plates: [{ label: 'Plate 1', wells: ['A1', 'B2'], memo: 'Preserve this observation', growthWeeks: { A1: 2, B2: 5 } }],
  layoutDirection: 'row',
  inputReadDirection: 'row',
  wellLabelMode: 'colRow',
};

async function poll(description, read, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}. Last value: ${JSON.stringify(value)}`);
}

(async () => {
  let browser;
  let context;
  const createdLogIds = new Set();
  const errors = [];
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    });
    context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const answers = [];
    page.on('dialog', dialog => dialog.accept(answers.length ? answers.shift() : dialog.defaultValue())
      .catch(error => errors.push(error.message)));

    async function api(method, path, data) {
      const response = await context.request[method](`${base}${path}`, data === undefined ? {} : { data });
      const text = await response.text();
      assert(response.ok(), `${method.toUpperCase()} ${path}: HTTP ${response.status()} ${text}`);
      return text ? JSON.parse(text) : null;
    }
    const folders = () => api('get', '/api/folders');
    const serverLog = id => api('get', `/api/logs/${encodeURIComponent(id)}`);
    const serverLogs = projectId => api('get', `/api/logs?project_id=${encodeURIComponent(projectId)}&limit=1000`);
    const file = (source, id) => page.locator(`#fileList tbody .file-row[data-key="${source}:${id}"]`);
    const treeFolder = id => page.locator(`#folderTree button[data-folder-id="${id}"]`).first();
    const folderRow = id => page.locator(`#fileList tbody .folder-row[data-folder-id="${id}"]`);

    async function openFolder(id, parentId) {
      const target = treeFolder(id);
      if (!(await target.isVisible()) && parentId) await treeFolder(parentId).click();
      await target.click();
      await page.waitForFunction(folderId => {
        const path = [...document.querySelectorAll('#pathbar [data-folder-id]')];
        return path.at(-1)?.dataset.folderId === folderId;
      }, id);
    }
    async function revealAction(selector) {
      if (!(await page.locator(selector).isVisible())) await page.locator('.ui-menu > summary').click();
    }
    async function promptButton(selector, answer) {
      await revealAction(selector);
      answers.push(answer);
      await page.locator(selector).click();
      await poll(`prompt ${selector} was handled`, async () => answers.length, length => length === 0);
    }
    async function waitForFolder(name, kind, parentId) {
      const found = await poll(`folder ${name} exists`, folders,
        items => items.some(item => item.name === name && item.kind === kind && item.parent_id === parentId));
      return found.find(item => item.name === name && item.kind === kind && item.parent_id === parentId);
    }
    async function waitForServerProject(id, projectId) {
      return await poll(`log ${id} moved to ${projectId}`, () => serverLog(id), item => item.project_id === projectId);
    }
    async function waitForLocal(id, predicate) {
      return await poll(`local log ${id} changed`,
        () => page.evaluate(logId => window.PlatePackStorage.getLog(logId), id), predicate);
    }
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

    await page.goto(`${base}/results`);
    await treeFolder('default-project').waitFor();
    await page.locator('#fileList tbody').waitFor({ state: 'attached' });
    await openFolder('default-project', 'default-person');
    assert((await page.locator('#fileList thead th').count()) >= 4, 'Files must be presented in a table with metadata columns');

    const typography = await page.evaluate(async () => {
      await document.fonts.ready;
      const style = getComputedStyle(document.body);
      return { family: style.fontFamily, weight: Number(style.fontWeight), size: parseFloat(style.fontSize) };
    });
    assert([12,14,16,22,28].includes(typography.size), 'Use the shared five-step font-size scale');
    assert(!typography.family.includes('Oxanium') && /system|Segoe|Hiragino/.test(typography.family), 'Use familiar system fonts for Japanese and Latin text');

    // Create the first researcher and project through the actual prompt controls.
    await promptButton('#newPersonBtn', `${prefix} Person A`);
    const personA = await waitForFolder(`${prefix} Person A`, 'person', null);
    await openFolder(personA.id);
    await promptButton('#newProjectBtn', `${prefix} Project A`);
    const projectA = await waitForFolder(`${prefix} Project A`, 'project', personA.id);

    // A second researcher exercises destinations outside the current branch.
    const personB = await api('post', '/api/folders', { name: `${prefix} Person B`, kind: 'person', parent_id: null });
    const projectB = await api('post', '/api/folders', { name: `${prefix} Project B`, kind: 'project', parent_id: personB.id });
    const original = await api('post', '/api/logs', { name: `${prefix} Original`, payload, project_id: projectA.id });
    createdLogIds.add(original.id);
    await page.reload();
    await treeFolder(personA.id).waitFor();
    await openFolder(projectA.id, personA.id);
    await file('db', original.id).waitFor();

    // Rename changes metadata while preserving observations and original date.
    await file('db', original.id).click();
    const renamed = `${prefix} Renamed`;
    await promptButton('#renameBtn', renamed);
    const renamedLog = await poll('server log renamed', () => serverLog(original.id), item => item.name === renamed);
    assert.deepEqual(renamedLog.payload, payload);
    assert.equal(renamedLog.created_at, original.created_at);

    // Copy/paste uses native keyboard shortcuts and creates a distinct file.
    await file('db', original.id).click();
    await page.keyboard.press(`${modifier}+C`);
    const beforeCopy = new Set((await serverLogs(projectB.id)).map(item => item.id));
    await openFolder(projectB.id, personB.id);
    await page.keyboard.press(`${modifier}+V`);
    const copiedList = await poll('keyboard paste created a server copy', () => serverLogs(projectB.id),
      items => items.some(item => !beforeCopy.has(item.id)));
    const copy = copiedList.find(item => !beforeCopy.has(item.id));
    createdLogIds.add(copy.id);
    assert.notEqual(copy.id, original.id);
    assert.deepEqual((await serverLog(copy.id)).payload, payload);
    assert.equal((await serverLog(original.id)).project_id, projectA.id, 'Copy must retain the original file');

    // Cut/paste moves the same ID, without creating another log.
    await file('db', copy.id).waitFor();
    await file('db', copy.id).click();
    await page.keyboard.press(`${modifier}+X`);
    await openFolder(projectA.id, personA.id);
    await page.keyboard.press(`${modifier}+V`);
    const cutLog = await waitForServerProject(copy.id, projectA.id);
    assert.deepEqual(cutLog.payload, payload);
    assert.equal((await serverLogs(projectB.id)).some(item => item.id === copy.id), false);
    await file('db', copy.id).waitFor();

    // The explicit Move control and drag-and-drop use the same safe metadata move.
    await file('db', original.id).click();
    await revealAction('#moveProjectSelect');
    await page.locator('#moveProjectSelect').selectOption(projectB.id);
    await page.locator('#moveBtn').click();
    await waitForServerProject(original.id, projectB.id);
    await openFolder(projectB.id, personB.id);
    await file('db', original.id).waitFor();
    await file('db', original.id).dragTo(treeFolder(projectA.id));
    await waitForServerProject(original.id, projectA.id);
    assert.deepEqual((await serverLog(original.id)).payload, payload);

    // Folder rows, breadcrumbs, and renaming remain usable after a full reload.
    await openFolder(personB.id);
    await folderRow(projectB.id).click();
    const renamedProject = `${prefix} Project B renamed`;
    await promptButton('#renameBtn', renamedProject);
    await waitForFolder(renamedProject, 'project', personB.id);
    await folderRow(projectB.id).dblclick();
    await page.waitForFunction(id => [...document.querySelectorAll('#pathbar [data-folder-id]')].at(-1)?.dataset.folderId === id, projectB.id);
    await page.locator(`#pathbar [data-folder-id="${personB.id}"]`).click();
    await folderRow(projectB.id).waitFor();
    await page.reload();
    await treeFolder(projectB.id).waitFor();
    assert((await treeFolder(projectB.id).textContent()).includes(renamedProject));
    await openFolder(projectA.id, personA.id);
    await file('db', original.id).waitFor();
    assert.equal((await serverLog(original.id)).name, renamed);
    assert.deepEqual((await serverLog(original.id)).payload, payload);

    // Filtering must work without changing the stored file or selected project.
    await page.locator('#searchInput').fill(`${prefix} Renamed`);
    await file('db', original.id).waitFor();
    await page.locator('#searchInput').fill(`${prefix} does not exist`);
    await poll('search hides nonmatching files', () => page.locator('#fileList tbody .file-row').count(), count => count === 0);
    await page.locator('#searchInput').fill('');
    await file('db', original.id).waitFor();

    // Local-only files have the same rename, cut, and copy behavior.
    const local = await page.evaluate(({ name, snapshot, projectId }) =>
      window.PlatePackStorage.saveLog(name, snapshot, projectId),
    { name: `${prefix} Local`, snapshot: payload, projectId: projectA.id });
    await page.reload();
    await openFolder(projectA.id, personA.id);
    await file('local', local.id).waitFor();
    await file('local', local.id).click();
    await promptButton('#renameBtn', `${prefix} Local renamed`);
    await waitForLocal(local.id, item => item?.name === `${prefix} Local renamed`);
    await file('local', local.id).click();
    await revealAction('#cutBtn');
    await page.locator('#cutBtn').click();
    await openFolder(projectB.id, personB.id);
    await revealAction('#pasteBtn');
    await page.locator('#pasteBtn').click();
    await waitForLocal(local.id, item => item?.project_id === projectB.id);
    await file('local', local.id).waitFor();
    await file('local', local.id).click();
    await revealAction('#copyBtn');
    await page.locator('#copyBtn').click();
    const beforeLocalCopy = new Set((await page.evaluate(() => window.PlatePackStorage.readLogs())).map(item => item.id));
    await openFolder(projectA.id, personA.id);
    await revealAction('#pasteBtn');
    await page.locator('#pasteBtn').click();
    const localCopies = await poll('local paste created a distinct copy',
      () => page.evaluate(() => window.PlatePackStorage.readLogs()),
      items => items.some(item => !beforeLocalCopy.has(item.id) && item.project_id === projectA.id));
    const localCopy = localCopies.find(item => !beforeLocalCopy.has(item.id));
    assert.notEqual(localCopy.id, local.id);
    assert.deepEqual(localCopy.payload, payload);
    assert.deepEqual((await page.evaluate(id => window.PlatePackStorage.getLog(id), local.id)).payload, payload);

    // Wrapper JSON imports preserve growth weeks and use the active project.
    const importName = `${prefix} Imported`;
    await page.locator('#importInput').setInputFiles({
      name: 'database-backup.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ name: importName, payload })),
    });
    const importedList = await poll('import saved in the current server project', () => serverLogs(projectA.id),
      items => items.some(item => item.name === importName));
    const imported = importedList.find(item => item.name === importName);
    createdLogIds.add(imported.id);
    assert.deepEqual((await serverLog(imported.id)).payload, payload);
    await file('db', imported.id).waitFor();

    // Invalid JSON must not create either a server file or a browser file.
    const beforeInvalidLocal = await page.evaluate(() => window.PlatePackStorage.readLogs());
    const beforeInvalidServer = await serverLogs(projectA.id);
    await page.locator('#importInput').setInputFiles({
      name: 'invalid.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ name: `${prefix} Invalid`, payload: { plates: [{ wells: ['A1'], growthWeeks: { A1: 6 } }] } })),
    });
    await page.waitForFunction(() => /不正|形式|失敗|1[〜～~]5/.test(document.getElementById('notice')?.textContent || ''));
    assert.deepEqual(await page.evaluate(() => window.PlatePackStorage.readLogs()), beforeInvalidLocal);
    assert.deepEqual(await serverLogs(projectA.id), beforeInvalidServer);

    await page.reload();
    await openFolder(projectA.id, personA.id);
    await file('db', original.id).waitFor();
    await file('local', localCopy.id).waitFor();
    assert.deepEqual((await serverLog(original.id)).payload.plates[0].growthWeeks, { A1: 2, B2: 5 });
    await page.screenshot({ path: '/tmp/platepack-database-e2e.png', fullPage: true });

    // Opening a project file in Packer restores its save destination. A later
    // selector change cannot redirect a save that has already started.
    await file('db', original.id).getByRole('button', { name: '開く', exact: true }).click();
    await page.waitForFunction(({ source, target }) => {
      const select = document.getElementById('saveProjectSelect');
      return !document.getElementById('view-plates')?.inert && select?.value === source &&
        [...select.options].some(option => option.value === target);
    }, { source: projectA.id, target: projectB.id });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('#saveProjectSelect').selectOption(projectB.id);
    const saveName = `${prefix} Packer saved to B`;
    let releasePost;
    const heldPost = new Promise(resolve => { releasePost = resolve; });
    const gate = async route => {
      const request = route.request();
      if (request.method() === 'POST' && request.postDataJSON()?.name === saveName) await heldPost;
      await route.continue();
    };
    await page.route('**/api/logs', gate);
    try {
      const started = page.waitForRequest(request => request.url() === `${base}/api/logs` &&
        request.method() === 'POST' && request.postDataJSON()?.name === saveName);
      answers.push(saveName);
      await page.locator('#saveLogBtn').click();
      const pendingRequest = await started;
      assert.equal(pendingRequest.postDataJSON().project_id, projectB.id);
      await page.locator('#saveProjectSelect').selectOption(projectA.id);
      releasePost();
      const savedList = await poll('Packer save retained project B', () => serverLogs(projectB.id),
        items => items.some(item => item.name === saveName));
      const savedLog = savedList.find(item => item.name === saveName);
      createdLogIds.add(savedLog.id);
      const savedEntry = await serverLog(savedLog.id);
      assert.equal(savedEntry.project_id, projectB.id);
      assert.deepEqual(savedEntry.payload.plates[0].growthWeeks, payload.plates[0].growthWeeks);
      assert.equal(savedEntry.payload.plates[0].memo, payload.plates[0].memo);
      await page.waitForFunction(() => document.getElementById('status')?.textContent.includes('DB・このブラウザ'));
      const localSaved = (await page.evaluate(() => window.PlatePackStorage.readLogs())).find(item => item.name === saveName);
      assert(localSaved, 'Packer Save Log must also create a verified browser copy');
      assert.equal(localSaved.project_id, projectB.id);
      assert.deepEqual(localSaved.payload.plates[0].growthWeeks, payload.plates[0].growthWeeks);
      assert.equal(await page.locator('#saveProjectSelect').inputValue(), projectA.id);
    } finally {
      releasePost();
      await page.unroute('**/api/logs', gate);
    }

    assert.deepEqual(errors, [], `Database JavaScript errors: ${errors.join('\n')}`);
    console.log('Database E2E: table navigation, researcher/project creation, rename, keyboard copy/cut/paste, Move, drag-and-drop, local files, JSON validation, reload, system fonts, and Packer save destination under a pending request passed.');
  } finally {
    try {
      if (context) {
        for (const id of createdLogIds) {
          try {
            const response = await context.request.delete(`${base}/api/logs/${encodeURIComponent(id)}`);
            if (!response.ok()) console.error(`Fixture cleanup: HTTP ${response.status()} for ${id}`);
          } catch (error) { console.error(`Fixture cleanup failed: ${error.message}`); }
        }
        await context.close();
      }
    } finally {
      await browser?.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
