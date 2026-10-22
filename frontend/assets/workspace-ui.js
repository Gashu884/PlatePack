/* Progressive disclosure shared by the local PlatePack screens. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  const button = (label, action, help) => {
    const b = node('button', 'ui-button', label); b.type = 'button';
    b.onclick = action;
    if (help) b.dataset.help = help;
    return b;
  };
  function dialog(title) {
    const d = node('dialog', 'ui-dialog');
    const head = node('div', 'ui-dialog-head');
    const heading = node('h2', '', title); heading.id = 'ui-dialog-' + document.querySelectorAll('.ui-dialog').length;
    d.setAttribute('aria-labelledby', heading.id);
    head.append(heading, button('閉じる', () => d.close())); d.append(head); document.body.append(d);
    return d;
  }
  function menu(label, items) {
    const d = node('details', 'ui-menu'), s = node('summary', '', label), content = node('div', 'ui-menu-content');
    content.append(...items); d.append(s, content);
    d.addEventListener('toggle', () => { if (d.open) document.querySelectorAll('.ui-menu,.file-menu').forEach(other => { if (other !== d) other.open = false; }); });
    content.addEventListener('click', e => { if (e.target.closest('button,a')) { d.open = false; s.focus(); } });
    return d;
  }
  function tabs(host, definitions, onChange) {
    const bar = node('div', 'ui-tabs'); bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', '作業');
    let active;
    const buttons = definitions.map(([key, label, panel]) => {
      panel.id ||= 'ui-pane-' + key; panel.setAttribute('role', 'tabpanel');
      const b = button(label, () => activate(key)); b.id = 'ui-tab-' + key;
      b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', panel.id); panel.setAttribute('aria-labelledby', b.id);
      b.addEventListener('keydown', e => {
        const i = buttons.indexOf(b); let next;
        if (e.key === 'ArrowRight') next = (i + 1) % buttons.length;
        if (e.key === 'ArrowLeft') next = (i + buttons.length - 1) % buttons.length;
        if (e.key === 'Home') next = 0; if (e.key === 'End') next = buttons.length - 1;
        if (next !== undefined) { e.preventDefault(); e.stopPropagation(); buttons[next].click(); buttons[next].focus(); }
      });
      bar.append(b); return b;
    });
    function activate(key) {
      active = key;
      definitions.forEach(([id, , panel], i) => {
        const selected = id === key; panel.hidden = !selected;
        buttons[i].setAttribute('aria-selected', String(selected)); buttons[i].tabIndex = selected ? 0 : -1;
      });
      onChange?.(key);
      if (document.activeElement?.closest('[hidden]')) buttons[definitions.findIndex(([id]) => id === key)].focus();
      window.dispatchEvent(new Event('resize'));
    }
    host.append(bar); activate(definitions[0][0]);
    return {activate, get active() { return active; }};
  }
  const tips = {
    addImage:'TIFF / PNGを登録します。先に「実験」でプレートを選択してください。',
    emptyDemo:'TIFF / PNGからROIを自動検出します。',
    gelLinkBtn:'ROIを選び、対応するプレートのウェルを指定します。',
    measureAll:'現在の泳動画像の全ROIを測定します。マーカーとウェル対応の確認が必要です。',
    autoWidth:'明瞭なバンドの最大幅に左右2 pxを加え、全ROIに適用します。',
    redetect:'段数・列数に合わせてROIを再配置します。位置とベースラインは再設定されます。',
    calibrate:'選択中の段の最初と最後のバンドを順に指定します。番号は保持されます。',
    assignGroups:'元ウェルの順にチューブを割り当てます。再PCRは同じ検体として扱います。',
    reviewPlan:'1–20 µLで等量化できる最多の検体を選びます。分注量は0.1 µL刻みです。',
    placeMarker:'画像上で500 bpバンドの中心をクリックします。',
    resetBase:'上下の背景からベースラインを引き直します。',
    profile:'橙色の端点をドラッグして、ベースラインと積分範囲を編集します。',
    widthExcluded:'このバンドを共通ROI幅の基準候補から外します。',
    markerConfirmed:'500 bpの位置と積分範囲を確認したらチェックします。',
    saveExperiment:'元画像・ROI・対応・測定・プール計画をDatabaseに保存します。',
    saveLogBtn:'プレート配置をDBに保存し、JSONバックアップも出力します。',
    packLayoutBtn:'選択したウェルを出力レイアウトへ配置します。',
    inputDirectionBtn:'入力ウェルを読み取る順序を切り替えます。',
    directionBtn:'出力ウェルへ配置する順序を切り替えます。',
    wellLabelBtn:'A1 / 1Aの表記を切り替えます。',
    clearPlateBtn:'現在の入力プレートの選択を解除します。',
    layoutClearBtn:'空ウェルと区切り線の設定を解除します。',
    newProjectBtn:'現在のメンバーにプロジェクトを作成します。',
    importBtn:'JSONの記録を現在のプロジェクトへ読み込みます。',
    migrateBtn:'ブラウザだけにある記録をDBへ移します。',
  };
  for (const [id, text] of Object.entries(tips)) if ($(id)) $(id).dataset.help = text;

  function electrophoresis() {
    document.body.classList.add('ui-electro');
    const header = document.querySelector('.top-actions');
    const registration = dialog('実験'); registration.classList.add('ui-registration');
    const exp = document.querySelector('.experiment-bar');
    const registrationFields = exp.querySelector('.experiment-fields');
    const status = $('recordStatus');
    header.prepend(button('実験', () => registration.showModal(), 'プロジェクト・プレート・実験名を指定します。'), $('saveExperiment'));
    registration.append(registrationFields);
    const registrationStatus = node('p','ui-status'); registrationStatus.setAttribute('role','status'); registration.append(registrationStatus);
    const statusObserver = new MutationObserver(() => { registrationStatus.textContent = status.textContent; });
    statusObserver.observe(status,{childList:true,subtree:true,characterData:true});
    // Status and recovery action remain visible even when the registration dialog is closed.
    const statusLine = node('div','ui-status'); statusLine.append(status); exp.before(statusLine);
    const settings = document.querySelector('.settings');
    const settingsDialog = dialog('ROI設定'); settingsDialog.append(settings);
    const poolSettings = $('poolMin').closest('details');
    const imageInfo = $('source').closest('details');
    registration.append(imageInfo);
    const toolbar = node('div', 'ui-toolbar');
    const setupButton = button('ROI設定', () => settingsDialog.showModal(), '段数、ROIのサイズ、検出条件を変更します。');
    const editButton = button('バンド編集', () => openInspector(), '選択したROIのピークとベースラインを編集します。');
    const roiActions = node('div', 'ui-toolbar-group'); roiActions.append(setupButton, $('gelLinkBtn'), editButton, $('gelLinkSummary'));
    const imageActions = node('div','ui-toolbar-group'); imageActions.append($('runSelect').parentElement, $('addImage'));
    toolbar.append(imageActions, roiActions);
    const work = document.querySelector('.workspace'), main = work.querySelector('main');
    const gel = main.querySelector('.gel-panel'), results = main.querySelector('.results-panel'), metrics = main.querySelector('.metrics');
    const poolExport = $('exportPool');
    const panes = ['image','roi','measure','pool'].map(key => node('section','ui-pane ui-pane-'+key));
    const measureActions = node('div','ui-toolbar'); measureActions.append($('measureAll'), $('measurementStatus'));
    panes[2].append(measureActions, metrics, results);
    const poolActions = node('section','panel ui-pool-card');
    poolActions.append(node('h2','','プール'), $('groupSize').parentElement, $('assignGroups'), $('reviewPlan'), poolExport, poolSettings);
    panes[3].append(poolActions);
    main.append(...panes);
    const inspector = document.querySelector('.inspector'); inspector.hidden = true; inspector.classList.add('ui-inspector');
    inspector.setAttribute('aria-label','バンド編集');
    const close = button('閉じる', () => { inspector.hidden = true; editButton.focus(); }); inspector.prepend(close);
    function openInspector() { if ($('gel').hidden) return; inspector.hidden = false; }
    const barHost = node('nav','ui-work-nav'); exp.replaceWith(barHost, toolbar);
    const view = tabs(barHost, [['image','画像',panes[0]],['roi','ROI',panes[1]],['measure','測定',panes[2]],['pool','プール',panes[3]]], key => {
      inspector.hidden = true;
      toolbar.hidden = key === 'pool'; roiActions.hidden = key !== 'roi';
      if (key === 'image' || key === 'roi') panes[key === 'image' ? 0 : 1].append(gel);
      document.querySelector('.marker-toolbar').hidden = key !== 'roi';
      $('widthBadge').hidden = key !== 'roi';
    });
    const edit = () => { if (view.active === 'image') view.activate('roi'); openInspector(); };
    // Allow canvas gestures to finish before exposing a panel, without resizing the canvas.
    let pendingInspector = false;
    document.addEventListener('pointerup', () => { if (pendingInspector) { pendingInspector = false; edit(); } });
    document.addEventListener('platepack:roi-picked', () => { pendingInspector = true; });
    $('tbody').addEventListener('click', () => openInspector());
    $('markerRow').addEventListener('change', () => openInspector());
    $('showWidthBasis').addEventListener('click', () => { settingsDialog.close(); edit(); });
    $('calibrate').addEventListener('click', () => settingsDialog.close());
    $('toggleSettings').hidden = true;
    // A narrow screen can expose the inspector without blocking the selected image completely.
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) inspector.hidden = true; });
    window.PlatePackUI = {view: view.activate, openInspector};
  }
  function packer() {
    document.body.classList.add('ui-packer');
    const layout = document.querySelector('#view-plates .layout');
    const inputPanel = layout.querySelector('.panel'), outputPanel = layout.querySelectorAll('.panel')[1];
    const input = node('section','ui-pane'), arrangement = node('section','ui-pane');
    input.append(inputPanel.querySelector('.toolbar'), $('plateSummary'), inputPanel.querySelector('.split-input'));
    arrangement.append(inputPanel.querySelector('.split-output'));
    inputPanel.querySelector('.io-splits').remove();
    inputPanel.querySelectorAll(':scope > .split-gap, :scope > .title-row').forEach(el => el.remove());
    input.querySelector('.layout-controls').remove();
    arrangement.querySelector('.layout-controls .label').parentElement.remove();
    arrangement.querySelectorAll('.split-gap').forEach(el => el.remove());
    inputPanel.append(input, arrangement);
    const head = document.querySelector('#view-plates header'), actions = node('div','ui-toolbar');
    const save = dialog('保存'); save.append(document.querySelector('.save-target'), $('saveLogBtn'));
    const saveStatus = node('p','ui-status'); saveStatus.setAttribute('role','status'); save.append(saveStatus);
    const updateSaveStatus = () => { saveStatus.textContent = [$('storageNotice').textContent,$('status').textContent].filter(Boolean).join(' '); };
    for (const id of ['storageNotice','status']) new MutationObserver(updateSaveStatus).observe($(id),{childList:true,subtree:true,characterData:true});
    updateSaveStatus();
    const exports = menu('ファイル',[$('tsvBtn'),$('pngBtn'),$('backupJsonBtn'),$('restoreJsonBtn')]);
    actions.append(button('保存',()=>save.showModal(),'保存先プロジェクトを選んでDBへ保存します。'),exports,$('logsLink'));
    head.append(actions);
    const bar = node('nav','ui-work-nav');layout.before(bar);
    const view = tabs(bar,[['input','入力',input],['layout','配置',arrangement],['output','結果',outputPanel]],key=>{inputPanel.hidden=key==='output';});
    const next = button('配置へ →',()=>view.activate('layout'),'出力先の空ウェルと区切りを設定します。');input.append(next);
    const memo = document.querySelector('.memo-below'), memoDetails = node('details','ui-fold');memo.before(memoDetails);memoDetails.append(node('summary','','メモ'),memo);
    const status = node('div','ui-status');status.append($('draftSaveStatus'),$('storageNotice'),$('status'));bar.after(status);
    window.addEventListener('platepack:packed',()=>view.activate('output'));
  }
  function database() {
    document.body.classList.add('ui-database');
    const toolbar=document.querySelector('.toolbar'), move=document.querySelector('.movebar');
    const actionMenu=menu('操作',[$('renameBtn'),$('copyBtn'),$('cutBtn'),$('pasteBtn'),$('downloadBtn'),$('migrateBtn'),$('deleteBtn'),move]);
    toolbar.replaceChildren($('newProjectBtn'),$('importBtn'),$('importInput'),actionMenu);
  }
  if ($('imageTitle')) electrophoresis();
  else if ($('view-plates')) packer();
  else if ($('view-logs')) database();

  // One lightweight tooltip, available with a pointer and keyboard focus.
  const tip = node('div','ui-tooltip'); tip.id='ui-tooltip'; tip.setAttribute('role','tooltip'); tip.hidden=true; document.body.append(tip);
  let anchor, timer;
  function hide() { clearTimeout(timer); if(anchor) { const ids=(anchor.getAttribute('aria-describedby')||'').split(' ').filter(id=>id&&id!==tip.id); if(ids.length)anchor.setAttribute('aria-describedby',ids.join(' '));else anchor.removeAttribute('aria-describedby'); } tip.hidden=true;anchor=null; }
  function show(el) {
    if(!el||el===anchor)return; hide();anchor=el;
    (el.closest('dialog') || document.body).append(tip);
    tip.textContent=el.dataset.help;tip.hidden=false;
    el.setAttribute('aria-describedby', [el.getAttribute('aria-describedby'),tip.id].filter(Boolean).join(' '));
    const r=el.getBoundingClientRect(),t=tip.getBoundingClientRect();
    tip.style.left=Math.max(8,Math.min(r.left,innerWidth-t.width-8))+'px';
    tip.style.top=(r.bottom+t.height+12<innerHeight?r.bottom+8:Math.max(8,r.top-t.height-8))+'px';
  }
  document.addEventListener('pointerover',e=>{const el=e.target.closest('[data-help]');if(el)show(el);});
  document.addEventListener('pointerout',e=>{if(anchor&&!anchor.contains(e.relatedTarget)&&!tip.contains(e.relatedTarget))timer=setTimeout(hide,180);});
  tip.addEventListener('pointerenter',()=>clearTimeout(timer));tip.addEventListener('pointerleave',hide);
  document.addEventListener('focusin',e=>show(e.target.closest('[data-help]')));
  document.addEventListener('focusout',hide);
  document.addEventListener('click',hide);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){hide();document.querySelectorAll('.ui-menu,.file-menu').forEach(d=>d.open=false);}});
  document.addEventListener('pointerdown',e=>{hide();document.querySelectorAll('.ui-menu,.file-menu').forEach(d=>{if(!d.contains(e.target))d.open=false;});});
  window.addEventListener('scroll',hide,true);
})();
