/* Verified, redundant browser storage. Legacy logs stay readable. */
window.PlatePackStorage = (() => {
  const LEGACY_LOGS = "PLATEPACK_LOCAL_LOGS_V1";
  const LOGS_KEY = "PLATEPACK_LOGS_V2";
  const FOLDERS_KEY = "PLATEPACK_FOLDERS_V1";
  const DRAFT_KEY = "PLATEPACK_DRAFT_V2";
  const PREVIOUS_KEY = "PLATEPACK_DRAFT_PREVIOUS_V2";
  let databasePromise;
  let writeQueue = Promise.resolve();
  let lastTimestamp = 0;
  const timestamp = () => (lastTimestamp = Math.max(Date.now(), lastTimestamp + 1));
  const DEFAULT_PROJECT = "default-project";
  const DEFAULT_FOLDERS = [
    { id: "default-person", name: "研究者 1", kind: "person", parent_id: null, created_at: "1970-01-01T00:00:00.000Z" },
    { id: DEFAULT_PROJECT, name: "プロジェクト 1", kind: "project", parent_id: "default-person", created_at: "1970-01-01T00:00:00.000Z" },
  ];
  const clone = value => JSON.parse(JSON.stringify(value));
  const entryTime = entry => Date.parse(entry.updated_at || entry.created_at || "") || 0;
  function modifiedAt(entry) {
    lastTimestamp = Math.max(timestamp(), entryTime(entry) + 1);
    return new Date(lastTimestamp).toISOString();
  }

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

  function corruptCopies(results) {
    return results.some(result => (result.status === "fulfilled" && result.value != null) ||
      (result.status === "rejected" && result.reason instanceof SyntaxError));
  }

  function validLog(entry) {
    return entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.length > 0;
  }

  function validCollection(record, validItem) {
    return record && Array.isArray(record.items) && record.items.every(validItem) &&
      (record.deletedIds === undefined || Array.isArray(record.deletedIds));
  }

  async function readCopies(key) {
    return Promise.allSettled([Promise.resolve().then(() => localGet(key)), databaseGet(key)]);
  }

  function mergeCopies(copies) {
    const deleted = new Set(copies.flatMap(copy => copy.deletedIds || []));
    const entries = new Map();
    copies.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).forEach(copy => copy.items.forEach(entry => {
      if (deleted.has(entry.id)) return;
      const existing = entries.get(entry.id);
      if (!existing || entryTime(entry) > entryTime(existing)) entries.set(entry.id, clone(entry));
    }));
    return Array.from(entries.values());
  }

  async function readLogs() {
    const results = await readCopies(LOGS_KEY);
    const copies = results.filter(r => r.status === "fulfilled" && validCollection(r.value, validLog)).map(r => r.value);
    if (copies.length) {
      return mergeCopies(copies).map(entry => ({ ...entry, project_id: entry.project_id || DEFAULT_PROJECT }))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    const legacy = localGet(LEGACY_LOGS);
    if (legacy === null) {
      if (corruptCopies(results)) {
        throw new Error("保存ログが破損しています。元のデータを保護しています。");
      }
      return [];
    }
    if (!Array.isArray(legacy) || !legacy.every(validLog)) throw new Error("保存ログを読み込めません。元のデータを保護しています。");
    return clone(legacy).map(entry => ({ ...entry, project_id: entry.project_id || DEFAULT_PROJECT }));
  }

  async function writeLogsNow(items) {
      const copies = await readCopies(LOGS_KEY);
      const deletedIds = new Set();
      const ids = new Set(items.map(entry => entry.id));
      copies.forEach(copy => {
        if (copy.status !== "fulfilled" || !validCollection(copy.value, validLog)) return;
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
    const snapshot = clone(items);
    if (!Array.isArray(snapshot) || !snapshot.every(validLog)) return Promise.reject(new Error("保存ログの形式が不正です。"));
    return serialized(() => writeLogsNow(snapshot));
  }

  function saveLog(name, payload, project_id = DEFAULT_PROJECT) {
    const snapshot = clone(payload);
    return serialized(async () => {
      await requireProject(project_id);
      const items = await readLogs();
      const entry = { id: crypto.randomUUID(), name: validName(String(name || "Log")), created_at: new Date().toISOString(), project_id, payload: snapshot };
      items.unshift(entry);
      await writeLogsNow(items);
      return clone(entry);
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

  function updateLog(id, changes) {
    const patch = clone(changes);
    return serialized(async () => {
      const items = await readLogs();
      const index = items.findIndex(entry => entry.id === id);
      if (index < 0) throw new Error("ログが見つかりません。");
      if (Object.keys(patch).some(key => !["name", "project_id"].includes(key))) throw new Error("変更できない項目が含まれています。");
      const entry = { ...items[index] };
      if (Object.hasOwn(patch, "name")) entry.name = validName(patch.name);
      if (Object.hasOwn(patch, "project_id")) {
        await requireProject(patch.project_id);
        entry.project_id = patch.project_id;
      }
      entry.updated_at = modifiedAt(items[index]);
      items[index] = entry;
      await writeLogsNow(items);
      return clone(entry);
    });
  }

  function copyLog(id, project_id = DEFAULT_PROJECT) {
    return serialized(async () => {
      await requireProject(project_id);
      const items = await readLogs();
      const original = items.find(entry => entry.id === id);
      if (!original) throw new Error("ログが見つかりません。");
      const entry = { ...clone(original), id: crypto.randomUUID(), project_id, created_at: new Date().toISOString() };
      delete entry.updated_at;
      items.unshift(entry);
      await writeLogsNow(items);
      return clone(entry);
    });
  }

  function validName(name) {
    if (typeof name !== "string" || !name.trim() || Array.from(name.trim()).length > 120) throw new Error("名前は1〜120文字で入力してください。");
    return name.trim();
  }

  function validFolder(folder) {
    return folder && typeof folder.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(folder.id) && typeof folder.name === "string" && folder.name.trim() &&
      ["person", "project"].includes(folder.kind) &&
      (folder.kind === "person" ? folder.parent_id === null : typeof folder.parent_id === "string" && folder.parent_id.length > 0);
  }

  function validateFolders(folders) {
    if (!Array.isArray(folders) || !folders.every(validFolder)) throw new Error("フォルダの形式が不正です。元のデータを保護しています。");
    const ids = new Set();
    folders.forEach(folder => {
      if (ids.has(folder.id)) throw new Error("フォルダIDが重複しています。");
      ids.add(folder.id);
      if (folder.kind === "project" && !folders.some(parent => parent.id === folder.parent_id && parent.kind === "person")) {
        throw new Error("プロジェクトの移動先は研究者フォルダを指定してください。");
      }
    });
    return folders;
  }

  async function readFolders() {
    const results = await readCopies(FOLDERS_KEY);
    const copies = results.filter(result => result.status === "fulfilled" && validCollection(result.value, validFolder)).map(result => result.value);
    if (!copies.length && corruptCopies(results)) throw new Error("フォルダを読み込めません。元のデータを保護しています。");
    const folders = mergeCopies(copies);
    DEFAULT_FOLDERS.forEach(folder => { if (!folders.some(item => item.id === folder.id)) folders.push(clone(folder)); });
    return validateFolders(folders);
  }

  async function writeFoldersNow(folders) {
    validateFolders(folders);
    const record = { savedAt: timestamp(), items: clone(folders) };
    const results = await Promise.allSettled([
      Promise.resolve().then(() => localPut(FOLDERS_KEY, record)), databasePut(FOLDERS_KEY, record),
    ]);
    if (results.every(result => result.status === "rejected")) throw new Error("フォルダを保存できません。元のデータを保護しています。");
    return record;
  }

  async function requireProject(id) {
    const folders = await readFolders();
    if (!folders.some(folder => folder.id === id && folder.kind === "project")) throw new Error("保存先のプロジェクトが見つかりません。");
  }

  function createFolder(name, kind, parent_id = null, id = crypto.randomUUID()) {
    return serialized(async () => {
      const folders = await readFolders();
      const folder = { id, name: validName(name), kind, parent_id, created_at: new Date().toISOString() };
      const existing = folders.find(item => item.id === id);
      if (existing) {
        if (existing.kind !== kind || existing.parent_id !== parent_id || existing.name !== folder.name) throw new Error("同じIDのフォルダが既に存在します。");
        return clone(existing);
      }
      folders.push(folder);
      validateFolders(folders);
      await writeFoldersNow(folders);
      return clone(folder);
    });
  }

  function updateFolder(id, changes) {
    const patch = clone(changes);
    return serialized(async () => {
      const folders = await readFolders();
      const index = folders.findIndex(folder => folder.id === id);
      if (index < 0) throw new Error("フォルダが見つかりません。");
      if (Object.keys(patch).some(key => !["name", "parent_id"].includes(key))) throw new Error("変更できない項目が含まれています。");
      const folder = { ...folders[index] };
      if (Object.hasOwn(patch, "name")) folder.name = validName(patch.name);
      if (Object.hasOwn(patch, "parent_id")) folder.parent_id = patch.parent_id;
      folder.updated_at = modifiedAt(folders[index]);
      folders[index] = folder;
      validateFolders(folders);
      await writeFoldersNow(folders);
      return clone(folder);
    });
  }

  function mergeFolders(incoming) {
    const snapshot = clone(incoming);
    if (!Array.isArray(snapshot) || !snapshot.every(validFolder)) return Promise.reject(new Error("フォルダの形式が不正です。"));
    return serialized(async () => {
      const folders = await readFolders();
      const merged = new Map(folders.map(folder => [folder.id, folder]));
      snapshot.forEach(folder => {
        const existing = merged.get(folder.id);
        if (existing && existing.kind !== folder.kind) throw new Error("フォルダの種類を変更できません。");
        if (!existing || !folder.updated_at || entryTime(folder) >= entryTime(existing)) merged.set(folder.id, folder);
      });
      const items = validateFolders(Array.from(merged.values()));
      await writeFoldersNow(items);
      return clone(items);
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

  return { readLogs, writeLogs, saveLog, getLog, deleteLog, updateLog, copyLog,
    readFolders, createFolder, updateFolder, mergeFolders,
    readDraft, writeDraftSync, writeDraft, requestPersistence, fetchJson };
})();
