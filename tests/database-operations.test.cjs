const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/assets/database.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

// Execute the real operation functions with controlled storage/network timing.
// Rendering is excluded so these regressions need neither a browser nor a server.
function operationSource(name) {
  const declaration = new RegExp('^[ \\t]+(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(declaration, 'Database operation exists: ' + name);
  const remaining = source.slice(declaration.index + declaration[0].length);
  const next = /\n[ \t]+(?:async )?function \w+\(/.exec(remaining);
  assert.ok(next, 'Database operation has a following declaration: ' + name);
  return source.slice(declaration.index, declaration.index + declaration[0].length + next.index);
}

function harness(overrides = {}) {
  const messages = [];
  const context = vm.createContext({
    busy: false,
    currentFolder: 'project-a',
    clipboard: null,
    selected: new Set(),
    logs: [],
    serverOnline: true,
    folder: id => ['project-a', 'project-b', 'project-c'].includes(id) ? { id, kind: 'project', name: id } : null,
    keyFor: item => item.source + ':' + item.id,
    selectedLogs: () => context.logs.filter(item => context.selected.has(context.keyFor(item))),
    updateSelection() {},
    renderPath() {},
    message(text, error = false) { messages.push({ text, error }); },
    writeClipboard(data) { context.clipboard = data; },
    confirm: () => true,
    prompt: () => 'Imported plate',
    canonical: JSON.stringify,
    refresh: async () => {},
    storage: {},
    api: async () => { throw new Error('Unexpected API call'); },
    ...overrides,
  });
  const names = ['request', 'action', 'getEntry', 'updateEntry', 'transfer', 'deleteSelected', 'migrateSelected', 'validatePayload', 'importFile'];
  vm.runInContext(names.map(operationSource).join('\n') + '\nthis.operations = {transfer, deleteSelected, migrateSelected, importFile};', context, {
    filename: 'frontend/assets/database.js operations',
  });
  return { context, messages, ...context.operations };
}

test('mixed deletion failures refresh the list and continue deleting remaining selected records', async () => {
  const originals = [
    { id: 'local-ok', name: 'Local', source: 'local', project_id: 'project-a' },
    { id: 'db-fail', name: 'Failed DB', source: 'db', project_id: 'project-a' },
    { id: 'db-ok', name: 'Successful DB', source: 'db', project_id: 'project-a' },
  ];
  const retained = new Set(originals.map(item => item.id));
  const attempted = [];
  let refreshed = 0;
  const fixture = harness({
    logs: clone(originals),
    selected: new Set(originals.map(item => item.source + ':' + item.id)),
    storage: { async deleteLog(id) { attempted.push(id); retained.delete(id); } },
    async api(url, options) {
      assert.equal(options.method, 'DELETE');
      const id = url.split('/').at(-1);
      attempted.push(id);
      if (id === 'db-fail') throw new Error('Temporary DB failure');
      retained.delete(id);
      return { deleted: true };
    },
  });
  fixture.context.refresh = async () => {
    refreshed++;
    fixture.context.logs = originals.filter(item => retained.has(item.id));
  };
  await fixture.deleteSelected();
  assert.deepEqual(attempted, ['local-ok', 'db-fail', 'db-ok']);
  assert.equal(refreshed, 1);
  assert.deepEqual(fixture.context.logs.map(item => item.id), ['db-fail']);
  assert.equal(fixture.context.selected.size, 0);
  assert.match(fixture.messages.at(-1).text, /2件を削除.*1件は削除できていません/);
  assert.equal(fixture.messages.at(-1).error, true);
});

test('a stale tab moves records back to the requested project even when its cached destination already matches', async () => {
  const payload = { plates: [{ wells: ['A1'], growthWeeks: { A1: 5 } }], metadata: { keep: ['complete payload'] } };
  const originals = [
    { id: 'local', name: 'Local', source: 'local', project_id: 'project-a', payload: clone(payload) },
    { id: 'db', name: 'DB', source: 'db', project_id: 'project-a', payload: clone(payload) },
  ];
  // Another tab already moved the stored copies; this tab still displays project A.
  const actual = new Map(originals.map(item => [item.id, { ...clone(item), project_id: 'project-b' }]));
  const attempted = [];
  const keys = originals.map(item => item.source + ':' + item.id);
  const fixture = harness({
    logs: clone(originals),
    selected: new Set(keys),
    clipboard: { mode: 'cut', keys: [...keys] },
    storage: {
      async updateLog(id, patch) {
        attempted.push(id);
        actual.set(id, { ...actual.get(id), ...clone(patch) });
        return clone(actual.get(id));
      },
    },
    async api(url, options) {
      assert.equal(options.method, 'PATCH');
      const id = url.split('/').at(-1);
      attempted.push(id);
      actual.set(id, { ...actual.get(id), ...JSON.parse(options.body) });
      return clone(actual.get(id));
    },
  });
  fixture.context.refresh = async () => { fixture.context.logs = [...actual.values()].map(clone); };
  await fixture.transfer(keys, 'project-a', 'cut');
  assert.deepEqual(attempted, ['local', 'db']);
  for (const record of actual.values()) {
    assert.equal(record.project_id, 'project-a');
    assert.deepEqual(record.payload, payload);
  }
  assert.equal(fixture.context.clipboard.keys.length, 0);
  assert.match(fixture.messages.at(-1).text, /移動しました: 2件/);
  assert.equal(fixture.messages.at(-1).error, false);
});

test('an import keeps its original destination through file reading and both awaited saves', async () => {
  const payload = { plates: [{ label: 'Plate 1', wells: ['A1'], growthWeeks: { A1: 3 } }], arbitrary: { keep: true } };
  const localSaves = [];
  const dbSaves = [];
  let resolveText;
  const fixture = harness({
    storage: {
      async saveLog(name, data, projectId) {
        localSaves.push({ name, payload: clone(data), project_id: projectId });
        fixture.context.currentFolder = 'project-c';
        await Promise.resolve();
      },
    },
    async api(url, options) {
      if (url === '/api/logs') {
        assert.equal(options.method, 'POST');
        const record = { id: 'imported-db', ...JSON.parse(options.body) };
        dbSaves.push(record);
        return clone(record);
      }
      assert.equal(url, '/api/logs/imported-db');
      return clone(dbSaves[0]);
    },
  });
  const pending = fixture.importFile({
    name: 'plate.json',
    text: () => new Promise(resolve => { resolveText = resolve; }),
  });
  fixture.context.currentFolder = 'project-b';
  resolveText(JSON.stringify({ name: 'Original import', payload }));
  await pending;
  assert.equal(localSaves.length, 1);
  assert.equal(dbSaves.length, 1);
  assert.equal(localSaves[0].project_id, 'project-a');
  assert.equal(dbSaves[0].project_id, 'project-a');
  assert.deepEqual(localSaves[0].payload, payload);
  assert.deepEqual(dbSaves[0].payload, payload);
  assert.equal(fixture.context.currentFolder, 'project-c');
  assert.match(fixture.messages.at(-1).text, /DB・このブラウザ/);
  assert.equal(fixture.messages.at(-1).error, false);
});

test('DB migration removes only a browser copy whose project and complete payload were verified', async () => {
  const payload = { plates: [{ wells: ['A1'], growthWeeks: { A1: 3 } }], memo: 'retain all fields' };
  const originals = ['ok', 'mismatch'].map(id => ({ id, name: id, source: 'local', project_id: 'project-a', payload: clone(payload) }));
  const removed = [];
  let refreshed = 0;
  const fixture = harness({
    logs: originals,
    selected: new Set(originals.map(item => 'local:' + item.id)),
    storage: {
      async getLog(id) { return clone(originals.find(item => item.id === id)); },
      async deleteLog(id) { removed.push(id); },
    },
    async api(url, options) {
      if (options?.method === 'POST') {
        const body = JSON.parse(options.body);
        assert.equal(body.project_id, 'project-a');
        assert.deepEqual(body.payload, payload);
        return { id: 'db-' + body.name };
      }
      return { project_id: 'project-a', payload: url.endsWith('db-ok') ? clone(payload) : { plates: [] } };
    },
    async refresh() { refreshed++; },
  });
  await fixture.migrateSelected();
  assert.deepEqual(removed, ['ok']);
  assert.equal(refreshed, 1);
  assert.equal(fixture.messages.at(-1).error, true);
  assert.match(fixture.messages.at(-1).text, /1件.*1件は移行できていません/);
});
