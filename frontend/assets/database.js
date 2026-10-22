/* Finder-style person/project organization. Plate payloads are never changed by moves. */
(() => {
  'use strict';
  const storage = window.PlatePackStorage;
  const DEFAULT_PROJECT = 'default-project';
  const DEFAULT_PERSON = 'default-person';
  const CLIPBOARD_KEY = 'PLATEPACK_DATABASE_CLIPBOARD_V1';
  const $ = id => document.getElementById(id);
  let folders = [];
  let logs = [];
  let selected = new Set();
  let currentFolder = new URLSearchParams(location.search).get('project') || DEFAULT_PROJECT;
  let clipboard = null;
  let busy = false;
  let serverOnline = false;
  let sortBy = 'name';
  let ascending = true;
  let visibleItems = [];
  let selectionAnchor = null;
  const folder = id => folders.find(item => item.id === id);
  const keyFor = item => item.source + ':' + item.id;
  const selectedLogs = () => logs.filter(item => selected.has(keyFor(item)));
  const message = (text, error = false) => {
    $('notice').hidden = !text;
    $('notice').textContent = text;
    $('notice').dataset.error = String(error);
  };
  const canonical = value => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  };
  const dateText = value => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  };
  const projectPath = project => (folder(project.parent_id)?.name || 'メンバー') + ' / ' + project.name;
  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function api(path, options) { return storage.fetchJson(path, options); }
  function request(method, body) { return {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}; }
  async function fetchAllLogs() {
    const result = [];
    for (let offset = 0; ; offset += 1000) {
      const batch = await api('/api/logs?limit=1000&offset=' + offset);
      if (!Array.isArray(batch)) throw new Error('DBの一覧を読み込めません。');
      result.push(...batch);
      if (batch.length < 1000) return result;
    }
  }
  function readClipboard() {
    try {
      const data = JSON.parse(localStorage.getItem(CLIPBOARD_KEY));
      if (data && ['copy','cut'].includes(data.mode) && Array.isArray(data.keys)) clipboard = data;
    } catch {}
  }
  function writeClipboard(data) {
    clipboard = data;
    try { localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(data)); } catch {}
  }
  async function refresh() {
    $('itemCount').textContent = '読み込み中…';
    const results = await Promise.allSettled([storage.readFolders(), storage.readLogs(), api('/api/folders')]);
    const localFolders = results[0].status === 'fulfilled' ? results[0].value : [];
    const localLogs = results[1].status === 'fulfilled' ? results[1].value : [];
    let remoteFolders = [];
    let remoteLogs = [];
    const errors = [];
    if (results[0].status === 'rejected') errors.push('ブラウザのフォルダを読み込めません。保存データは保持しています。');
    if (results[1].status === 'rejected') errors.push('ブラウザのログを読み込めません。保存データは保持しています。');
    serverOnline = results[2].status === 'fulfilled' && Array.isArray(results[2].value);
    if (serverOnline) {
      remoteFolders = results[2].value;
      // Sync folders created while offline with their original IDs, parents first.
      for (const local of [...localFolders].sort((a,b) => (a.kind === 'person' ? 0 : 1) - (b.kind === 'person' ? 0 : 1))) {
        try {
          const remote = remoteFolders.find(item => item.id === local.id);
          if (!remote) {
            remoteFolders.push(await api('/api/folders', request('POST', {id:local.id,name:local.name,kind:local.kind,parent_id:local.parent_id})));
          } else if (Date.parse(local.updated_at || '') > Date.parse(remote.updated_at || '') &&
              (local.name !== remote.name || local.parent_id !== remote.parent_id)) {
            const updated = await api('/api/folders/' + encodeURIComponent(local.id), request('PATCH', {name:local.name,parent_id:local.parent_id}));
            remoteFolders = remoteFolders.map(item => item.id === updated.id ? updated : item);
          }
        } catch { errors.push('一部のフォルダをDBと同期できません。ブラウザのフォルダは保持しています。'); }
      }
      try { await storage.mergeFolders(remoteFolders); } catch { errors.push('フォルダのブラウザ保存に失敗しました。DBの保存は保持しています。'); }
      try { remoteLogs = await fetchAllLogs(); } catch { serverOnline = false; errors.push('DBのログを読み込めません。ブラウザのログを表示します。'); }
    } else errors.push('DBに接続できません。このブラウザに保存したデータを表示します。');
    const merged = new Map(localFolders.map(item => [item.id, item]));
    remoteFolders.forEach(item => {
      const local = merged.get(item.id);
      if (!local || Date.parse(item.updated_at || '') >= Date.parse(local.updated_at || '') || !local.updated_at) merged.set(item.id, item);
    });
    folders = Array.from(merged.values());
    logs = [
      ...remoteLogs.map(item => ({...item,project_id:item.project_id || DEFAULT_PROJECT,source:'db'})),
      ...localLogs.map(item => ({...item,project_id:item.project_id || DEFAULT_PROJECT,source:'local'})),
    ];
    if (currentFolder && !folder(currentFolder)) currentFolder = folder(DEFAULT_PROJECT) ? DEFAULT_PROJECT : null;
    selected = new Set([...selected].filter(key => logs.some(item => keyFor(item) === key) || folders.some(item => 'folder:' + item.id === key)));
    readClipboard();
    render();
    $('connectionState').textContent = serverOnline ? 'DB＋このブラウザ' : 'このブラウザのデータ';
    if (errors.length) message([...new Set(errors)].join(' '), true);
  }
  function navigate(id) {
    currentFolder = id;
    selected.clear();
    selectionAnchor = null;
    $('searchInput').value = '';
    hideContext();
    render();
  }
  function addDropTarget(target, projectId) {
    target.addEventListener('dragover', event => {
      if (busy || !event.dataTransfer.types.includes('application/x-platepack')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move';
      target.classList.add('drop-target');
    });
    target.addEventListener('dragleave', () => target.classList.remove('drop-target'));
    target.addEventListener('drop', event => {
      event.preventDefault();
      target.classList.remove('drop-target');
      try {
        const parsed = JSON.parse(event.dataTransfer.getData('application/x-platepack'));
        if (!Array.isArray(parsed.keys) || !parsed.keys.every(key => typeof key === 'string')) return;
        transfer(parsed.keys, projectId, event.altKey ? 'copy' : 'cut');
      } catch { message('ドラッグしたデータを読み込めません。', true); }
    });
  }
  function renderTree() {
    $('folderTree').replaceChildren();
    const persons = folders.filter(item => item.kind === 'person').sort((a,b) => a.name.localeCompare(b.name, 'ja'));
    persons.forEach(person => {
      const personButton = element('button','tree-item person');
      personButton.type = 'button';
      personButton.dataset.folderId = person.id;
      personButton.setAttribute('role','treeitem');
      personButton.setAttribute('aria-level','1');
      personButton.setAttribute('aria-expanded','true');
      personButton.classList.toggle('active', currentFolder === person.id);
      personButton.append(element('span','folder-icon'), element('span','folder-name', person.name));
      personButton.addEventListener('click', () => navigate(person.id));
      $('folderTree').append(personButton);
      folders.filter(item => item.kind === 'project' && item.parent_id === person.id).sort((a,b) => a.name.localeCompare(b.name,'ja')).forEach(project => {
        const button = element('button','tree-item project');
        button.type = 'button';
        button.dataset.folderId = project.id;
        button.setAttribute('role','treeitem');
        button.setAttribute('aria-level','2');
        button.setAttribute('aria-selected', String(currentFolder === project.id));
        button.classList.toggle('active', currentFolder === project.id);
        button.append(element('span','folder-icon'), element('span','folder-name',project.name), element('span','tree-count',String(logs.filter(item => item.project_id === project.id).length)));
        button.addEventListener('click', () => navigate(project.id));
        addDropTarget(button, project.id);
        $('folderTree').append(button);
      });
    });
    $('rootBtn').classList.toggle('active', !currentFolder);
  }
  function renderPath() {
    const path = [{id:null,name:'Database'}];
    const current = folder(currentFolder);
    if (current?.kind === 'project') {
      const person = folder(current.parent_id);
      if (person) path.push(person);
    }
    if (current) path.push(current);
    $('pathbar').replaceChildren();
    path.forEach((item,index) => {
      if (index) $('pathbar').append(element('span','path-separator','/'));
      const button = element('button','',item.name);
      button.type = 'button';
      button.dataset.folderId = item.id || '';
      if (index === path.length - 1) button.setAttribute('aria-current','page');
      button.addEventListener('click', () => navigate(item.id));
      $('pathbar').append(button);
    });
    $('newProjectBtn').disabled = busy || !current;
    $('importBtn').disabled = busy || current?.kind !== 'project';
  }
  function getVisibleItems() {
    const current = folder(currentFolder);
    const children = current?.kind === 'project' ? logs.filter(item => item.project_id === current.id) :
      folders.filter(item => current ? item.parent_id === current.id && item.kind === 'project' : item.kind === 'person').map(item => ({...item,source:'folder'}));
    const query = $('searchInput').value.toLocaleLowerCase();
    return children.filter(item => item.name.toLocaleLowerCase().includes(query)).sort((a,b) => {
      const result = sortBy === 'date' ? String(a.created_at || '').localeCompare(String(b.created_at || '')) : a.name.localeCompare(b.name,'ja');
      return ascending ? result : -result;
    });
  }
  function selectItem(item,event) {
    const key = keyFor(item);
    if (event.shiftKey && selectionAnchor && visibleItems.some(entry => keyFor(entry) === selectionAnchor)) {
      const start = visibleItems.findIndex(entry => keyFor(entry) === selectionAnchor);
      const end = visibleItems.findIndex(entry => keyFor(entry) === key);
      if (!event.metaKey && !event.ctrlKey) selected.clear();
      visibleItems.slice(Math.min(start,end),Math.max(start,end)+1).forEach(entry => selected.add(keyFor(entry)));
    } else if (event.metaKey || event.ctrlKey) {
      selected.has(key) ? selected.delete(key) : selected.add(key);
      selectionAnchor = key;
    } else {
      selected = new Set([key]);
      selectionAnchor = key;
    }
    updateSelection();
  }
  async function openItem(item) {
    if (item.source === 'folder') return navigate(item.id);
    try { const entry=await getEntry(item); location.href = (entry.payload.electrophoresis ? '/electrophoresis?log=' : '/plates?log=') + encodeURIComponent(item.source === 'local' ? 'local:' + item.id : item.id); } catch(e) { message(e.message,true); }
  }
  function renderList() {
    visibleItems = getVisibleItems();
    $('list').replaceChildren();
    visibleItems.forEach(item => {
      const row = element('tr', item.source === 'folder' ? 'folder-row' : 'file-row');
      row.dataset.key = keyFor(item);
      row.tabIndex = 0;
      if (item.source === 'folder') row.dataset.folderId = item.id;
      const nameCell = element('td');
      const name = element('div','name-cell');
      name.append(item.source === 'folder' ? element('span','folder-icon') : element('span','file-icon','96'), element('span','name-text',item.name));
      nameCell.append(name);
      const kind = item.source === 'folder' ? (item.kind === 'person' ? 'メンバーフォルダ' : 'プロジェクト') : ((item.record_type==='electrophoresis'||item.payload?.electrophoresis) ? '泳動解析・プレート' : 'プレートデータ');
      const badgeCell = element('td');
      if (item.source !== 'folder') badgeCell.append(element('span','storage-badge' + (item.source === 'local' ? ' local' : ''),item.source === 'local' ? 'ブラウザ' : 'DB'));
      else badgeCell.textContent = '—';
      const actionCell = element('td','row-action');
      const open = element('button','row-open','開く');
      open.type = 'button';
      open.addEventListener('click', event => { event.stopPropagation(); openItem(item); });
      actionCell.append(open);
      row.append(nameCell, element('td','',kind), element('td','',dateText(item.created_at)),badgeCell,actionCell);
      row.addEventListener('click', event => selectItem(item,event));
      row.addEventListener('dblclick', () => openItem(item));
      row.addEventListener('keydown', event => { if (event.key === 'Enter') openItem(item); });
      row.addEventListener('contextmenu', event => { event.preventDefault(); if (!selected.has(keyFor(item))) selectItem(item,event); showContext(item,event.clientX,event.clientY); });
      if (item.source !== 'folder') {
        row.draggable = true;
        row.addEventListener('dragstart', event => {
          if (busy) return event.preventDefault();
          if (!selected.has(keyFor(item))) selectItem(item,{});
          event.dataTransfer.setData('application/x-platepack', JSON.stringify({keys:selectedLogs().map(keyFor)}));
          event.dataTransfer.effectAllowed = 'copyMove';
        });
      } else if (item.kind === 'project') addDropTarget(row,item.id);
      $('list').append(row);
    });
    $('empty').hidden = visibleItems.length > 0;
    $('empty').textContent = $('searchInput').value ? '該当なし' : 'データなし';
    $('itemCount').textContent = visibleItems.length + '件';
    updateSelection();
  }
  function updateSelection() {
    document.querySelectorAll('#list tr[data-key]').forEach(row => {
      row.classList.toggle('selected',selected.has(row.dataset.key));
      row.classList.toggle('cut',clipboard?.mode === 'cut' && clipboard.keys.includes(row.dataset.key));
      row.setAttribute('aria-selected',String(selected.has(row.dataset.key)));
    });
    const chosen = selectedLogs();
    $('selectionInfo').textContent = selected.size ? selected.size + '件選択' : visibleItems.length + '件';
    ['copyBtn','cutBtn','downloadBtn','deleteBtn'].forEach(id => $(id).disabled = busy || !chosen.length);
    $('migrateBtn').disabled = busy || !serverOnline || !chosen.some(item => item.source === 'local');
    $('moveBtn').disabled = busy || !chosen.length || !$('moveProjectSelect').value;
    $('pasteBtn').disabled = busy || !clipboard?.keys?.length || folder(currentFolder)?.kind !== 'project';
    $('renameBtn').disabled = busy || selected.size > 1 || (selected.size === 0 && !folder(currentFolder));
    $('newPersonBtn').disabled = busy;
  }
  function render() {
    renderTree(); renderPath();
    const target = $('moveProjectSelect').value;
    $('moveProjectSelect').replaceChildren(element('option','','プロジェクトを選択'));
    $('moveProjectSelect').firstChild.value = '';
    folders.filter(item => item.kind === 'project').sort((a,b) => projectPath(a).localeCompare(projectPath(b),'ja')).forEach(project => {
      const option = element('option','',projectPath(project)); option.value = project.id; $('moveProjectSelect').append(option);
    });
    if (folder(target)) $('moveProjectSelect').value = target;
    renderList();
  }
  async function action(operation) {
    if (busy) return;
    busy = true; updateSelection();
    try { await operation(); } catch(error) { message(error.message || '操作に失敗しました。元のデータを保持しています。',true); }
    finally { busy = false; renderPath(); updateSelection(); }
  }
  async function createFolder(kind) {
    const parent = kind === 'person' ? null : (folder(currentFolder)?.kind === 'person' ? currentFolder : folder(currentFolder)?.parent_id);
    if (kind === 'project' && !parent) return message('先にメンバーフォルダを開いてください。',true);
    const name = prompt(kind === 'person' ? 'メンバーフォルダの名前' : 'プロジェクトの名前',kind === 'person' ? '新しいメンバー' : '新しいプロジェクト')?.trim();
    if (!name) return;
    await action(async () => {
      const id = crypto.randomUUID();
      let created;
      if (serverOnline) {
        created = await api('/api/folders',request('POST',{id,name,kind,parent_id:parent}));
        try { await storage.mergeFolders([created]); } catch { message('DBにフォルダを作成しました。ブラウザのコピーは保存できていません。',true); }
      } else created = await storage.createFolder(name,kind,parent,id);
      await refresh(); navigate(created.id);
      message('フォルダを作成しました: ' + name);
    });
  }
  async function getEntry(item) {
    const entry = item.source === 'local' ? await storage.getLog(item.id) : await api('/api/logs/' + encodeURIComponent(item.id));
    if (!entry?.payload) throw new Error('プレートデータが見つかりません。');
    return entry;
  }
  async function updateEntry(item,patch) {
    if (item.source === 'local') return storage.updateLog(item.id,patch);
    const updated = await api('/api/logs/' + encodeURIComponent(item.id),request('PATCH',patch));
    if (patch.project_id && updated.project_id !== patch.project_id) throw new Error('移動先の保存確認に失敗しました。');
    if (patch.name && updated.name !== patch.name) throw new Error('名前の保存確認に失敗しました。');
    return updated;
  }
  async function copyEntry(item,projectId) {
    if (item.source === 'local') return storage.copyLog(item.id,projectId);
    const original = await getEntry(item);
    const copied = await api('/api/logs/' + encodeURIComponent(item.id) + '/copy',request('POST',{project_id:projectId}));
    const verified = await api('/api/logs/' + encodeURIComponent(copied.id));
    if (verified.project_id !== projectId || canonical(verified.payload) !== canonical(original.payload)) throw new Error('コピー内容の保存確認に失敗しました。元のデータは保持しています。');
    return verified;
  }
  async function transfer(keys,projectId,mode) {
    if (folder(projectId)?.kind !== 'project') return message('移動先のプロジェクトを選択してください。',true);
    await action(async () => {
      const failed = []; let count = 0;
      for (const key of keys) {
        const item = logs.find(entry => keyFor(entry) === key);
        if (!item) { failed.push(key); continue; }
        try {
          if (mode === 'copy') await copyEntry(item,projectId);
          else await updateEntry(item,{project_id:projectId});
          count++;
        } catch { failed.push(key); }
      }
      if (mode === 'cut' && clipboard?.mode === 'cut') writeClipboard({mode:'cut',keys:clipboard.keys.filter(key => !keys.includes(key) || failed.includes(key))});
      selected.clear();
      await refresh();
      message((mode === 'copy' ? 'コピー' : '移動') + 'しました: ' + count + '件 → ' + folder(projectId).name +
        (failed.length ? '。' + failed.length + '件は処理できていません。元のデータは保持しています。' : ''),failed.length > 0);
    });
  }
  function copySelection(mode) {
    const keys = selectedLogs().map(keyFor);
    if (!keys.length) return;
    writeClipboard({mode,keys});
    updateSelection();
    message(keys.length + '件を' + (mode === 'cut' ? '切り取り' : 'コピー') + 'ました。');
  }
  function paste() {
    readClipboard();
    if (clipboard?.keys?.length && folder(currentFolder)?.kind === 'project') return transfer([...clipboard.keys],currentFolder,clipboard.mode);
  }
  async function rename() {
    if (selected.size > 1) return;
    const key = selected.size === 1 ? [...selected][0] : null;
    const item = key?.startsWith('folder:') ? folder(key.slice(7)) : logs.find(entry => keyFor(entry) === key) || folder(currentFolder);
    if (!item) return;
    const name = prompt('名前を変更',item.name)?.trim();
    if (!name || name === item.name) return;
    await action(async () => {
      if (item.kind) {
        if (serverOnline) {
          const renamed = await api('/api/folders/' + encodeURIComponent(item.id),request('PATCH',{name}));
          await storage.mergeFolders([renamed]);
        } else await storage.updateFolder(item.id,{name});
      } else await updateEntry(item,{name});
      await refresh(); message('名前を変更しました: ' + name);
    });
  }
  function downloadJson(name,data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = name.replace(/[\\/:*?"<>|]/g,'_') + '.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  async function downloadSelected() {
    await action(async () => {
      for (const item of selectedLogs()) {
        const entry = await getEntry(item);
        downloadJson(item.name,{...entry,project:folder(entry.project_id),person:folder(folder(entry.project_id)?.parent_id)});
      }
    });
  }
  async function deleteSelected() {
    const entries = selectedLogs();
    if (!entries.length || !confirm(entries.length + '件のプレートデータを削除しますか？必要なJSONバックアップは先に保存してください。')) return;
    await action(async () => {
      let count = 0; let failed = 0;
      for (const item of entries) {
        try {
          if (item.source === 'local') await storage.deleteLog(item.id);
          else await api('/api/logs/' + encodeURIComponent(item.id),{method:'DELETE'});
          count++;
        } catch { failed++; }
      }
      selected.clear(); await refresh();
      message(count + '件を削除しました。' + (failed ? failed + '件は削除できていません。保存データを保持しています。' : ''),failed > 0);
    });
  }
  async function migrateSelected() {
    const entries = selectedLogs().filter(item => item.source === 'local');
    if (!serverOnline || !entries.length || !confirm(entries.length + '件をDBへ移行します。保存内容を確認できたものだけブラウザの一覧から取り除きます。')) return;
    await action(async () => {
      let count = 0; let failed = 0;
      for (const item of entries) {
        try {
          const original = await getEntry(item);
          const saved = await api('/api/logs',request('POST',{name:original.name,payload:original.payload,project_id:original.project_id}));
          const verified = await api('/api/logs/' + encodeURIComponent(saved.id));
          if (verified.project_id !== original.project_id || canonical(verified.payload) !== canonical(original.payload)) throw new Error('保存内容が一致しません。');
          await storage.deleteLog(item.id);
          count++;
        } catch { failed++; }
      }
      selected.clear(); await refresh();
      message('DBへ移行しました: ' + count + '件。' + (failed ? failed + '件は移行できていません。ブラウザのデータを保持しています。' : ''),failed > 0);
    });
  }
      function validatePayload(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.plates) || !snapshot.plates.length || snapshot.plates.length > 999) {
          throw new Error("PlatePackのJSON形式を確認してください。現在の入力は保持しています。");
        }
        const validGrowthWeek = value => Number.isInteger(value) && value >= 1 && value <= 5;
        const isWell = well => typeof well === "string" && /^[A-H]([1-9]|1[0-2])$/.test(well);
        snapshot.plates.forEach(plate => {
          if (!plate || !Array.isArray(plate.wells) || !plate.wells.every(isWell)) throw new Error("ウェル情報が不正です。");
          if (plate.growthWeeks !== undefined && (!plate.growthWeeks || typeof plate.growthWeeks !== "object" || Array.isArray(plate.growthWeeks))) {
            throw new Error("フェーズ番号の形式が不正です。");
          }
          Object.entries(plate.growthWeeks || {}).forEach(([well, week]) => {
            if (!isWell(well) || !validGrowthWeek(week)) throw new Error("フェーズ番号は1〜5を指定してください。");
          });
        });
        if (snapshot.packedPlates !== undefined) {
          if (!Array.isArray(snapshot.packedPlates)) throw new Error("パック結果が不正です。");
          snapshot.packedPlates.forEach(plate => {
            if (!plate || !Array.isArray(plate.grid) || plate.grid.length !== 8 ||
                !plate.grid.every(row => Array.isArray(row) && row.length === 12)) throw new Error("パック結果のサイズが不正です。");
            if ((plate.id != null && typeof plate.id !== "string") ||
                (plate.columns !== undefined && (!Array.isArray(plate.columns) || plate.columns.length !== 12 || !plate.columns.every((column, index) => column === index + 1)))) {
              throw new Error("パック結果の列情報が不正です。");
            }
            plate.grid.flat().forEach(cell => {
              if (cell && (!isWell(cell.sourceWell) || typeof cell.sourcePlate !== "string" ||
                  (cell.growthWeek != null && !validGrowthWeek(cell.growthWeek)) ||
                  (cell.color != null && (typeof cell.color !== "string" || !/^#[0-9a-f]{6}$/i.test(cell.color))))) throw new Error("パック結果のウェル情報が不正です。");
            });
          });
        }
        if (snapshot.packedLayout != null) {
          const layout = snapshot.packedLayout;
          if (!layout || !["row", "column"].includes(layout.layoutDirection) ||
              !Array.isArray(layout.verticalDividers) || !layout.verticalDividers.every(n => Number.isInteger(n) && n > 0 && n < 12) ||
              !Array.isArray(layout.horizontalDividers) || !layout.horizontalDividers.every(n => Number.isInteger(n) && n > 0 && n < 8)) {
            throw new Error("パック結果のレイアウトが不正です。");
          }
        }
        return snapshot;
      }

  async function importFile(file) {
    if (folder(currentFolder)?.kind !== 'project') throw new Error('保存先のプロジェクトを開いてください。');
    const projectId = currentFolder;
    const parsed = JSON.parse(await file.text());
    const payload = validatePayload(parsed.payload || parsed);
    const name = prompt('プレートデータの名前',parsed.name || file.name.replace(/\.json$/i,''))?.trim();
    if (!name) return;
    await action(async () => {
      let localOk = false; let dbOk = false;
      try { await storage.saveLog(name,payload,projectId); localOk = true; } catch {}
      if (serverOnline) {
        try {
          const saved = await api('/api/logs',request('POST',{name,payload,project_id:projectId}));
          const verified = await api('/api/logs/' + encodeURIComponent(saved.id));
          if (canonical(verified.payload) !== canonical(payload) || verified.project_id !== projectId) throw new Error('保存確認に失敗しました。');
          dbOk = true;
        } catch {}
      }
      await refresh();
      if (!localOk && !dbOk) throw new Error('保存に失敗しました。元のJSONファイルを保管してください。');
      message('JSONを保存しました: ' + name + '（' + [dbOk && 'DB',localOk && 'このブラウザ'].filter(Boolean).join('・') + '）' +
        (serverOnline && !dbOk ? '。DBには保存できていません。' : ''),serverOnline && !dbOk);
    });
  }
  function hideContext() { $('contextMenu').hidden = true; }
  function showContext(item,x,y) {
    const menu = $('contextMenu'); menu.replaceChildren();
    const actions = [['開く',() => openItem(item)],['名前を変更',rename]];
    if (item.source !== 'folder') actions.push(['コピー',() => copySelection('copy')],['切り取り',() => copySelection('cut')],['JSON保存',downloadSelected],['削除',deleteSelected]);
    if (folder(currentFolder)?.kind === 'project' && clipboard?.keys.length) actions.push(['ペースト',paste]);
    actions.forEach(([name,callback]) => {
      const button = element('button',name === '削除' ? 'danger' : '',name); button.type = 'button'; button.setAttribute('role','menuitem');
      button.addEventListener('click', () => { hideContext(); callback(); }); menu.append(button);
    });
    menu.hidden = false; menu.style.left = Math.max(5,Math.min(x,innerWidth - 180)) + 'px'; menu.style.top = Math.max(5,Math.min(y,innerHeight - menu.offsetHeight - 5)) + 'px';
  }
  $('newPersonBtn').addEventListener('click',() => createFolder('person'));
  $('newProjectBtn').addEventListener('click',() => createFolder('project'));
  $('rootBtn').addEventListener('click',() => navigate(null));
  $('renameBtn').addEventListener('click',rename);
  $('copyBtn').addEventListener('click',() => copySelection('copy'));
  $('cutBtn').addEventListener('click',() => copySelection('cut'));
  $('pasteBtn').addEventListener('click',paste);
  $('moveBtn').addEventListener('click',() => transfer(selectedLogs().map(keyFor),$('moveProjectSelect').value,'cut'));
  $('moveProjectSelect').addEventListener('change',updateSelection);
  $('downloadBtn').addEventListener('click',downloadSelected);
  $('deleteBtn').addEventListener('click',deleteSelected);
  $('migrateBtn').addEventListener('click',migrateSelected);
  $('refreshBtn').addEventListener('click',() => action(refresh));
  $('searchInput').addEventListener('input',() => { selected.clear(); renderList(); });
  $('importBtn').addEventListener('click',() => $('importInput').click());
  $('importInput').addEventListener('change', async () => {
    const file = $('importInput').files[0]; $('importInput').value = '';
    if (file) { try { await importFile(file); } catch(error) { message(error.message,true); } }
  });
  document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click',() => {
    ascending = sortBy === button.dataset.sort ? !ascending : true; sortBy = button.dataset.sort; renderList();
  }));
  document.addEventListener('click',event => { if (!$('contextMenu').contains(event.target)) hideContext(); });
  document.addEventListener('keydown',event => {
    if (event.target.closest('input,textarea,select,[contenteditable="true"]') || busy) return;
    if (event.key === 'Escape') { selected.clear(); hideContext(); updateSelection(); return; }
    if (event.key === 'Enter' && selected.size === 1) {
      const item = visibleItems.find(entry => selected.has(keyFor(entry))); if (item) { event.preventDefault(); openItem(item); } return;
    }
    if (event.key === 'F2') { event.preventDefault(); rename(); return; }
    if (!event.metaKey && !event.ctrlKey) return;
    const key = event.key.toLowerCase();
    if (['c','x','v','a'].includes(key)) event.preventDefault();
    if (key === 'c') copySelection('copy');
    if (key === 'x') copySelection('cut');
    if (key === 'v') paste();
    if (key === 'a') { selected = new Set(visibleItems.map(keyFor)); updateSelection(); }
  });
  window.addEventListener('storage',event => { if (event.key === CLIPBOARD_KEY) { readClipboard(); updateSelection(); } });
  refresh().catch(error => message(error.message,true));
})();
