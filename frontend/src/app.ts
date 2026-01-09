const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"];
      const COLS = Array.from({ length: 12 }, (_, i) => i + 1);
      const API_ENDPOINT = "/generate-html";

      let plates = [createPlate(1)];
      let currentPlateIndex = 0;
      let packedPlates = [];
      let currentPackedIndex = 0;
      let sourceColorMap = new Map();
      let layoutDirection = "row";
      let inputReadDirection = "row";
      let blockedLayoutWells = new Set();
      let verticalDividers = new Set();
      let horizontalDividers = new Set();

      const plateCountSelect = document.getElementById("plateCount");
      const plateSummary = document.getElementById("plateSummary");
      const plateTitle = document.getElementById("plateTitle");
      const columnHeader = document.getElementById("columnHeader");
      const wellGrid = document.getElementById("wellGrid");
      const prevPlateBtn = document.getElementById("prevPlateBtn");
      const nextPlateBtn = document.getElementById("nextPlateBtn");
      const clearPlateBtn = document.getElementById("clearPlateBtn");
      const packLayoutBtn = document.getElementById("packLayoutBtn");
      const statusEl = document.getElementById("status");
      const packedSummary = document.getElementById("packedSummary");
      const packedGrid = document.getElementById("packedGrid");
      const prevPackedBtn = document.getElementById("prevPackedBtn");
      const nextPackedBtn = document.getElementById("nextPackedBtn");
      const tsvBtn = document.getElementById("tsvBtn");
      const pngBtn = document.getElementById("pngBtn");
      const saveLogBtn = document.getElementById("saveLogBtn");
      const plateMemoInput = document.getElementById("plateMemo");
      const layoutContainer = document.getElementById("layoutContainer");
      const layoutGrid = document.getElementById("layoutGrid");
      const directionBtn = document.getElementById("directionBtn");
      const inputDirectionBtn = document.getElementById("inputDirectionBtn");
      const layoutClearBtn = document.getElementById("layoutClearBtn");
      const wellLabelBtn = document.getElementById("wellLabelBtn");

      let wellLabelMode = "colRow"; // "colRow" => 1A, "rowCol" => A1

      function createPlate(index) {
        return { label: `Plate ${index}`, wells: new Set(), memo: "" };
      }

      function getCurrentPlate() {
        return plates[currentPlateIndex];
      }

      function parseWell(well) {
        const match = well.match(/^([A-H])(\d{1,2})$/);
        if (!match) return null;
        return { row: match[1], col: Number(match[2]) };
      }

      function formatWellLabel(well) {
        const parsed = parseWell(well);
        if (!parsed) return well;
        return wellLabelMode === "rowCol" ? `${parsed.row}${parsed.col}` : `${parsed.col}${parsed.row}`;
      }

      function resizePlateCount(count) {
        if (count > plates.length) {
          const len = plates.length;
          for (let i = len; i < count; i += 1) {
            plates.push(createPlate(i + 1));
          }
        } else if (count < plates.length) {
          plates = plates.slice(0, count);
          currentPlateIndex = Math.min(currentPlateIndex, plates.length - 1);
        }
        renderPlate();
      }

      function ensurePlateOption(value) {
        const valueStr = String(value);
        const options = Array.from(plateCountSelect.options);
        if (options.some((option) => option.value === valueStr)) return;
        const option = document.createElement("option");
        option.value = valueStr;
        option.textContent = valueStr;
        const customOption = plateCountSelect.querySelector('option[value="custom"]');
        plateCountSelect.insertBefore(option, customOption);
      }

      function renderGridStructure() {
        columnHeader.innerHTML = "";
        const corner = document.createElement("div");
        corner.className = "corner-cell";
        columnHeader.appendChild(corner);
        COLS.forEach((col) => {
          const colBtn = document.createElement("button");
          colBtn.type = "button";
          colBtn.className = "header-btn";
          colBtn.textContent = col;
          colBtn.addEventListener("click", () => toggleColumn(col));
          columnHeader.appendChild(colBtn);
        });

        wellGrid.innerHTML = "";
        ROWS.forEach((row) => {
          const rowDiv = document.createElement("div");
          rowDiv.className = "well-row";
          const rowBtn = document.createElement("button");
          rowBtn.type = "button";
          rowBtn.className = "header-btn row";
          rowBtn.textContent = row;
          rowBtn.addEventListener("click", () => toggleRow(row));
          rowDiv.appendChild(rowBtn);

          COLS.forEach((col) => {
            const wellId = `${row}${col}`;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "well-btn";
            btn.dataset.well = wellId;
            btn.textContent = formatWellLabel(wellId);
            btn.addEventListener("click", () => toggleWell(wellId));
            rowDiv.appendChild(btn);
          });

          wellGrid.appendChild(rowDiv);
        });

        // set memo/input width
        const dims = inputDimensions();
        document.documentElement.style.setProperty(
          "--input-grid-width",
          `${dims.header + COLS.length * dims.cell + (COLS.length - 1) * dims.gap}px`
        );
      }

      function toggleDirection() {
        layoutDirection = layoutDirection === "row" ? "column" : "row";
        updateLayoutButtons();
      }

      function toggleInputDirection() {
        inputReadDirection = inputReadDirection === "row" ? "column" : "row";
        updateLayoutButtons();
      }

      function updateLayoutButtons() {
        if (directionBtn) {
          directionBtn.textContent = layoutDirection === "row" ? "整列方向：→" : "整列方向：↓";
        }
        if (inputDirectionBtn) {
          inputDirectionBtn.textContent = inputReadDirection === "row" ? "読み方向：→" : "読み方向：↓";
        }
        if (wellLabelBtn) {
          wellLabelBtn.textContent = wellLabelMode === "rowCol" ? "A1" : "1A";
        }
      }

      function toggleWellLabelMode() {
        wellLabelMode = wellLabelMode === "rowCol" ? "colRow" : "rowCol";
        updateLayoutButtons();
        renderGridStructure();
        renderPlate();
        renderPacked();
      }

      function clearLayoutSettings() {
        blockedLayoutWells.clear();
        verticalDividers.clear();
        horizontalDividers.clear();
        renderLayoutGrid();
      }

      function layoutDimensions() {
        const root = getComputedStyle(document.documentElement);
        const baseCell = parseFloat(root.getPropertyValue("--cell-size")) || 62;
        const baseGap = parseFloat(root.getPropertyValue("--gap")) || 4;
        const baseHeader =
          parseFloat(root.getPropertyValue("--layout-header-size")) ||
          parseFloat(root.getPropertyValue("--row-header")) ||
          20;
        const scale = parseFloat(root.getPropertyValue("--layout-scale")) || 0.5;
        const cell = baseCell * scale;
        const gap = baseGap * scale;
        const header = baseHeader * scale;
        const width = header + 12 * cell + 11 * gap;
        const height = header + 8 * cell + 7 * gap;
        return { cell, gap, header, width, height };
      }

      function inputDimensions() {
        const root = getComputedStyle(document.documentElement);
        const cell = parseFloat(root.getPropertyValue("--cell-size")) || 62;
        const gap = parseFloat(root.getPropertyValue("--gap")) || 4;
        const header = parseFloat(root.getPropertyValue("--row-header")) || 20;
        const width = header + 12 * cell + 11 * gap;
        const height = header + 8 * cell + 7 * gap;
        return { cell, gap, header, width, height };
      }

      function wellPosition(rowIndex, colIndex, dims) {
        const left = dims.header + colIndex * (dims.cell + dims.gap);
        const top = dims.header + rowIndex * (dims.cell + dims.gap);
        return { left, top };
      }

      function renderLayoutGrid() {
        if (!layoutContainer || !layoutGrid) return;
        layoutContainer.style.position = "relative";
        layoutGrid.innerHTML = "";
        verticalDividers = new Set(verticalDividers);
        horizontalDividers = new Set(horizontalDividers);
        const dims = layoutDimensions();
        const containerStyles = getComputedStyle(layoutContainer);
        const padLeft = parseFloat(containerStyles.paddingLeft) || 0;
        const padRight = parseFloat(containerStyles.paddingRight) || 0;
        const padTop = parseFloat(containerStyles.paddingTop) || 0;
        const padBottom = parseFloat(containerStyles.paddingBottom) || 0;
        layoutContainer.style.width = `${dims.width + padLeft + padRight}px`;
        layoutContainer.style.height = `${dims.height + padTop + padBottom}px`;
        layoutGrid.style.position = "relative";
        layoutGrid.style.width = `${dims.width}px`;
        layoutGrid.style.height = `${dims.height}px`;

        // headers and cells
        const frag = document.createDocumentFragment();
        // corner
        const corner = document.createElement("div");
        corner.className = "layout-header";
        corner.style.width = `${dims.header}px`;
        corner.style.height = `${dims.header}px`;
        corner.style.left = "0px";
        corner.style.top = "0px";
        frag.appendChild(corner);

        // column headers
        COLS.forEach((col, colIndex) => {
          const header = document.createElement("div");
          header.className = "layout-header clickable";
          header.textContent = col;
          header.dataset.colIndex = String(colIndex);
          header.title = `Toggle column ${col}`;
          header.style.width = `${dims.cell}px`;
          header.style.height = `${dims.header}px`;
          const { left } = wellPosition(0, colIndex, dims);
          header.style.left = `${left}px`;
          header.style.top = "0px";
          header.addEventListener("click", () => toggleLayoutColumn(colIndex));
          frag.appendChild(header);
        });

        // row headers + cells
        ROWS.forEach((row, rowIndex) => {
          const rowHeader = document.createElement("div");
          rowHeader.className = "layout-header clickable";
          rowHeader.textContent = row;
          rowHeader.dataset.rowIndex = String(rowIndex);
          rowHeader.title = `Toggle row ${row}`;
          rowHeader.style.width = `${dims.header}px`;
          rowHeader.style.height = `${dims.cell}px`;
          const { top } = wellPosition(rowIndex, 0, dims);
          rowHeader.style.left = "0px";
          rowHeader.style.top = `${top}px`;
          rowHeader.addEventListener("click", () => toggleLayoutRow(rowIndex));
          frag.appendChild(rowHeader);

	          COLS.forEach((col, colIndex) => {
	            const cell = document.createElement("button");
	            cell.type = "button";
	            cell.className = "layout-cell layout-well-btn";
	            const { left, top: cellTop } = wellPosition(rowIndex, colIndex, dims);
	            cell.style.width = `${dims.cell}px`;
	            cell.style.height = `${dims.cell}px`;
	            cell.style.left = `${left}px`;
            cell.style.top = `${cellTop}px`;
            const wellId = `${row}${col}`;
            cell.dataset.well = wellId;
            if (blockedLayoutWells.has(wellId)) {
              cell.classList.add("selected");
            }
            cell.addEventListener("click", () => {
              if (blockedLayoutWells.has(wellId)) blockedLayoutWells.delete(wellId);
              else blockedLayoutWells.add(wellId);
              renderLayoutGrid();
            });
            frag.appendChild(cell);
          });
        });

        layoutGrid.appendChild(frag);
        renderDividers(dims);
        updateLayoutHeaderSelection();
      }

      function renderDividers(dims) {
        // remove previous divider buttons
        Array.from(layoutGrid.querySelectorAll(".divider-btn")).forEach((el) => el.remove());
        // vertical
        for (let i = 1; i <= 11; i += 1) {
          const btn = document.createElement("div");
          btn.className = "divider-btn vertical";
          if (verticalDividers.has(i)) btn.classList.add("active");
          // place vertical divider only across the cell body (not the top header row)
          btn.style.top = `${dims.header}px`;
          btn.style.height = `${Math.max(0, dims.height - dims.header)}px`;
          btn.style.left = `${dims.header + i * dims.cell + (i - 1) * dims.gap + dims.gap / 2 - 3}px`;
          btn.title = `列 ${i}/${i + 1} の間`;
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (verticalDividers.has(i)) verticalDividers.delete(i);
            else verticalDividers.add(i);
            renderLayoutGrid();
          });
          layoutGrid.appendChild(btn);
        }
        // horizontal
        for (let j = 1; j <= 7; j += 1) {
          const btn = document.createElement("div");
          btn.className = "divider-btn horizontal";
          if (horizontalDividers.has(j)) btn.classList.add("active");
          // place horizontal divider only across the cell body (not the left header column)
          btn.style.left = `${dims.header}px`;
          btn.style.width = `${Math.max(0, dims.width - dims.header)}px`;
          btn.style.top = `${dims.header + j * dims.cell + (j - 1) * dims.gap + dims.gap / 2 - 3}px`;
          btn.title = `行 ${ROWS[j - 1]}/${ROWS[j]} の間`;
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (horizontalDividers.has(j)) horizontalDividers.delete(j);
            else horizontalDividers.add(j);
            renderLayoutGrid();
          });
          layoutGrid.appendChild(btn);
        }
      }

      function toggleLayoutColumn(colIndex) {
        const col = COLS[colIndex];
        const allBlocked = ROWS.every((row) => blockedLayoutWells.has(`${row}${col}`));
        ROWS.forEach((row) => {
          const well = `${row}${col}`;
          if (allBlocked) blockedLayoutWells.delete(well);
          else blockedLayoutWells.add(well);
        });
        renderLayoutGrid();
      }

      function toggleLayoutRow(rowIndex) {
        const row = ROWS[rowIndex];
        const allBlocked = COLS.every((col) => blockedLayoutWells.has(`${row}${col}`));
        COLS.forEach((col) => {
          const well = `${row}${col}`;
          if (allBlocked) blockedLayoutWells.delete(well);
          else blockedLayoutWells.add(well);
        });
        renderLayoutGrid();
      }

      function updateLayoutHeaderSelection() {
        // columns
        Array.from(layoutGrid.querySelectorAll(".layout-header[data-col-index]")).forEach((el) => {
          const idx = Number(el.dataset.colIndex);
          const col = COLS[idx];
          const allBlocked = ROWS.every((row) => blockedLayoutWells.has(`${row}${col}`));
          el.classList.toggle("selected", allBlocked);
        });
        // rows
        Array.from(layoutGrid.querySelectorAll(".layout-header[data-row-index]")).forEach((el) => {
          const idx = Number(el.dataset.rowIndex);
          const row = ROWS[idx];
          const allBlocked = COLS.every((col) => blockedLayoutWells.has(`${row}${col}`));
          el.classList.toggle("selected", allBlocked);
        });
      }

      function updateWellButtons() {
        const plate = getCurrentPlate();
        (wellGrid ? wellGrid.querySelectorAll(".well-btn") : []).forEach((btn) => {
          const well = btn.dataset.well;
          if (plate.wells.has(well)) {
            btn.classList.add("selected");
          } else {
            btn.classList.remove("selected");
          }
        });
      }

      function renderPlate() {
        const plate = getCurrentPlate();
        plateTitle.textContent = plate.label;
        plateSummary.innerHTML = `<span class="plate-highlight">${plate.label}</span> — ${plate.wells.size} wells selected · Plate ${
          currentPlateIndex + 1
        } of ${plates.length}`;
        if (plateMemoInput) {
          plateMemoInput.value = plate.memo || "";
        }
        updateWellButtons();
      }

      function toggleWell(well) {
        const plate = getCurrentPlate();
        if (plate.wells.has(well)) {
          plate.wells.delete(well);
        } else {
          plate.wells.add(well);
        }
        renderPlate();
      }

      function clearPlate() {
        getCurrentPlate().wells.clear();
        renderPlate();
      }

      function toggleRow(letter) {
        const upper = String(letter).trim().toUpperCase();
        if (!ROWS.includes(upper)) return;
        const plate = getCurrentPlate();
        const wells = COLS.map((col) => `${upper}${col}`);
        const allSelected = wells.every((well) => plate.wells.has(well));
        wells.forEach((well) => {
          if (allSelected) plate.wells.delete(well);
          else plate.wells.add(well);
        });
        renderPlate();
      }

      function toggleColumn(colValue) {
        const num = Number(colValue);
        if (!Number.isInteger(num) || num < 1 || num > 12) return;
        const plate = getCurrentPlate();
        const wells = ROWS.map((row) => `${row}${num}`);
        const allSelected = wells.every((well) => plate.wells.has(well));
        wells.forEach((well) => {
          if (allSelected) plate.wells.delete(well);
          else plate.wells.add(well);
        });
        renderPlate();
      }

      function setStatus(message, isError = false) {
        statusEl.textContent = message;
        statusEl.className = `status${isError ? " error" : ""}`;
      }

      function buildSegments(total, dividers) {
        const sorted = Array.from(dividers).sort((a, b) => a - b);
        const segments = [];
        let start = 0;
        sorted.forEach((pos) => {
          const end = Math.max(start, Math.min(total - 1, pos - 1));
          if (end >= start) segments.push([start, end]);
          start = Math.min(total, pos);
        });
        if (start <= total - 1) segments.push([start, total - 1]);
        return segments;
      }

      function buildDestinationOrder(direction, options = {}) {
        const includeBlockedWells = Boolean(options?.includeBlockedWells);
        const colSegments = buildSegments(COLS.length, verticalDividers);
        const rowSegments = buildSegments(ROWS.length, horizontalDividers);
        const placements = [];
        rowSegments.forEach(([rStart, rEnd]) => {
          colSegments.forEach(([cStart, cEnd]) => {
            if (direction === "column") {
              for (let c = cStart; c <= cEnd; c += 1) {
                for (let r = rStart; r <= rEnd; r += 1) {
                  placements.push({ rowIndex: r, colIndex: c });
                }
              }
            } else {
              for (let r = rStart; r <= rEnd; r += 1) {
                for (let c = cStart; c <= cEnd; c += 1) {
                  placements.push({ rowIndex: r, colIndex: c });
                }
              }
            }
          });
        });
        if (includeBlockedWells) return placements;
        // remove blocked wells
        return placements.filter(({ rowIndex, colIndex }) => {
          const wellId = `${ROWS[rowIndex]}${COLS[colIndex]}`;
          return !blockedLayoutWells.has(wellId);
        });
      }

      function buildPayload(direction) {
        const order = direction === "column" ? "column" : "row";
        const sortedSources = plates.map((plate, index) => {
          const wellsArray = Array.from(plate.wells);
          wellsArray.sort((a, b) => {
            const parsedA = parseWell(a);
            const parsedB = parseWell(b);
            if (!parsedA || !parsedB) return 0;
            if (inputReadDirection === "column") {
              return parsedA.col === parsedB.col
                ? parsedA.row.localeCompare(parsedB.row)
                : parsedA.col - parsedB.col;
            }
            return parsedA.row === parsedB.row
              ? parsedA.col - parsedB.col
              : parsedA.row.localeCompare(parsedB.row);
          });
          return {
            plate_id: `${String(index + 1).padStart(1, "0")}`,
            wells: wellsArray,
          };
        });

        const flattened = sortedSources.flatMap((src) =>
          src.wells.map((well) => ({ source_plate: src.plate_id, source_well: well }))
        );

        const placementOrder = buildDestinationOrder(order);
        const wellsPerPlate = placementOrder.length;
        const destinations = [];
        const orderedAssignments = [];

        flattened.forEach((item, index) => {
          const destPlateIndex = Math.floor(index / wellsPerPlate);
          const pos = index % wellsPerPlate;
          const placement = placementOrder[pos];
          const destRowIndex = placement?.rowIndex ?? 0;
          const destColIndex = placement?.colIndex ?? 0;
          const destPlateId = `DEST-${String(destPlateIndex + 1).padStart(3, "0")}`;
          const destWell = `${ROWS[destRowIndex]}${COLS[destColIndex]}`;

          orderedAssignments.push({
            source_plate: item.source_plate,
            source_well: item.source_well,
            destination_plate: destPlateId,
            destination_well: destWell,
          });
        });

        if (wellsPerPlate === 0) {
          throw new Error("配置先のウェルがありません。");
        }
        const totalDest = Math.max(1, Math.ceil(flattened.length / wellsPerPlate));
        for (let i = 0; i < totalDest; i += 1) {
          const plateId = `DEST-${String(i + 1).padStart(3, "0")}`;
          destinations.push({
            plate_id: plateId,
            rows: ROWS.length,
            cols: COLS.length,
            assignments: orderedAssignments
              .filter((assign) => assign.destination_plate === plateId)
              .map((assign) => ({
                well: assign.destination_well,
                source_plate: assign.source_plate,
                source_well: assign.source_well,
              })),
          });
        }

        return {
          title: "Plates Packing Report",
          sources: sortedSources,
          destinations,
          plan: orderedAssignments,
        };
      }

      async function pack() {
        try {
          tsvBtn.disabled = true;
          setStatus("");
          const order = layoutDirection;
          const placements = buildDestinationOrder(order);
          if (placements.length === 0) {
            setStatus("配置できる出力ウェルがありません。区切りや空きwell設定を見直してください。", true);
            return;
          }
          const payload = buildPayload(order);
          const selectionCount = payload.plan.length;
          if (selectionCount === 0) {
            setStatus("ウェルを選択してください。", true);
            tsvBtn.disabled = packedPlates.length === 0;
            return;
          }
          sourceColorMap = new Map();
          const pastelPalette = [
            "#c7d2fe",
            "#bfdbfe",
            "#bbf7d0",
            "#fbcfe8",
            "#fde68a",
            "#c8e7ff",
            "#fed7aa",
            "#e9d5ff",
            "#d9f99d",
            "#fcd6f6",
          ];
          payload.sources.forEach((src, idx) => {
            sourceColorMap.set(src.plate_id, pastelPalette[idx % pastelPalette.length]);
          });
          const res = await fetch(API_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          await res.text();
          if (!res.ok) {
            setStatus(`API error (${res.status})`, true);
            tsvBtn.disabled = packedPlates.length === 0;
            return;
          }
          tsvBtn.disabled = false;

          packedPlates = payload.destinations.map((plate) => {
            const destColumns = Array.from({ length: plate.cols }, (_, i) => i + 1);
            const grid = Array.from({ length: ROWS.length }, () =>
              Array.from({ length: destColumns.length }, () => null)
            );
            plate.assignments.forEach((assignment) => {
              const parsed = parseWell(assignment.well);
              if (!parsed) return;
              const rowIdx = ROWS.indexOf(parsed.row);
              const colIdx = destColumns.indexOf(parsed.col);
              if (rowIdx < 0 || colIdx < 0) return;
              grid[rowIdx][colIdx] = {
                sourcePlate: assignment.source_plate,
                sourceWell: assignment.source_well,
                color: sourceColorMap.get(assignment.source_plate),
              };
            });
            return { id: plate.plate_id, grid, columns: destColumns };
          });
          currentPackedIndex = 0;
          renderPacked();
        } catch (error) {
          setStatus(error.message, true);
          tsvBtn.disabled = packedPlates.length === 0;
        }
      }

      function shadowForColor(color) {
        if (color.startsWith("#") && color.length === 7) {
          const r = parseInt(color.slice(1, 3), 16);
          const g = parseInt(color.slice(3, 5), 16);
          const b = parseInt(color.slice(5, 7), 16);
          return `0 6px 12px rgba(${r}, ${g}, ${b}, 0.28)`;
        }
        return "0 6px 12px rgba(15, 23, 42, 0.2)";
      }

      function formatWellDisplay(well) {
        return formatWellLabel(well);
      }
      function buildMemoPanel() {
        const wrapper = document.createElement("div");
        wrapper.className = "memo-panel";
        const title = document.createElement("h3");
        title.textContent = "入力プレートのメモ";
        wrapper.appendChild(title);

        const list = document.createElement("ul");
        if (plates.length === 0) {
          const li = document.createElement("li");
          li.textContent = "メモがありません。";
          list.appendChild(li);
        } else {
          plates.forEach((plate) => {
            const memoText = plate.memo && plate.memo.trim() ? plate.memo.trim() : "メモなし";
            const li = document.createElement("li");
            li.textContent = `${plate.label}: ${memoText}`;
            list.appendChild(li);
          });
        }
        wrapper.appendChild(list);
        return wrapper;
      }

      function refreshMemoPanel() {
        const panel = document.querySelector(".memo-panel");
        if (!panel) return;
        const fresh = buildMemoPanel();
        panel.replaceWith(fresh);
      }

      function buildWellOrder() {
        return buildDestinationOrder(layoutDirection, { includeBlockedWells: true }).map(
          ({ rowIndex, colIndex }) => `${ROWS[rowIndex]}${COLS[colIndex]}`
        );
      }

      function renderPacked() {
        if (packedPlates.length === 0) {
          packedSummary.textContent = "Packed Plate 0 of 0";
          packedGrid.innerHTML = "<p class='muted'>まだパッキング結果はありません。</p>";
          prevPackedBtn.disabled = true;
          nextPackedBtn.disabled = true;
          tsvBtn.disabled = true;
          if (pngBtn) pngBtn.disabled = true;
          return;
        }
        const plate = packedPlates[currentPackedIndex];
        const destColumns = plate.columns && plate.columns.length ? plate.columns : COLS;
        packedSummary.textContent = `Packed Plate ${currentPackedIndex + 1} of ${packedPlates.length}`;

        const table = document.createElement("table");
        table.className = "packed-table";
        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");
        headerRow.innerHTML = "<th></th>" + destColumns.map((col) => `<th>${col}</th>`).join("");
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        const cellMatrix = Array.from({ length: ROWS.length }, () =>
          Array.from({ length: destColumns.length }, () => null)
        );
        const rowHeaderCells = [];
        ROWS.forEach((rowLabel, rowIndex) => {
          const tr = document.createElement("tr");
          const rowHeader = document.createElement("th");
          rowHeader.className = "row-header";
          rowHeader.textContent = rowLabel;
          tr.appendChild(rowHeader);
          rowHeaderCells.push(rowHeader);
          destColumns.forEach((colNumber, colIndex) => {
            const td = document.createElement("td");
            td.className = "packed-cell";
            const well = `${rowLabel}${colNumber}`;
            const cellData = plate.grid[rowIndex][colIndex];
            if (cellData) {
              td.classList.add("active");
              const color = cellData.color || sourceColorMap.get(cellData.sourcePlate) || "#dbeafe";
              const label = document.createElement("span");
              label.textContent = `${cellData.sourcePlate}-${formatWellDisplay(cellData.sourceWell)}`;
              label.style.background = color;
              label.style.boxShadow = shadowForColor(color);
              td.appendChild(label);
            }
            tr.appendChild(td);
            cellMatrix[rowIndex][colIndex] = td;
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        const layout = document.createElement("div");
        layout.className = "packed-layout";
        const tableWrap = document.createElement("div");
        tableWrap.className = "packed-table-wrap";
        tableWrap.appendChild(table);
        layout.appendChild(tableWrap);
        layout.appendChild(buildMemoPanel());
        packedGrid.innerHTML = "";
        packedGrid.appendChild(layout);

        const columnHeaderCells = Array.from(headerRow.children).slice(1);
        const borderWidth = 2;
        applyBordersForRegion(cellMatrix, rowHeaderCells, columnHeaderCells, plate.grid, borderWidth);
        applyLayoutDividers(cellMatrix);

        prevPackedBtn.disabled = currentPackedIndex === 0;
        nextPackedBtn.disabled = currentPackedIndex >= packedPlates.length - 1;
        tsvBtn.disabled = false;
        if (pngBtn) pngBtn.disabled = false;
      }

      function applyBordersForRegion(matrix, rowHeaders, columnHeaders, gridData, thickWidth = 2) {
        const baseColor = "#d5deff";
        const borderColor = "#0f172a";

        matrix.forEach((row) =>
          row.forEach((cell) => {
            if (cell) cell.style.border = `1px solid ${baseColor}`;
          })
        );
        rowHeaders.forEach((th) => {
          th.style.borderTop = `1px solid ${baseColor}`;
          th.style.borderBottom = `1px solid ${baseColor}`;
          th.style.borderLeft = `1px solid ${baseColor}`;
          th.style.borderRight = `1px solid ${baseColor}`;
        });
        columnHeaders.forEach((th) => {
          th.style.borderTop = `1px solid ${baseColor}`;
          th.style.borderBottom = `1px solid ${baseColor}`;
          th.style.borderLeft = `1px solid ${baseColor}`;
          th.style.borderRight = `1px solid ${baseColor}`;
        });

        const maxRow = ROWS.length - 1;
        const maxCol = (matrix[0]?.length ?? 0) - 1;
        if (maxCol < 0) return;

        const getPlateId = (r, c) => (gridData?.[r]?.[c]?.sourcePlate || null);

        for (let row = 0; row <= maxRow; row += 1) {
          for (let col = 0; col <= maxCol; col += 1) {
            const cellInfo = gridData[row][col];
            if (!cellInfo) continue;
            const cell = matrix[row][col];
            const plateId = cellInfo.sourcePlate;

            const topPlate = row > 0 ? getPlateId(row - 1, col) : null;
            if ((plateId || topPlate) && plateId !== topPlate) {
              cell.style.borderTop = `${thickWidth}px solid ${borderColor}`;
              if (row > 0) {
                const topCell = matrix[row - 1][col];
                if (topCell && getPlateId(row - 1, col)) {
                  topCell.style.borderBottom = `${thickWidth}px solid ${borderColor}`;
                }
              }
            }

            const leftPlate = col > 0 ? getPlateId(row, col - 1) : null;
            if ((plateId || leftPlate) && plateId !== leftPlate) {
              cell.style.borderLeft = `${thickWidth}px solid ${borderColor}`;
              if (col > 0) {
                const leftCell = matrix[row][col - 1];
                if (leftCell && getPlateId(row, col - 1)) {
                  leftCell.style.borderRight = `${thickWidth}px solid ${borderColor}`;
                }
              }
            }

            const rightPlate = col < maxCol ? getPlateId(row, col + 1) : null;
            if ((plateId || rightPlate) && plateId !== rightPlate) {
              cell.style.borderRight = `${thickWidth}px solid ${borderColor}`;
              if (col < maxCol) {
                const rightCell = matrix[row][col + 1];
                if (rightCell && getPlateId(row, col + 1)) {
                  rightCell.style.borderLeft = `${thickWidth}px solid ${borderColor}`;
                }
              }
            }

            const bottomPlate = row < maxRow ? getPlateId(row + 1, col) : null;
            if ((plateId || bottomPlate) && plateId !== bottomPlate) {
              cell.style.borderBottom = `${thickWidth}px solid ${borderColor}`;
              if (row < maxRow) {
                const bottomCell = matrix[row + 1][col];
                if (bottomCell && getPlateId(row + 1, col)) {
                  bottomCell.style.borderTop = `${thickWidth}px solid ${borderColor}`;
                }
              }
            }

            if (plateId && col === maxCol) {
              cell.style.borderRight = `${thickWidth}px solid ${borderColor}`;
            }
            if (plateId && row === maxRow) {
              cell.style.borderBottom = `${thickWidth}px solid ${borderColor}`;
            }
          }
        }
      }

      function applyLayoutDividers(matrix) {
        const maxRow = matrix.length;
        if (!maxRow) return;
        const maxCol = matrix[0].length;
        // vertical lines
        verticalDividers.forEach((pos) => {
          const idx = pos - 1;
          if (idx < 0 || idx >= maxCol) return;
          matrix.forEach((row) => {
            const cell = row[idx];
            if (!cell) return;
            const dash = document.createElement("div");
            dash.className = "col-dash";
            cell.appendChild(dash);
          });
        });
        // horizontal lines
        horizontalDividers.forEach((pos) => {
          const idx = pos;
          if (idx < 0 || idx >= maxRow) return;
          const rowCells = matrix[idx];
          rowCells.forEach((cell) => {
            if (!cell) return;
            const dash = document.createElement("div");
            dash.className = "row-dash";
            cell.appendChild(dash);
          });
        });
      }

      function exportPackedTsv() {
        if (!packedPlates.length) {
          setStatus("パックされたプレートがありません。", true);
          return;
        }
        const order = layoutDirection || "row";
        const wellOrder = buildWellOrder();
        const header = ["well_position", ...packedPlates.map((plate, idx) => plate.id || `Output ${idx + 1}`)];
        const lines = [header.join("\t")];

        wellOrder.forEach((wellId) => {
          const parsed = parseWell(wellId);
          if (!parsed) return;
          const rowIdx = ROWS.indexOf(parsed.row);
          const rowLabel = order === "column" ? formatWellDisplay(wellId) : wellId;
          const rowValues = packedPlates.map((plate) => {
            const columns = plate.columns && plate.columns.length ? plate.columns : COLS;
            const colIdx = columns.indexOf(parsed.col);
            if (rowIdx === -1 || colIdx === -1) return "";
            const cellData = plate.grid[rowIdx]?.[colIdx];
            if (!cellData) return "";
            return `${cellData.sourcePlate}-${formatWellDisplay(cellData.sourceWell)}`;
          });
          lines.push([rowLabel, ...rowValues].join("\t"));
        });

        const blob = new Blob([lines.join("\n")], { type: "text/tab-separated-values" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `packed_plates_${order}.tsv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }

      function exportPackedPng() {
        if (!packedPlates.length) {
          setStatus("パックされたプレートがありません。", true);
          return;
        }
        setStatus("");
        const STORAGE_KEY = "platepack_saved_pngs_v1";
        const plate = packedPlates[currentPackedIndex];
        const destColumns = plate.columns && plate.columns.length ? plate.columns : COLS;
        const rows = ROWS.length;
        const cols = destColumns.length;

        const table = packedGrid.querySelector(".packed-table");
        const sampleTd = table?.querySelector("tbody td");
        const headerCorner = table?.querySelector("thead th:first-child");
        const headerTh = table?.querySelector("thead th");
        const cellSize = sampleTd ? Math.round(sampleTd.getBoundingClientRect().width) : 50;
        const headerH = headerTh ? Math.round(headerTh.getBoundingClientRect().height) : 22;
        const headerW = headerCorner ? Math.round(headerCorner.getBoundingClientRect().width) : headerH;

        const width = headerW + cols * cellSize;
        const height = headerH + rows * cellSize;
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setStatus("PNGの生成に失敗しました。", true);
          return;
        }
        ctx.scale(dpr, dpr);

        const border = "#d5deff";
        const headerBg = "#e5ecf6";
        const rowHeaderBg = "#e9f0fa";
        const textColor = "#475569";

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = headerBg;
        ctx.fillRect(0, 0, headerW, headerH);

        ctx.font = `600 ${Math.max(10, Math.round(headerH * 0.55))}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = textColor;
        destColumns.forEach((col, idx) => {
          const x = headerW + idx * cellSize;
          ctx.fillStyle = headerBg;
          ctx.fillRect(x, 0, cellSize, headerH);
          ctx.fillStyle = textColor;
          ctx.fillText(String(col), x + cellSize / 2, headerH / 2);
        });

        ROWS.forEach((rowLabel, r) => {
          const y = headerH + r * cellSize;
          ctx.fillStyle = rowHeaderBg;
          ctx.fillRect(0, y, headerW, cellSize);
          ctx.fillStyle = textColor;
          ctx.fillText(String(rowLabel), headerW / 2, y + cellSize / 2);

          destColumns.forEach((col, c) => {
            const x = headerW + c * cellSize;
            const cellData = plate.grid[r]?.[c] || null;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(x, y, cellSize, cellSize);
            if (cellData) {
              const fill = cellData.color || sourceColorMap.get(cellData.sourcePlate) || "#dbeafe";
              ctx.fillStyle = fill;
              ctx.fillRect(x, y, cellSize, cellSize);

              const label = `${cellData.sourcePlate}-${formatWellDisplay(cellData.sourceWell)}`;
              ctx.save();
              ctx.beginPath();
              ctx.rect(x, y, cellSize, cellSize);
              ctx.clip();
              ctx.fillStyle = "#1f2937";
              ctx.font = `600 ${Math.max(9, Math.round(cellSize * 0.22))}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
              ctx.fillText(label, x + cellSize / 2, y + cellSize / 2);
              ctx.restore();
            }
          });
        });

        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        for (let c = 0; c <= cols; c += 1) {
          const x = headerW + c * cellSize;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        for (let r = 0; r <= rows; r += 1) {
          const y = headerH + r * cellSize;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(0, headerH);
        ctx.lineTo(width, headerH);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(headerW, 0);
        ctx.lineTo(headerW, height);
        ctx.stroke();
        ctx.strokeRect(0, 0, width, height);

        const filenameBase = (plate.id || `packed_${currentPackedIndex + 1}`).replace(/[^a-zA-Z0-9_-]+/g, "_");
        canvas.toBlob((blob) => {
          if (!blob) {
            setStatus("PNGの生成に失敗しました。", true);
            return;
          }
          try {
            const reader = new FileReader();
            reader.onload = () => {
              try {
                const dataUrl = String(reader.result || "");
                const raw = localStorage.getItem(STORAGE_KEY);
                const existing = raw ? JSON.parse(raw) : [];
                const items = Array.isArray(existing) ? existing : [];
                items.unshift({
                  id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
                  title: plate.id || `Packed Plate ${currentPackedIndex + 1}`,
                  filename: `${filenameBase}.png`,
                  createdAt: new Date().toISOString(),
                  dataUrl,
                });
                localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 30)));
              } catch {
                // ignore persistence errors (quota, JSON, etc.)
              }
            };
            reader.readAsDataURL(blob);
          } catch {
            // ignore
          }
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${filenameBase}.png`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
        }, "image/png");
      }

      function buildLogSnapshot() {
        return {
          version: 1,
          plates: plates.map((plate) => ({
            label: plate.label,
            memo: plate.memo || "",
            wells: Array.from(plate.wells || []),
          })),
          currentPlateIndex,
          inputReadDirection,
          layoutDirection,
          wellLabelMode,
          blockedLayoutWells: Array.from(blockedLayoutWells),
          verticalDividers: Array.from(verticalDividers),
          horizontalDividers: Array.from(horizontalDividers),
        };
      }

      const LOCAL_LOG_KEY = "PLATEPACK_LOCAL_LOGS_V1";

      function safeParseJson(raw, fallback) {
        try {
          return JSON.parse(raw);
        } catch {
          return fallback;
        }
      }

      function listLocalLogs() {
        try {
          const raw = localStorage.getItem(LOCAL_LOG_KEY);
          const parsed = raw ? safeParseJson(raw, []) : [];
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }

      function writeLocalLogs(items) {
        try {
          localStorage.setItem(LOCAL_LOG_KEY, JSON.stringify(items));
        } catch {
          // ignore quota / privacy errors
        }
      }

      function saveLocalLog(name, payload) {
        const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const created_at = new Date().toISOString();
        const items = listLocalLogs();
        items.unshift({ id, name: String(name || "Log"), created_at, payload: payload || {} });
        writeLocalLogs(items.slice(0, 200));
        return { id, name: String(name || "Log"), created_at };
      }

      function getLocalLog(id) {
        const items = listLocalLogs();
        return items.find((x) => x && typeof x === "object" && x.id === id) || null;
      }

      function applyLogSnapshot(snapshot) {
        const nextPlates = Array.isArray(snapshot?.plates) ? snapshot.plates : [];
        plates = nextPlates.map((p, idx) => ({
          label: p?.label || `Plate ${idx + 1}`,
          memo: p?.memo || "",
          wells: new Set(Array.isArray(p?.wells) ? p.wells : []),
        }));
        if (!plates.length) plates = [createPlate(1)];
        currentPlateIndex = Math.max(0, Math.min(Number(snapshot?.currentPlateIndex) || 0, plates.length - 1));
        inputReadDirection = snapshot?.inputReadDirection === "column" ? "column" : "row";
        layoutDirection = snapshot?.layoutDirection === "column" ? "column" : "row";
        wellLabelMode = snapshot?.wellLabelMode === "rowCol" ? "rowCol" : "colRow";
        blockedLayoutWells = new Set(Array.isArray(snapshot?.blockedLayoutWells) ? snapshot.blockedLayoutWells : []);
        verticalDividers = new Set(Array.isArray(snapshot?.verticalDividers) ? snapshot.verticalDividers : []);
        horizontalDividers = new Set(Array.isArray(snapshot?.horizontalDividers) ? snapshot.horizontalDividers : []);

        ensurePlateOption(plates.length);
        plateCountSelect.value = String(plates.length);
        renderGridStructure();
        renderPlate();
        updateLayoutButtons();
        renderLayoutGrid();
        setStatus("ログを読み込みました。");
      }

      async function saveLog() {
        try {
          const defaultName = `Log ${new Date().toLocaleString()}`;
          const name = prompt("ログ名を入力してください:", defaultName);
          if (!name) return;
          setStatus("ログを保存中...");
          const payload = buildLogSnapshot();
          try {
            const res = await fetch("/api/logs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, payload }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
              const detail = data?.detail ? `: ${data.detail}` : "";
              if (res.status === 503) {
                const saved = saveLocalLog(name, payload);
                setStatus(`サーバー保存できないためローカルに保存しました: ${saved.name}`);
                return;
              }
              setStatus(`ログ保存に失敗しました (${res.status})${detail}`, true);
              return;
            }
            setStatus(`ログ保存しました: ${data?.name || name}`);
          } catch {
            const saved = saveLocalLog(name, payload);
            setStatus(`サーバー保存できないためローカルに保存しました: ${saved.name}`);
          }
        } catch (e) {
          setStatus("ログ保存に失敗しました。", true);
        }
      }

      async function loadLogFromQuery() {
        const params = new URLSearchParams(window.location.search);
        const logId = params.get("log");
        if (!logId) return;
        try {
          setStatus("ログを読み込み中...");
          if (logId.startsWith("local:")) {
            const localId = logId.slice("local:".length);
            const entry = getLocalLog(localId);
            if (!entry?.payload) {
              setStatus("ローカルログが見つかりません。", true);
              return;
            }
            applyLogSnapshot(entry.payload);
            return;
          }
          const res = await fetch(`/api/logs/${encodeURIComponent(logId)}`);
          const data = await res.json().catch(() => null);
          if (!res.ok || !data?.payload) {
            const detail = data?.detail ? `: ${data.detail}` : "";
            setStatus(`ログ読み込みに失敗しました (${res.status})${detail}`, true);
            return;
          }
          applyLogSnapshot(data.payload);
        } catch {
          setStatus("ログ読み込みに失敗しました。", true);
        }
      }

      // Event bindings
      plateCountSelect.addEventListener("change", (e) => {
        const value = e.target.value;
        if (value === "custom") {
          const input = prompt("Enter number of plates (1-999):", plates.length);
          if (input === null) {
            plateCountSelect.value = String(plates.length);
            return;
          }
          const num = Number(input);
          if (!Number.isInteger(num) || num < 1) {
            alert("Please enter a positive integer.");
            plateCountSelect.value = String(plates.length);
            return;
          }
          ensurePlateOption(num);
          plateCountSelect.value = String(num);
          resizePlateCount(num);
        } else {
          resizePlateCount(Number(value));
        }
      });
      prevPlateBtn.addEventListener("click", () => {
        if (currentPlateIndex === 0) return;
        currentPlateIndex -= 1;
        renderPlate();
      });
      nextPlateBtn.addEventListener("click", () => {
        if (currentPlateIndex >= plates.length - 1) return;
        currentPlateIndex += 1;
        renderPlate();
      });
      clearPlateBtn.addEventListener("click", clearPlate);
      packLayoutBtn.addEventListener("click", () => pack());
      prevPackedBtn.addEventListener("click", () => {
        if (currentPackedIndex === 0) return;
        currentPackedIndex -= 1;
        renderPacked();
      });
      nextPackedBtn.addEventListener("click", () => {
        if (currentPackedIndex >= packedPlates.length - 1) return;
        currentPackedIndex += 1;
        renderPacked();
      });
      tsvBtn.addEventListener("click", exportPackedTsv);
      if (pngBtn) pngBtn.addEventListener("click", exportPackedPng);
      if (saveLogBtn) saveLogBtn.addEventListener("click", saveLog);
      plateMemoInput.addEventListener("input", (e) => {
        const plate = getCurrentPlate();
        plate.memo = e.target.value;
        refreshMemoPanel();
      });
      directionBtn.addEventListener("click", toggleDirection);
      inputDirectionBtn.addEventListener("click", toggleInputDirection);
      layoutClearBtn.addEventListener("click", clearLayoutSettings);
      if (wellLabelBtn) {
        wellLabelBtn.addEventListener("click", toggleWellLabelMode);
      }

      // Initial render
      renderGridStructure();
      renderPlate();
      updateLayoutButtons();
      renderLayoutGrid();
      loadLogFromQuery();

(function () {
        const API_LIST = "/api/logs";
        const API_ITEM = (id) => `/api/logs/${encodeURIComponent(id)}`;
        const listEl = document.getElementById("list");
        const emptyEl = document.getElementById("empty");
        const noticeEl = document.getElementById("notice");
        const clearAllBtn = document.getElementById("clearAllBtn");
        const importBtn = document.getElementById("importBtn");
        const importInput = document.getElementById("importInput");
        const migrateBtn = document.getElementById("migrateBtn");
        const LOCAL_LOG_KEY = "PLATEPACK_LOCAL_LOGS_V1";

        if (!listEl || !emptyEl || !clearAllBtn || !importBtn || !importInput) {
          return;
        }

        function formatDate(iso) {
          try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return iso;
            return d.toLocaleString();
          } catch {
            return iso;
          }
        }

        function safeParseJson(raw, fallback) {
          try {
            return JSON.parse(raw);
          } catch {
            return fallback;
          }
        }

        function listLocalLogs() {
          try {
            const raw = localStorage.getItem(LOCAL_LOG_KEY);
            const parsed = raw ? safeParseJson(raw, []) : [];
            const items = Array.isArray(parsed) ? parsed : [];
            return items.filter((x) => x && typeof x === "object" && typeof x.id === "string");
          } catch {
            return [];
          }
        }

        function writeLocalLogs(items) {
          try {
            localStorage.setItem(LOCAL_LOG_KEY, JSON.stringify(items));
          } catch {
            // ignore quota / privacy errors
          }
        }

        function saveLocalLog(name, payload) {
          const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
          const created_at = new Date().toISOString();
          const items = listLocalLogs();
          items.unshift({ id, name: String(name || "Log"), created_at, payload: payload || {} });
          writeLocalLogs(items.slice(0, 200));
          return { id, name: String(name || "Log"), created_at };
        }

        function getLocalLog(id) {
          const items = listLocalLogs();
          return items.find((x) => x && typeof x === "object" && x.id === id) || null;
        }

        async function deleteLog(source, id) {
          if (source === "local") {
            const next = listLocalLogs().filter((x) => x.id !== id);
            writeLocalLogs(next);
            return;
          }
          const res = await fetch(API_ITEM(id), { method: "DELETE" });
          if (!res.ok) throw new Error("delete failed");
        }

        async function createServerLog(name, payload) {
          const res = await fetch(API_LIST, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, payload }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const msg = err?.detail ? String(err.detail) : `HTTP ${res.status}`;
            throw new Error(msg);
          }
          return res.json().catch(() => ({}));
        }

        function downloadJson(filename, data) {
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = filename || "platepack_log.json";
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
        }

        async function downloadLog(source, id, name) {
          if (source === "local") {
            const entry = getLocalLog(id);
            if (!entry) throw new Error("not found");
            const safe = String(name || "log").replace(/[^a-zA-Z0-9_-]+/g, "_");
            downloadJson(`platepack_log_${safe}_local_${id}.json`, {
              id: entry.id,
              name: entry.name,
              created_at: entry.created_at,
              payload: entry.payload || {},
            });
            return;
          }
          const res = await fetch(API_ITEM(id));
          if (!res.ok) throw new Error("fetch failed");
          const data = await res.json();
          const safe = String(name || "log").replace(/[^a-zA-Z0-9_-]+/g, "_");
          downloadJson(`platepack_log_${safe}_${id}.json`, data);
        }

        function readFileAsText(file) {
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(reader.error || new Error("read failed"));
            reader.readAsText(file);
          });
        }

        async function importJsonFile(file) {
          const text = await readFileAsText(file);
          const parsed = JSON.parse(text);
          const payload =
            parsed && typeof parsed === "object" && parsed.payload && typeof parsed.payload === "object"
              ? parsed.payload
              : parsed && typeof parsed === "object"
                ? parsed
                : null;
          if (!payload || typeof payload !== "object") {
            throw new Error("invalid payload");
          }
          const defaultName =
            (parsed && typeof parsed === "object" && typeof parsed.name === "string" && parsed.name.trim()) ||
            (file?.name ? file.name.replace(/\\.json$/i, "") : "") ||
            `Imported ${new Date().toLocaleString()}`;
          const name = prompt("ログ名を入力してください:", defaultName);
          if (!name) return;
          try {
            await createServerLog(name, payload);
          } catch {
            saveLocalLog(name, payload);
          }
        }

        async function migrateLocalToDb(entry) {
          if (!entry || typeof entry !== "object") throw new Error("invalid entry");
          const id = String(entry.id || "");
          if (!id) throw new Error("missing id");
          await createServerLog(String(entry.name || "Log"), entry.payload || {});
          const next = listLocalLogs().filter((x) => x.id !== id);
          writeLocalLogs(next);
        }

        async function migrateAllLocalToDb() {
          const local = listLocalLogs();
          if (!local.length) return;
          if (!confirm(`LOCALログ ${local.length} 件をDBへ移行します。よろしいですか？`)) return;
          if (migrateBtn) {
            migrateBtn.disabled = true;
            migrateBtn.textContent = "移行中...";
          }
          let okCount = 0;
          for (const entry of local) {
            try {
              await migrateLocalToDb(entry);
              okCount += 1;
            } catch {
              break;
            }
          }
          if (migrateBtn) {
            migrateBtn.disabled = false;
            migrateBtn.textContent = "LOCAL→DB移行";
          }
          alert(`移行しました: ${okCount} 件`);
          await render();
        }

        async function render() {
          listEl.innerHTML = "";
          emptyEl.style.display = "none";
          if (noticeEl) noticeEl.style.display = "none";

          let serverItems = [];
          let serverError = "";
          let serverOk = false;
          try {
            const res = await fetch(API_LIST);
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              serverError = err?.detail || `HTTP ${res.status}`;
              serverItems = [];
            } else {
              serverItems = (await res.json()) || [];
              if (!Array.isArray(serverItems)) serverItems = [];
              serverOk = true;
            }
          } catch (e) {
            serverItems = [];
            serverError = e && typeof e === "object" && "message" in e ? String(e.message || "") : "";
            serverOk = false;
          }

          const localItems = listLocalLogs()
            .map((x) => ({
              source: "local",
              id: x.id,
              name: x.name || "Log",
              created_at: x.created_at || "",
            }))
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

          const normalizedServer = serverItems.map((x) => ({
            source: "server",
            id: x?.id || "",
            name: x?.name || "Log",
            created_at: x?.created_at || "",
          }));

          if (migrateBtn) {
            migrateBtn.style.display = serverOk && localItems.length ? "inline-flex" : "none";
            migrateBtn.disabled = false;
            migrateBtn.textContent = "LOCAL→DB移行";
          }

          if (noticeEl && serverError) {
            noticeEl.textContent =
              "サーバー側の永続DBが未設定/利用不可のため、このページではブラウザ内のローカルログを表示・保存します。" +
              (serverError ? ` (${serverError})` : "");
            noticeEl.style.display = "block";
          }

          const items = [...normalizedServer, ...localItems].filter((x) => x.id);
          listEl.innerHTML = "";
          emptyEl.style.display = items.length ? "none" : "block";
          if (!items.length) return;

          items.forEach((item) => {
            const card = document.createElement("details");
            card.className = "item";

            const summary = document.createElement("summary");
            summary.className = "item-summary";

            const badge = document.createElement("div");
            badge.className = "badge";
            badge.textContent = item?.source === "local" ? "LOCAL" : "DB";

            const summaryText = document.createElement("div");
            summaryText.className = "summary-text";

            const title = document.createElement("div");
            title.className = "title";
            title.textContent = item?.name || "Log";

            const sub = document.createElement("div");
            sub.className = "sub";
            sub.textContent = item?.created_at ? formatDate(item.created_at) : "";

            summaryText.appendChild(title);
            summaryText.appendChild(sub);

            const summaryActions = document.createElement("div");
            summaryActions.className = "summary-actions";

            const expandBtn = document.createElement("button");
            expandBtn.type = "button";
            expandBtn.className = "btn secondary";
            expandBtn.textContent = "展開";
            expandBtn.addEventListener("click", (ev) => {
              ev.preventDefault();
              card.open = !card.open;
            });

            summaryActions.appendChild(expandBtn);

            summary.appendChild(badge);
            summary.appendChild(summaryText);
            summary.appendChild(summaryActions);

            const meta = document.createElement("div");
            meta.className = "meta";

            const actions = document.createElement("div");
            actions.className = "actions";

            const open = document.createElement("a");
            open.className = "btn";
            open.href =
              item?.source === "local"
                ? `/plates?log=${encodeURIComponent(`local:${item?.id || ""}`)}`
                : `/plates?log=${encodeURIComponent(item?.id || "")}`;
            open.textContent = "Packerで開く";

            const dl = document.createElement("button");
            dl.type = "button";
            dl.className = "btn secondary";
            dl.textContent = "Download JSON";
            dl.addEventListener("click", async () => {
              try {
                await downloadLog(item?.source, item?.id, item?.name);
              } catch {
                alert("ダウンロードに失敗しました。");
              }
            });

            let mig = null;
            if (item?.source === "local" && serverOk) {
              mig = document.createElement("button");
              mig.type = "button";
              mig.className = "btn secondary";
              mig.textContent = "DBへ移行";
              mig.addEventListener("click", async () => {
                if (!confirm("このLOCALログをDBへ移行します。よろしいですか？")) return;
                try {
                  const entry = getLocalLog(item?.id);
                  if (!entry) throw new Error("not found");
                  await migrateLocalToDb(entry);
                  await render();
                } catch (e) {
                  const msg = e && typeof e === "object" && "message" in e ? String(e.message || "") : "";
                  alert(`移行に失敗しました。${msg ? ` (${msg})` : ""}`);
                }
              });
            }

            const del = document.createElement("button");
            del.type = "button";
            del.className = "btn danger";
            del.textContent = "削除";
            del.addEventListener("click", async () => {
              if (!confirm("このログを削除します。よろしいですか？")) return;
              try {
                await deleteLog(item?.source, item?.id);
                await render();
              } catch {
                alert("削除に失敗しました。");
              }
            });

            actions.appendChild(open);
            actions.appendChild(dl);
            if (mig) actions.appendChild(mig);
            actions.appendChild(del);

            const row = document.createElement("div");
            row.className = "row";
            const idTag = document.createElement("div");
            idTag.className = "sub";
            idTag.textContent = `id: ${item?.id || ""}`;
            row.appendChild(idTag);
            meta.appendChild(row);
            meta.appendChild(actions);

            card.appendChild(summary);
            card.appendChild(meta);
            listEl.appendChild(card);
          });
        }

        clearAllBtn.addEventListener("click", () => {
          alert("全削除は未対応です（DB永続化のため）。個別に削除してください。");
        });

        importBtn.addEventListener("click", () => importInput.click());
        if (migrateBtn) migrateBtn.addEventListener("click", migrateAllLocalToDb);
        importInput.addEventListener("change", async () => {
          const file = importInput.files && importInput.files[0];
          importInput.value = "";
          if (!file) return;
          try {
            await importJsonFile(file);
            await render();
          } catch {
            alert("JSONの読み込み/保存に失敗しました。");
          }
        });

        window.__platepack_logs_render = render;
      })();

(function () {
        const views = {
          home: document.getElementById("view-home"),
          plates: document.getElementById("view-plates"),
          logs: document.getElementById("view-logs"),
        };

        function keyFromPathname(pathname) {
          if (pathname.startsWith("/results")) return "logs";
          if (pathname.startsWith("/plates")) return "plates";
          return "home";
        }

	        function setActiveView(key) {
	          Object.entries(views).forEach(([k, el]) => {
	            if (!el) return;
	            const isActive = k === key;
	            el.classList.toggle("is-active", isActive);
	            el.hidden = !isActive;
	            el.setAttribute("aria-hidden", String(!isActive));
	          });
	          if (key === "logs" && typeof window.__platepack_logs_render === "function") {
	            window.__platepack_logs_render();
	          }
	        }

        setActiveView(keyFromPathname(window.location.pathname));
        window.addEventListener("popstate", () => setActiveView(keyFromPathname(window.location.pathname)));
      })();
