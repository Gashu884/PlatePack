/* Verified, redundant browser storage. Legacy logs stay readable. */
window.PlatePackStorage = (() => {
  const LEGACY_LOGS = "PLATEPACK_LOCAL_LOGS_V1";
  const LOGS_KEY = "PLATEPACK_LOGS_V2";
  const DRAFT_KEY = "PLATEPACK_DRAFT_V2";
  const PREVIOUS_KEY = "PLATEPACK_DRAFT_PREVIOUS_V2";
  let databasePromise;
  let writeQueue = Promise.resolve();
  let lastTimestamp = 0;
  const timestamp = () => (lastTimestamp = Math.max(Date.now(), lastTimestamp + 1));

  function openDatabase() {
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("PlatePack", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("ブラウザ保存を開けません。"));
      request.onblocked = () => reject(new Error("別のタブがブラウザ保存を使用しています。"));
    });
    return databasePromise;
  }

  async function databaseGet(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction("records", "readonly").objectStore("records").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("保存データを読み込めません。"));
    });
  }

  async function databasePut(key, value) {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      let transaction;
      try { transaction = db.transaction("records", "readwrite", { durability: "strict" }); }
      catch { transaction = db.transaction("records", "readwrite"); }
      transaction.objectStore("records").put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(new Error("ブラウザ保存に失敗しました。"));
    });
    if (JSON.stringify(await databaseGet(key)) !== JSON.stringify(value)) {
      throw new Error("保存データの確認に失敗しました。JSONバックアップを保存してください。");
    }
  }

  function localGet(key) {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }

  function localPut(key, value) {
    const raw = JSON.stringify(value);
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw new Error("保存データの確認に失敗しました。");
  }

  function serialized(operation) {
    const pending = writeQueue.catch(() => {}).then(() =>
      navigator.locks?.request ? navigator.locks.request("PlatePack-storage", operation) : operation());
    writeQueue = pending;
    return pending;
  }

  async function readLogs() {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => localGet(LOGS_KEY)), databaseGet(LOGS_KEY),
    ]);
    const copies = results.filter(r => r.status === "fulfilled" && Array.isArray(r.value?.items))
      .map(r => r.value).sort((a, b) => b.savedAt - a.savedAt);
    if (copies.length) {
      const deleted = new Set(copies.flatMap(copy => copy.deletedIds || []));
      const entries = new Map();
      copies.forEach(copy => copy.items.forEach(entry => {
        if (entry?.id && !deleted.has(entry.id) && !entries.has(entry.id)) entries.set(entry.id, entry);
      }));
      return Array.from(entries.values()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    const legacy = localGet(LEGACY_LOGS);
    if (legacy === null) {
      if (results.some(r => (r.status === "fulfilled" && r.value != null) || (r.status === "rejected" && r.reason instanceof SyntaxError))) {
        throw new Error("保存ログが破損しています。元のデータを保護しています。");
      }
      return [];
    }
    if (!Array.isArray(legacy)) throw new Error("保存ログを読み込めません。元のデータを保護しています。");
    return legacy;
  }

  async function writeLogsNow(items) {
      const copies = await Promise.allSettled([Promise.resolve().then(() => localGet(LOGS_KEY)), databaseGet(LOGS_KEY)]);
      const deletedIds = new Set();
      const ids = new Set(items.map(entry => entry.id));
      copies.forEach(copy => {
        if (copy.status !== "fulfilled" || !Array.isArray(copy.value?.items)) return;
        (copy.value.deletedIds || []).forEach(id => deletedIds.add(id));
        copy.value.items.forEach(entry => { if (!ids.has(entry.id)) deletedIds.add(entry.id); });
      });
      const record = { savedAt: timestamp(), items, deletedIds: Array.from(deletedIds) };
      const results = await Promise.allSettled([
        Promise.resolve().then(() => localPut(LOGS_KEY, record)), databasePut(LOGS_KEY, record),
      ]);
      if (results.every(r => r.status === "rejected")) {
        throw new Error("ブラウザに保存できません。容量・設定を確認し、JSONバックアップを保存してください。");
      }
      // Keep the original format available for older versions of the app.
      try { localPut(LEGACY_LOGS, items); } catch {}
      return record;
  }

  function writeLogs(items) {
    return serialized(() => writeLogsNow(items));
  }

  function saveLog(name, payload) {
    return serialized(async () => {
    const items = await readLogs();
    const entry = { id: crypto.randomUUID(), name: String(name || "Log"), created_at: new Date().toISOString(), payload };
    items.unshift(entry);
    await writeLogsNow(items);
    return entry;
    });
  }

  async function getLog(id) {
    return (await readLogs()).find(entry => entry?.id === id) || null;
  }

  function deleteLog(id) {
    return serialized(async () => {
      const items = await readLogs();
      return writeLogsNow(items.filter(entry => entry?.id !== id));
    });
  }

  function validDraft(record) {
    return record && Number.isFinite(record.savedAt) && Array.isArray(record.snapshot?.plates) && record.snapshot.plates.length;
  }

  async function readDraft() {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => localGet(DRAFT_KEY)),
      Promise.resolve().then(() => localGet(PREVIOUS_KEY)),
      databaseGet(DRAFT_KEY), databaseGet(PREVIOUS_KEY),
    ]);
    const copies = results.filter(r => r.status === "fulfilled" && validDraft(r.value))
      .map(r => r.value).sort((a, b) => b.savedAt - a.savedAt);
    if (!copies.length && results.some(r => (r.status === "fulfilled" && r.value != null) || (r.status === "rejected" && r.reason instanceof SyntaxError))) {
      throw new Error("自動保存データを復元できません。元のデータを保護しています。");
    }
    return copies[0] || null;
  }

  function writeDraftSync(record) {
    // Preserve the last valid draft before replacing it.
    let previous;
    try { previous = localGet(DRAFT_KEY); } catch {}
    if (validDraft(previous)) { try { localPut(PREVIOUS_KEY, previous); } catch {} }
    localPut(DRAFT_KEY, record);
  }

  function writeDraft(record, localSaved = false) {
    return serialized(async () => {
      let localOk = localSaved;
      if (!localOk) { try { writeDraftSync(record); localOk = true; } catch {} }
      let databaseOk = false;
      try {
        const previous = await databaseGet(DRAFT_KEY);
        if (validDraft(previous)) { try { await databasePut(PREVIOUS_KEY, previous); } catch {} }
        await databasePut(DRAFT_KEY, record);
        databaseOk = true;
      } catch {}
      if (!localOk && !databaseOk) throw new Error("自動保存できません。JSONバックアップを保存してください。");
      return { localOk, databaseOk };
    });
  }

  async function requestPersistence() {
    try { return await navigator.storage?.persist?.(); } catch { return false; }
  }

  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${response.status}`);
      return data;
    } finally { clearTimeout(timer); }
  }

  return { readLogs, writeLogs, saveLog, getLog, deleteLog, readDraft, writeDraftSync, writeDraft, requestPersistence, fetchJson };
})();
