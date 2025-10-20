// ===== Utilities (well labels) =====
const wellRe = /^([A-Za-z]+)(\d+)$/;

function lettersToIndex(s) {
  s = s.toUpperCase();
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function indexToLetters(i) {
  i += 1;
  const out = [];
  while (i) {
    const r = (i - 1) % 26;
    out.unshift(String.fromCharCode(65 + r));
    i = Math.floor((i - 1) / 26);
  }
  return out.join("");
}
function parseWell(label) {
  const m = (label || "").trim().match(wellRe);
  if (!m) throw new Error(`Invalid well: ${label}`);
  return [lettersToIndex(m[1]), parseInt(m[2], 10) - 1];
}
function wellLabel(r, c) { return `${indexToLetters(r)}${c + 1}`; }

function orderIndices(rows, cols, direction) {
  const arr = [];
  if (direction === "row") {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) arr.push([r, c]);
  } else {
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) arr.push([r, c]);
  }
  return arr;
}
function sortWells(wells, order) {
  if (order === "given") return wells.slice();
  return wells
    .map(w => ({ w, rc: parseWell(w) }))
    .sort((a, b) => order === "row"
      ? (a.rc[0] - b.rc[0] || a.rc[1] - b.rc[1])
      : (a.rc[1] - b.rc[1] || a.rc[0] - b.rc[0]))
    .map(x => x.w);
}

// ===== State =====
const palette = [
  "#4472C4","#ED7D31","#A5A5A5","#FFC000","#5B9BD5",
  "#70AD47","#264478","#9E480E","#636363","#997300",
  "#255E91","#43682B","#7030A0","#C00000","#00B0F0",
  "#92D050","#7F7F7F","#FFD966","#2F5597","#B85450"
];

let sources = []; // [{rows,cols, color, selectedSet:Set, selectedList:[]}]
let current = 0;
const el = sel => document.querySelector(sel);
const els = sel => Array.from(document.querySelectorAll(sel));

function createSource(i, rows=8, cols=12) {
  return {
    rows, cols,
    color: palette[i % palette.length],
    selectedSet: new Set(),
    selectedList: [] // only used when order = given
  };
}

// ===== UI bindings =====
const numSources = el('#numSources');
const sourceOrder = el('#sourceOrder');
const srcRows = el('#srcRows');
const srcCols = el('#srcCols');
const applyGrid = el('#applyGrid');
const clearSelection = el('#clearSelection');
const prevPlate = el('#prevPlate');
const nextPlate = el('#nextPlate');
const plateTitle = el('#plateTitle');
const grid = el('#grid');
const legend = el('#legend');

const destRows = el('#destRows');
const destCols = el('#destCols');
const fillDir = el('#fillDir');
const startWell = el('#startWell');
const annotate = el('#annotate');

const packRow = el('#packRow');
const packCol = el('#packCol');
const saveTSV = el('#saveTSV');
const savePNG = el('#savePNG');
const destArea = el('#destArea');

// ===== Init =====
function init() {
  // default: 1 plate
  sources = [createSource(0)];
  numSources.value = 1;
  current = 0;
  renderLegend();
  renderCurrentPlate();
}
document.addEventListener('DOMContentLoaded', init);

// ===== Source plates management =====
numSources.addEventListener('change', () => {
  const n = Math.max(1, parseInt(numSources.value, 10) || 1);
  while (sources.length < n) sources.push(createSource(sources.length));
  while (sources.length > n) sources.pop();
  if (current >= n) current = n - 1;
  renderLegend();
  renderCurrentPlate();
});

prevPlate.addEventListener('click', () => {
  current = (current - 1 + sources.length) % sources.length;
  renderCurrentPlate();
});
nextPlate.addEventListener('click', () => {
  current = (current + 1) % sources.length;
  renderCurrentPlate();
});

applyGrid.addEventListener('click', () => {
  const s = sources[current];
  s.rows = Math.max(1, Math.min(26, parseInt(srcRows.value, 10) || 8));
  s.cols = Math.max(1, parseInt(srcCols.value, 10) || 12);
  // 既存選択は範囲外ならクリア
  s.selectedList = s.selectedList.filter(w => {
    try {
      const [r,c] = parseWell(w);
      return r < s.rows && c < s.cols;
    } catch { return false; }
  });
  s.selectedSet = new Set(s.selectedList);
  renderCurrentPlate();
});

clearSelection.addEventListener('click', () => {
  const s = sources[current];
  s.selectedSet.clear();
  s.selectedList = [];
  renderCurrentPlate();
});

// ===== Render source plate grid =====
function renderLegend() {
  legend.innerHTML = sources.map((s, i) => `
    <span class="item"><span class="sw" style="background:${s.color}"></span>Plate ${i+1}</span>
  `).join('');
}

function renderCurrentPlate() {
  const s = sources[current];
  plateTitle.textContent = `Plate ${current+1} of ${sources.length}`;
  srcRows.value = s.rows;
  srcCols.value = s.cols;

  // build grid (labels + wells)
  grid.style.gridTemplateColumns = `repeat(${s.cols + 1}, 44px)`;
  grid.innerHTML = '';

  // header corner
  const empty = document.createElement('div'); empty.className = 'labels'; empty.textContent = '';
  grid.appendChild(empty);

  // column labels
  for (let c=0; c<s.cols; c++) {
    const d = document.createElement('div'); d.className = 'labels';
    d.textContent = String(c+1);
    d.style.justifyContent = 'center';
    grid.appendChild(d);
  }

  for (let r=0; r<s.rows; r++) {
    // row label
    const rl = document.createElement('div'); rl.className = 'labels'; rl.textContent = indexToLetters(r);
    rl.style.alignItems = 'center';
    grid.appendChild(rl);

    for (let c=0; c<s.cols; c++) {
      const w = document.createElement('div');
      w.className = 'well';
      const label = wellLabel(r,c);
      w.textContent = label;
      if (s.selectedSet.has(label)) w.classList.add('selected');
      w.addEventListener('click', () => {
        if (s.selectedSet.has(label)) {
          s.selectedSet.delete(label);
          s.selectedList = s.selectedList.filter(x => x !== label);
          w.classList.remove('selected');
        } else {
          s.selectedSet.add(label);
          s.selectedList.push(label);
          w.classList.add('selected');
        }
      });
      grid.appendChild(w);
    }
  }
}

// ===== Packing logic (client-side) =====
function computePack() {
  const dRows = Math.max(1, Math.min(26, parseInt(destRows.value, 10) || 8));
  const dCols = Math.max(1, parseInt(destCols.value, 10) || 12);
  let start = startWell.value || 'A1';
  try {
    const [r,c] = parseWell(start);
    if (r >= dRows || c >= dCols) throw new Error();
  } catch {
    alert(`Start Well が不正です: ${start}`);
    return null;
  }
  const fill = fillDir.value; // 'row' | 'column'
  const ann = annotate.value; // annotate mode
  const sOrder = sourceOrder.value; // 'row' | 'column' | 'given'

  // flatten sources
  const flat = [];
  sources.forEach((s, i) => {
    const wells = (sOrder === 'given')
      ? s.selectedList.slice()
      : sortWells(Array.from(s.selectedSet), sOrder);
    wells.forEach(w => flat.push({ plate: `Plate ${i+1}`, well: w, color: s.color }));
  });

  // sequences
  const seqFirst = (() => {
    const seq = orderIndices(dRows, dCols, fill);
    const rc = parseWell(start);
    const idx = seq.findIndex(x => x[0] === rc[0] && x[1] === rc[1]);
    return seq.slice(idx);
  })();
  const seqFull = orderIndices(dRows, dCols, fill);

  const plates = [];
  const mapping = [];
  let i = 0, plateIdx = 1;

  function pushToPlate(pi, rc, src) {
    const well = wellLabel(rc[0], rc[1]);
    mapping.push({ dest_plate_index: pi, dest_well: well, source_plate: src.plate, source_well: src.well });
    if (!plates[pi-1]) plates[pi-1] = { plate_index: pi, rows: dRows, cols: dCols, wells: {} };
    const label =
      ann === 'both' ? `${src.plate}:${src.well}` :
      ann === 'source_plate' ? src.plate :
      ann === 'source_well' ? src.well : '';
    plates[pi-1].wells[well] = { color: src.color, label };
  }

  // 1st plate
  for (const rc of seqFirst) { if (i >= flat.length) break; pushToPlate(1, rc, flat[i++]); }
  // more plates
  while (i < flat.length) {
    plateIdx += 1;
    for (const rc of seqFull) { if (i >= flat.length) break; pushToPlate(plateIdx, rc, flat[i++]); }
  }

  return { plates: plates || [], mapping, stats: { total_picked: flat.length, dest_plates: plates.length } };
}

// ===== Canvas drawing & export =====
function drawPlateCanvas(plate, cell=48, mx=90, my=80) {
  const rows = plate.rows, cols = plate.cols;
  const w = mx*2 + cols*cell;
  const h = my*2 + rows*cell;
  const cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,w,h);
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1;

  // headers
  ctx.fillStyle = '#111'; ctx.font = '16px system-ui, sans-serif';
  for (let c=0; c<cols; c++) {
    const x = mx + c*cell + cell/2;
    ctx.fillText(String(c+1), x-6, my-28);
  }
  for (let r=0; r<rows; r++) {
    const y = my + r*cell + cell/2;
    ctx.fillText(indexToLetters(r), mx-50, y-8);
  }

  const wells = plate.wells;
  const rad = Math.floor(cell*0.32);

  for (let r=0; r<rows; r++) {
    for (let c=0; c<cols; c++) {
      const cx = mx + c*cell + cell/2;
      const cy = my + r*cell + cell/2;
      const wl = wellLabel(r,c);
      const info = wells[wl];

      // circle
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI*2);
      if (info) {
        ctx.fillStyle = info.color; ctx.fill();
        ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
        if (info.label) {
          ctx.fillStyle = '#111';
          ctx.font = '12px system-ui, sans-serif';
          const tw = ctx.measureText(info.label).width;
          ctx.fillText(info.label, cx - tw/2, cy + 4);
        }
      } else {
        ctx.fillStyle = '#f2f2f2'; ctx.fill();
        ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1; ctx.stroke();
      }
    }
  }

  ctx.fillStyle = '#111'; ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.fillText(`Plate ${plate.plate_index} (${rows} x ${cols})`, mx, 28);
  return cvs;
}

function renderDest(result) {
  destArea.innerHTML = '';
  if (!result || result.plates.length === 0) {
    destArea.innerHTML = '<p>詰め替え結果はまだありません。</p>';
    return;
  }
  result.plates.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'canvas-card';
    const h = document.createElement('h3');
    h.textContent = `Destination Plate ${p.plate_index}`;
    const canvas = drawPlateCanvas(p);
    card.appendChild(h);
    card.appendChild(canvas);
    destArea.appendChild(card);
  });
}

function download(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

// ===== Buttons =====
packRow.addEventListener('click', () => {
  fillDir.value = 'row';
  const r = computePack();
  renderDest(r);
  packRow.blur();
});
packCol.addEventListener('click', () => {
  fillDir.value = 'column';
  const r = computePack();
  renderDest(r);
  packCol.blur();
});

saveTSV.addEventListener('click', () => {
  const r = computePack();
  if (!r) return;
  const lines = ["dest_plate\tdest_well\tsource_plate\tsource_well"];
  r.mapping.forEach(m => lines.push(`${m.dest_plate_index}\t${m.dest_well}\t${m.source_plate}\t${m.source_well}`));
  download("packing.tsv", new Blob([lines.join("\n")], { type: "text/tab-separated-values" }));
});

savePNG.addEventListener('click', () => {
  const r = computePack();
  if (!r) return;
  // 合成キャンバス（1列に並べる）
  const canvases = r.plates.map(p => drawPlateCanvas(p));
  const w = canvases[0].width, h = canvases[0].height * canvases.length;
  const combo = document.createElement('canvas');
  combo.width = w; combo.height = h;
  const ctx = combo.getContext('2d');
  canvases.forEach((cv, i) => ctx.drawImage(cv, 0, i*cv.height));
  combo.toBlob(blob => download('plate_layout.png', blob), 'image/png');
});
