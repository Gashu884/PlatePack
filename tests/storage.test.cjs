const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "../frontend/storage.js"), "utf8");
const LOGS = "PLATEPACK_LOGS_V2";
const LEGACY = "PLATEPACK_LOCAL_LOGS_V1";
const DRAFT = "PLATEPACK_DRAFT_V2";
const PREVIOUS = "PLATEPACK_DRAFT_PREVIOUS_V2";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const entry = id => ({ id, name: `Log ${id}`, created_at: "2026-10-09T00:00:00Z", payload: { id, plates: [] } });
const draft = (savedAt, label) => ({ savedAt, snapshot: { plates: [{ label, wells: ["A1"], growthWeeks: { A1: 3 } }] } });

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
  assert.deepEqual(logs.slice(1), originals);
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
  assert.deepEqual(clone(await storage.readLogs()), originals);
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
