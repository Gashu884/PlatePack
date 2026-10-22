const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "../frontend/storage.js"), "utf8");
const LOGS = "PLATEPACK_LOGS_V2";
const LEGACY = "PLATEPACK_LOCAL_LOGS_V1";
const FOLDERS = "PLATEPACK_FOLDERS_V1";
const DRAFT = "PLATEPACK_DRAFT_V2";
const PREVIOUS = "PLATEPACK_DRAFT_PREVIOUS_V2";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const entry = id => ({ id, name: `Log ${id}`, created_at: "2026-10-09T00:00:00Z", payload: { id, plates: [] } });
const draft = (savedAt, label) => ({ savedAt, snapshot: { plates: [{ label, wells: ["A1"], growthWeeks: { A1: 3 } }] } });
const migrated = items => items.map(item => ({ ...item, project_id: item.project_id || "default-project" }));
const person = (id, name = id) => ({ id, name, kind: "person", parent_id: null, created_at: "2026-10-09T00:00:00Z" });
const project = (id, parent_id, name = id) => ({ id, name, kind: "project", parent_id, created_at: "2026-10-09T00:00:00Z" });

function createSharedLocks() {
  const queues = new Map();
  return {
    request(name, options, operation) {
      const callback = typeof options === "function" ? options : operation;
      const pending = (queues.get(name) || Promise.resolve()).catch(() => {}).then(() => callback({ name }));
      queues.set(name, pending);
      return pending;
    },
  };
}

function createStorage({ localData = {}, databaseData = {}, localFailures = [], databaseFailures = [], databaseAvailable = true, now = 1000, sharedLocal, sharedDatabase, locks, uuidPrefix = "new" } = {}) {
  const local = sharedLocal || new Map(Object.entries(localData).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
  const database = sharedDatabase || new Map(Object.entries(databaseData).map(([key, value]) => [key, clone(value)]));
  const localFail = new Set(localFailures);
  const databaseFail = new Set(databaseFailures);
  let uuid = 0;
  class FixedDate extends Date {
    static now() { return now; }
  }
  const db = {
    transaction(_store, mode) {
      const transaction = {
        objectStore() {
          return {
            get(key) {
              const request = {};
              queueMicrotask(() => {
                request.result = clone(database.get(key));
                request.onsuccess?.();
              });
              return request;
            },
            put(value, key) {
              assert.equal(mode, "readwrite");
              const copied = clone(value);
              queueMicrotask(() => {
                if (databaseFail.has("*") || databaseFail.has(key)) {
                  transaction.onabort?.();
                } else {
                  database.set(key, copied);
                  transaction.oncomplete?.();
                }
              });
            },
          };
        },
      };
      return transaction;
    },
    createObjectStore() {},
  };
  const context = vm.createContext({
    window: {},
    localStorage: {
      getItem(key) { return local.has(key) ? local.get(key) : null; },
      setItem(key, value) {
        if (localFail.has("*") || localFail.has(key)) throw new Error("QuotaExceededError");
        local.set(key, String(value));
      },
    },
    indexedDB: {
      open() {
        const request = {};
        queueMicrotask(() => {
          if (!databaseAvailable) request.onerror?.();
          else { request.result = db; request.onsuccess?.(); }
        });
        return request;
      },
    },
    crypto: { randomUUID: () => `${uuidPrefix}-${++uuid}` },
    navigator: { storage: { persist: async () => true }, locks },
    Date: FixedDate,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error("Unexpected network call"); },
  });
  vm.runInContext(SOURCE, context, { filename: "frontend/storage.js" });
  return { storage: context.window.PlatePackStorage, local, database };
}

test("a log survives local quota failure when IndexedDB succeeds", async () => {
  const { storage, database } = createStorage({ localFailures: ["*"] });
  const saved = await storage.saveLog("Week 3", { plates: [{ label: "Plate 1", growthWeeks: { A1: 3 } }] });
  assert.equal(database.get(LOGS).items[0].id, saved.id);
  assert.deepEqual(clone(await storage.getLog(saved.id)), clone(saved));
});

test("a log survives unavailable IndexedDB when local storage succeeds", async () => {
  const { storage, local } = createStorage({ databaseAvailable: false });
  const saved = await storage.saveLog("Week 5", { growthWeeks: { H12: 5 } });
  assert.equal(JSON.parse(local.get(LOGS)).items[0].id, saved.id);
  assert.equal((await storage.readLogs())[0].payload.growthWeeks.H12, 5);
});

test("failure of both stores rejects and preserves original logs", async () => {
  const original = { savedAt: 50, items: [entry("old")] };
  const { storage, local, database } = createStorage({ localData: { [LOGS]: original }, databaseData: { [LOGS]: original }, localFailures: ["*"], databaseFailures: ["*"] });
  await assert.rejects(storage.saveLog("New", { growthWeeks: { A1: 1 } }), /保存できません/);
  assert.deepEqual(JSON.parse(local.get(LOGS)), original);
  assert.deepEqual(database.get(LOGS), original);
});

test("legacy logs migrate without truncating old entries or their payloads", async () => {
  const originals = Array.from({ length: 75 }, (_, index) => entry(`legacy-${index}`));
  const { storage, local } = createStorage({ localData: { [LEGACY]: originals } });
  await storage.saveLog("New", { growthWeeks: { A1: 4 } });
  const logs = clone(await storage.readLogs());
  assert.equal(logs.length, 76);
  assert.deepEqual(logs.slice(1), migrated(originals));
  assert.equal(JSON.parse(local.get(LEGACY)).length, 76);
});

test("concurrent saves preserve both new logs", async () => {
  const { storage } = createStorage();
  const saved = await Promise.all([storage.saveLog("First", { value: 1 }), storage.saveLog("Second", { value: 2 })]);
  const logs = await storage.readLogs();
  assert.equal(logs.length, 2);
  assert.deepEqual(new Set(logs.map(log => log.id)), new Set(saved.map(log => log.id)));
});

test("simultaneous saves in two tabs preserve both logs using a shared browser lock", async () => {
  const local = new Map();
  const database = new Map();
  const locks = createSharedLocks();
  const first = createStorage({ sharedLocal: local, sharedDatabase: database, locks, uuidPrefix: "tab1" }).storage;
  const second = createStorage({ sharedLocal: local, sharedDatabase: database, locks, uuidPrefix: "tab2" }).storage;
  const saved = await Promise.all([first.saveLog("First tab", { value: 1 }), second.saveLog("Second tab", { value: 2 })]);
  const logs = await first.readLogs();
  assert.equal(logs.length, 2);
  assert.deepEqual(new Set(logs.map(log => log.id)), new Set(saved.map(log => log.id)));
});

test("corrupt local logs recover from the valid IndexedDB copy", async () => {
  const originals = [entry("good")];
  const { storage } = createStorage({ localData: { [LOGS]: "{broken" }, databaseData: { [LOGS]: { savedAt: 20, items: originals } } });
  assert.deepEqual(clone(await storage.readLogs()), migrated(originals));
});

test("corrupt existing logs block replacement when no valid copy is available", async () => {
  const badDatabase = { savedAt: 20, items: "damaged data" };
  const { storage, local, database } = createStorage({ localData: { [LOGS]: "{recoverable raw text" }, databaseData: { [LOGS]: badDatabase } });
  await assert.rejects(storage.readLogs(), /読み込めません|破損/);
  await assert.rejects(storage.saveLog("New", {}), /読み込めません|破損/);
  assert.equal(local.get(LOGS), "{recoverable raw text");
  assert.deepEqual(database.get(LOGS), badDatabase);
});

test("corrupt legacy logs block replacement and remain unchanged", async () => {
  const { storage, local } = createStorage({ localData: { [LEGACY]: { recoverable: "legacy data" } }, databaseAvailable: false });
  await assert.rejects(storage.saveLog("New", {}), /読み込めません/);
  assert.deepEqual(JSON.parse(local.get(LEGACY)), { recoverable: "legacy data" });
  assert.equal(local.has(LOGS), false);
});

test("logs unique to either replica are retained when timestamps match", async () => {
  const { storage } = createStorage({
    localData: { [LOGS]: { savedAt: 200, items: [entry("local"), entry("shared")] } },
    databaseData: { [LOGS]: { savedAt: 200, items: [entry("database"), entry("shared")] } },
  });
  const logs = await storage.readLogs();
  assert.deepEqual(new Set(logs.map(log => log.id)), new Set(["local", "database", "shared"]));
  assert.equal(logs.length, 3);
});

test("a newer replica does not hide unique logs from an older replica", async () => {
  const { storage } = createStorage({
    localData: { [LOGS]: { savedAt: 300, items: [entry("latest")] } },
    databaseData: { [LOGS]: { savedAt: 200, items: [entry("older")] } },
  });
  await storage.saveLog("New", {});
  assert.deepEqual(new Set((await storage.readLogs()).map(log => log.id)), new Set(["new-1", "latest", "older"]));
});

test("an intentional deletion is not resurrected by a stale replica", async () => {
  const original = { savedAt: 200, items: [entry("remove"), entry("retain")] };
  const { storage, database } = createStorage({ localData: { [LOGS]: original }, databaseData: { [LOGS]: original }, databaseFailures: [LOGS] });
  await storage.writeLogs([entry("retain")]);
  assert.deepEqual(database.get(LOGS), original);
  assert.deepEqual((await storage.readLogs()).map(log => log.id).join(","), "retain");
});

test("deleting in one tab while another saves preserves the unrelated new log", async () => {
  const original = { savedAt: 200, items: [entry("remove"), entry("retain")] };
  const local = new Map([[LOGS, JSON.stringify(original)]]);
  const database = new Map([[LOGS, clone(original)]]);
  const locks = createSharedLocks();
  const first = createStorage({ sharedLocal: local, sharedDatabase: database, locks, uuidPrefix: "tab1" }).storage;
  const second = createStorage({ sharedLocal: local, sharedDatabase: database, locks, uuidPrefix: "tab2" }).storage;
  const [, saved] = await Promise.all([first.deleteLog("remove"), second.saveLog("Keep new log", { growthWeeks: { B2: 4 } })]);
  const logs = await first.readLogs();
  assert.deepEqual(new Set(logs.map(log => log.id)), new Set(["retain", saved.id]));
});

test("a rejected storage write does not block later successful saves", async () => {
  const { storage, local } = createStorage({ localData: { [LOGS]: "{corrupt" }, databaseAvailable: false });
  await assert.rejects(storage.saveLog("Rejected", {}));
  local.delete(LOGS);
  const saved = await storage.saveLog("Recovered", { growthWeeks: { A1: 5 } });
  assert.equal((await storage.getLog(saved.id)).name, "Recovered");
});

test("a draft update preserves the preceding valid draft in both stores", async () => {
  const old = draft(100, "Original");
  const updated = draft(200, "Updated");
  const { storage, local, database } = createStorage({ localData: { [DRAFT]: old }, databaseData: { [DRAFT]: old } });
  const result = await storage.writeDraft(updated);
  assert.equal(result.localOk, true);
  assert.equal(result.databaseOk, true);
  assert.deepEqual(JSON.parse(local.get(PREVIOUS)), old);
  assert.deepEqual(database.get(PREVIOUS), old);
  assert.deepEqual(clone(await storage.readDraft()), updated);
});

test("a corrupt current draft recovers the preceding valid draft", async () => {
  const old = draft(100, "Original");
  const { storage } = createStorage({ localData: { [DRAFT]: "{broken", [PREVIOUS]: old }, databaseAvailable: false });
  assert.deepEqual(clone(await storage.readDraft()), old);
});

test("fully corrupt draft copies are reported and never silently treated as empty", async () => {
  const corrupt = { savedAt: 200, snapshot: { plates: "recoverable broken data" } };
  const { storage, local, database } = createStorage({ localData: { [DRAFT]: "{broken draft" }, databaseData: { [DRAFT]: corrupt } });
  await assert.rejects(storage.readDraft(), /復元できません/);
  assert.equal(local.get(DRAFT), "{broken draft");
  assert.deepEqual(database.get(DRAFT), corrupt);
});

test("local backup quota failure does not prevent replacing the current draft", async () => {
  const old = draft(100, "Original");
  const updated = draft(200, "Updated");
  const { storage, local } = createStorage({ localData: { [DRAFT]: old }, localFailures: [PREVIOUS], databaseAvailable: false });
  const result = await storage.writeDraft(updated);
  assert.equal(result.localOk, true);
  assert.deepEqual(JSON.parse(local.get(DRAFT)), updated);
});

test("IndexedDB backup failure does not prevent saving the current draft", async () => {
  const old = draft(100, "Original");
  const updated = draft(200, "Updated");
  const { storage, database } = createStorage({ databaseData: { [DRAFT]: old }, localFailures: ["*"], databaseFailures: [PREVIOUS] });
  const result = await storage.writeDraft(updated);
  assert.equal(result.databaseOk, true);
  assert.deepEqual(database.get(DRAFT), updated);
});

test("failure of both draft stores rejects and retains the previous valid draft", async () => {
  const old = draft(100, "Original");
  const { storage, local, database } = createStorage({ localData: { [DRAFT]: old }, databaseData: { [DRAFT]: old }, localFailures: ["*"], databaseFailures: ["*"] });
  await assert.rejects(storage.writeDraft(draft(200, "Updated")), /自動保存できません/);
  assert.deepEqual(JSON.parse(local.get(DRAFT)), old);
  assert.deepEqual(database.get(DRAFT), old);
});

test("legacy reads assign a default project idempotently without rewriting original data", async () => {
  const originals = [entry("old")];
  const { storage, local, database } = createStorage({ localData: { [LEGACY]: originals } });
  const raw = local.get(LEGACY);
  assert.deepEqual(clone(await storage.readLogs()), migrated(originals));
  assert.deepEqual(clone(await storage.readLogs()), migrated(originals));
  assert.equal((await storage.getLog("old")).project_id, "default-project");
  assert.equal(local.get(LEGACY), raw);
  assert.equal(local.has(LOGS), false);
  assert.equal(database.has(LOGS), false);
});

test("default researcher and project folders appear once on an empty browser", async () => {
  const { storage } = createStorage();
  const first = clone(await storage.readFolders());
  assert.deepEqual(first.map(folder => [folder.id, folder.name, folder.kind, folder.parent_id]), [
    ["default-person", "メンバー 1", "person", null],
    ["default-project", "プロジェクト 1", "project", "default-person"],
  ]);
  assert.deepEqual(clone(await storage.readFolders()), first);
});

test("folder creation, renaming, and project moves retain valid hierarchy", async () => {
  const { storage } = createStorage();
  const first = await storage.createFolder(" Alice ", "person");
  const second = await storage.createFolder("Bob", "person");
  const folder = await storage.createFolder("Experiment", "project", first.id);
  const changed = await storage.updateFolder(folder.id, { name: "Experiment 2", parent_id: second.id });
  assert.equal(changed.name, "Experiment 2");
  assert.equal(changed.parent_id, second.id);
  assert.equal(changed.created_at, folder.created_at);
  assert.ok(Date.parse(changed.updated_at) > Date.parse(folder.created_at));
  assert.equal((await storage.readFolders()).length, 5);
});

test("invalid folder destinations are rejected without changing saved folders", async () => {
  const { storage, local, database } = createStorage();
  const valid = await storage.createFolder("Experiment", "project", "default-person");
  const originalLocal = local.get(FOLDERS);
  const originalDatabase = clone(database.get(FOLDERS));
  await assert.rejects(storage.createFolder("Nested", "project", valid.id), /研究者フォルダ/);
  await assert.rejects(storage.createFolder("Bad root", "person", "default-person"), /形式が不正/);
  await assert.rejects(storage.updateFolder("default-person", { parent_id: valid.id }), /形式が不正/);
  await assert.rejects(storage.updateFolder(valid.id, { parent_id: "missing" }), /研究者フォルダ/);
  await assert.rejects(storage.updateFolder(valid.id, { kind: "person" }), /変更できない/);
  await assert.rejects(storage.createFolder("x".repeat(121), "person"), /1〜120文字/);
  await assert.rejects(storage.createFolder("Bad ID", "person", null, "id/unsupported"), /形式が不正/);
  assert.equal(local.get(FOLDERS), originalLocal);
  assert.deepEqual(database.get(FOLDERS), originalDatabase);
});

test("caller-provided folder IDs make repeated offline creation idempotent", async () => {
  const { storage } = createStorage();
  const first = await storage.createFolder("Researcher", "person", null, "stable-id");
  assert.deepEqual(clone(await storage.createFolder("Researcher", "person", null, "stable-id")), clone(first));
  assert.equal((await storage.readFolders()).filter(folder => folder.id === "stable-id").length, 1);
  await assert.rejects(storage.createFolder("Other researcher", "person", null, "stable-id"), /同じID/);
});

test("remote folders merge into the offline tree and become valid local log destinations", async () => {
  const { storage } = createStorage();
  const offline = await storage.createFolder("Offline researcher", "person", null, "offline");
  const incoming = [person("remote"), project("remote-project", "remote")];
  await storage.mergeFolders(incoming);
  const folders = await storage.readFolders();
  assert.ok(folders.some(folder => folder.id === offline.id));
  const saved = await storage.saveLog("Remote project log", { plates: [] }, "remote-project");
  assert.equal(saved.project_id, "remote-project");
  await assert.rejects(storage.saveLog("Bad target", {}, "remote"), /プロジェクトが見つかりません/);
});

test("remote folder merge preserves newer edits while accepting unstamped API responses", async () => {
  const { storage } = createStorage();
  await storage.mergeFolders([person("remote")]);
  const updated = await storage.updateFolder("remote", { name: "Newest local" });
  await storage.mergeFolders([{ ...person("remote", "Stale server"), updated_at: "2026-10-08T00:00:00Z" }]);
  assert.equal((await storage.readFolders()).find(folder => folder.id === "remote").name, updated.name);
  await storage.mergeFolders([person("remote", "Confirmed API response")]);
  assert.equal((await storage.readFolders()).find(folder => folder.id === "remote").name, "Confirmed API response");
});

test("simultaneous folder creations in separate tabs preserve the shared tree", async () => {
  const local = new Map();
  const database = new Map();
  const locks = createSharedLocks();
  const first = createStorage({ sharedLocal: local, sharedDatabase: database, locks, uuidPrefix: "tab1" }).storage;
  const second = createStorage({ sharedLocal: local, sharedDatabase: database, locks, uuidPrefix: "tab2" }).storage;
  const created = await Promise.all([first.createFolder("Alice", "person"), second.createFolder("Bob", "person")]);
  assert.deepEqual(new Set((await first.readFolders()).map(folder => folder.id)), new Set(["default-person", "default-project", ...created.map(folder => folder.id)]));
});

test("moving and renaming a log preserve the complete payload and original creation time", async () => {
  const { storage } = createStorage();
  const folder = await storage.createFolder("Experiment", "project", "default-person");
  const payload = { plates: [{ label: "Plate", wells: ["A1"], growthWeeks: { A1: 5 } }], packedPlates: [{ cells: ["A1"] }], notes: "Keep me", extra: { arbitrary: [1, 2, 3] } };
  const saved = await storage.saveLog("Original", payload);
  payload.notes = "Changed after save";
  const moved = await storage.updateLog(saved.id, { name: "Moved", project_id: folder.id });
  assert.equal(moved.id, saved.id);
  assert.equal(moved.created_at, saved.created_at);
  assert.equal(moved.project_id, folder.id);
  assert.deepEqual(clone(moved.payload), clone(saved.payload));
  assert.equal(moved.payload.notes, "Keep me");
  assert.ok(Date.parse(moved.updated_at) > Date.parse(saved.created_at));
  moved.payload.notes = "Changed returned value";
  assert.equal((await storage.getLog(saved.id)).payload.notes, "Keep me");
});

test("copying a log preserves its original and deep copies all payload fields", async () => {
  const { storage } = createStorage();
  const folder = await storage.createFolder("Experiment", "project", "default-person");
  const saved = await storage.saveLog("Original", { plates: [{ growthWeeks: { A1: 4 } }], metadata: { nested: ["value"] } });
  const copied = await storage.copyLog(saved.id, folder.id);
  assert.notEqual(copied.id, saved.id);
  assert.equal(copied.project_id, folder.id);
  assert.deepEqual(clone(copied.payload), clone(saved.payload));
  assert.deepEqual(clone(await storage.getLog(saved.id)), clone(saved));
  copied.payload.metadata.nested.push("changed");
  assert.deepEqual(clone((await storage.getLog(copied.id)).payload.metadata.nested), ["value"]);
  assert.equal((await storage.readLogs()).length, 2);
});

test("log replicas choose the newest entry edit even when an older edit has a newer envelope", async () => {
  const old = { ...entry("same"), name: "Old", project_id: "default-project", updated_at: "2026-10-09T01:00:00Z" };
  const updated = { ...old, name: "Moved", project_id: "other-project", updated_at: "2026-10-09T02:00:00Z" };
  const { storage } = createStorage({ localData: { [LOGS]: { savedAt: 300, items: [old] } }, databaseData: { [LOGS]: { savedAt: 200, items: [updated] } } });
  assert.deepEqual(clone(await storage.getLog("same")), updated);
});

test("a failed move or copy leaves both original log replicas untouched", async () => {
  const old = { ...entry("original"), project_id: "default-project" };
  const record = { savedAt: 300, items: [old] };
  const { storage, local, database } = createStorage({ localData: { [LOGS]: record }, databaseData: { [LOGS]: record }, localFailures: [LOGS], databaseFailures: [LOGS] });
  await assert.rejects(storage.updateLog(old.id, { name: "Changed" }), /保存できません/);
  await assert.rejects(storage.copyLog(old.id, "default-project"), /保存できません/);
  assert.deepEqual(JSON.parse(local.get(LOGS)), record);
  assert.deepEqual(database.get(LOGS), record);
});

test("folder saves survive either store failure and reject when neither verifies", async () => {
  const localBlocked = createStorage({ localFailures: [FOLDERS] });
  const idbFolder = await localBlocked.storage.createFolder("IDB researcher", "person");
  assert.ok(localBlocked.database.get(FOLDERS).items.some(folder => folder.id === idbFolder.id));
  const databaseBlocked = createStorage({ databaseFailures: [FOLDERS] });
  const localFolder = await databaseBlocked.storage.createFolder("Local researcher", "person");
  assert.ok(JSON.parse(databaseBlocked.local.get(FOLDERS)).items.some(folder => folder.id === localFolder.id));
  const blocked = createStorage({ localFailures: [FOLDERS], databaseFailures: [FOLDERS] });
  await assert.rejects(blocked.storage.createFolder("Unsaved", "person"), /フォルダを保存できません/);
  assert.equal(blocked.local.has(FOLDERS), false);
  assert.equal(blocked.database.has(FOLDERS), false);
});

test("corrupt folder copies are protected instead of being replaced by defaults", async () => {
  const bad = { savedAt: 200, items: [project("orphan", "missing-person")] };
  const { storage, local, database } = createStorage({ localData: { [FOLDERS]: "{raw folder data" }, databaseData: { [FOLDERS]: bad } });
  await assert.rejects(storage.readFolders(), /研究者フォルダ/);
  await assert.rejects(storage.createFolder("New", "person"), /研究者フォルダ/);
  assert.equal(local.get(FOLDERS), "{raw folder data");
  assert.deepEqual(database.get(FOLDERS), bad);
});

test("simultaneous log move and copy across tabs retain both records and all payload data", async () => {
  const local = new Map();
  const database = new Map();
  const locks = createSharedLocks();
  const first = createStorage({ sharedLocal: local, sharedDatabase: database, locks, uuidPrefix: "tab1" }).storage;
  const second = createStorage({ sharedLocal: local, sharedDatabase: database, locks, uuidPrefix: "tab2" }).storage;
  const folder = await first.createFolder("Experiment", "project", "default-person");
  const saved = await first.saveLog("Original", { plates: [{ growthWeeks: { A1: 5 } }], extra: [1, 2] });
  const [moved, copied] = await Promise.all([first.updateLog(saved.id, { project_id: folder.id }), second.copyLog(saved.id, "default-project")]);
  const logs = await first.readLogs();
  assert.equal(logs.length, 2);
  assert.equal((await first.getLog(moved.id)).project_id, folder.id);
  assert.equal((await first.getLog(copied.id)).project_id, "default-project");
  assert.deepEqual(clone(moved.payload), clone(copied.payload));
});
