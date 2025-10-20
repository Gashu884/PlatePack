# filename: plates_api.py
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import StreamingResponse, PlainTextResponse, JSONResponse
from pydantic import BaseModel, Field, validator
from typing import List, Literal, Optional, Dict, Tuple
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont
import math
import re

app = FastAPI(title="Plates Packer API", version="1.0.0")

# ---------- ユーティリティ（ウェル表記の相互変換） ----------

_well_re = re.compile(r"^([A-Za-z]+)(\d+)$")

def letters_to_index(s: str) -> int:
    # "A"->0, "B"->1, ... "Z"->25, "AA"->26...
    s = s.upper()
    n = 0
    for ch in s:
        n = n * 26 + (ord(ch) - 64)
    return n - 1

def index_to_letters(i: int) -> str:
    # 0->"A", 25->"Z", 26->"AA"
    i += 1
    result = []
    while i:
        i, r = divmod(i - 1, 26)
        result.append(chr(65 + r))
    return "".join(reversed(result))

def parse_well(label: str) -> Tuple[int, int]:
    m = _well_re.match(label.strip())
    if not m:
        raise ValueError(f"Invalid well label: {label}")
    row = letters_to_index(m.group(1))
    col = int(m.group(2)) - 1
    return row, col

def well_label(row: int, col: int) -> str:
    return f"{index_to_letters(row)}{col+1}"

def order_indices(rows: int, cols: int, direction: str) -> List[Tuple[int, int]]:
    if direction == "row":
        return [(r, c) for r in range(rows) for c in range(cols)]
    else:
        return [(r, c) for c in range(cols) for r in range(rows)]

def clamp_well_in_plate(label: str, rows: int, cols: int) -> None:
    r, c = parse_well(label)
    if r < 0 or r >= rows or c < 0 or c >= cols:
        raise ValueError(f"Well {label} is out of bounds for a {rows}x{cols} plate.")

# ---------- 入力モデル ----------

class SourceConfig(BaseModel):
    plate_id: str
    rows: int = Field(8, ge=1, le=26)
    cols: int = Field(12, ge=1)
    selected_wells: List[str]
    order: Literal["row", "column", "given"] = "row"
    color: Optional[str] = None  # "#RRGGBB" を指定可（未指定は自動配色）

    @validator("selected_wells")
    def _non_empty(cls, v):
        if not v:
            raise ValueError("selected_wells must not be empty.")
        return v

    @validator("selected_wells", each_item=True)
    def _well_format(cls, w, values):
        rows = values.get("rows", 8)
        cols = values.get("cols", 12)
        clamp_well_in_plate(w, rows, cols)
        return w

class DestinationConfig(BaseModel):
    rows: int = Field(8, ge=1, le=26)
    cols: int = Field(12, ge=1)
    fill_direction: Literal["row", "column"] = "row"
    start_well: str = "A1"
    plate_name_prefix: str = "Dest"

    @validator("start_well")
    def _check_start(cls, w, values):
        rows = values.get("rows", 8)
        cols = values.get("cols", 12)
        clamp_well_in_plate(w, rows, cols)
        return w

class PackRequest(BaseModel):
    sources: List[SourceConfig]
    destination: DestinationConfig = DestinationConfig()
    annotate: Literal["none", "source_plate", "source_well", "both"] = "both"
    serpentine: bool = False  # 将来拡張用（今回は未使用）

# ---------- 出力モデル（簡略） ----------

def default_palette():
    # 見やすい固定パレット（必要に応じて増やしてもOK）
    return [
        "#4472C4","#ED7D31","#A5A5A5","#FFC000","#5B9BD5",
        "#70AD47","#264478","#9E480E","#636363","#997300",
        "#255E91","#43682B","#7030A0","#C00000","#00B0F0","#92D050",
        "#7F7F7F","#FFD966","#2F5597","#B85450"
    ]

# ---------- コアロジック：パッキング ----------

def _sort_wells(wells: List[str], order: str) -> List[str]:
    if order == "given":
        return wells
    idxs = []
    for w in wells:
        r, c = parse_well(w)
        idxs.append((r, c, w))
    if order == "row":
        idxs.sort(key=lambda x: (x[0], x[1]))
    else:
        idxs.sort(key=lambda x: (x[1], x[0]))
    return [w for _,_,w in idxs]

def compute_destination_sequence(rows: int, cols: int, start_well: str, direction: str) -> List[Tuple[int,int]]:
    seq = order_indices(rows, cols, direction)
    sr, sc = parse_well(start_well)
    start_idx = seq.index((sr, sc))
    return seq[start_idx:]  # 1枚目は開始位置から

def pack_wells(req: PackRequest):
    # フラットな取り出し順序を作る
    flat: List[Tuple[str, str]] = []  # [(plate_id, well)]
    for src in req.sources:
        ordered = _sort_wells(src.selected_wells, src.order)
        for w in ordered:
            flat.append((src.plate_id, w))

    d = req.destination
    first_plate_seq = compute_destination_sequence(d.rows, d.cols, d.start_well, d.fill_direction)
    full_plate_seq = order_indices(d.rows, d.cols, d.fill_direction)  # 2枚目以降はA1から

    # マッピングの構築
    mapping = []
    plates: Dict[int, Dict[str, Dict]] = {}  # {plate_index: {well_label: info}}
    capacity_first = len(first_plate_seq)
    capacity_full = d.rows * d.cols

    # 色割当（plate_idごと）
    palette = default_palette()
    color_by_plate: Dict[str, str] = {}
    for i, src in enumerate(req.sources):
        color_by_plate[src.plate_id] = src.color or palette[i % len(palette)]

    def add_to_plate(pi: int, dest_rc: Tuple[int,int], src_plate: str, src_well: str):
        wl = well_label(*dest_rc)
        mapping.append({
            "dest_plate_index": pi,
            "dest_well": wl,
            "source_plate": src_plate,
            "source_well": src_well
        })
        plates.setdefault(pi, {})
        label = None
        if req.annotate in ("source_well", "both"):
            label = src_well
        elif req.annotate == "source_plate":
            label = src_plate
        info = {
            "well": wl,
            "label": label,
            "source_plate": src_plate,
            "source_well": src_well,
            "color": color_by_plate[src_plate]
        }
        plates[pi][wl] = info

    # 実際に詰める
    i = 0   # flat index
    plate_idx = 1
    # 1枚目
    for rc in first_plate_seq:
        if i >= len(flat):
            break
        add_to_plate(plate_idx, rc, flat[i][0], flat[i][1])
        i += 1
    # 2枚目以降
    while i < len(flat):
        plate_idx += 1
        for rc in full_plate_seq:
            if i >= len(flat):
                break
            add_to_plate(plate_idx, rc, flat[i][0], flat[i][1])
            i += 1

    # plates 配列に整形
    plates_arr = []
    for pi in sorted(plates.keys()):
        wells_list = list(plates[pi].values())
        plates_arr.append({
            "plate_index": pi,
            "rows": d.rows,
            "cols": d.cols,
            "wells": wells_list
        })

    result = {
        "stats": {
            "total_sources": len(req.sources),
            "total_picked": len(flat),
            "dest_plates": len(plates_arr)
        },
        "mapping": mapping,
        "plates": plates_arr
    }
    return result

# ---------- 描画 ----------

def draw_plate_image(plate: Dict, cell: int = 48, margin_x: int = 90, margin_y: int = 80) -> Image.Image:
    rows = plate["rows"]; cols = plate["cols"]
    w = margin_x*2 + cols*cell
    h = margin_y*2 + rows*cell
    img = Image.new("RGB", (w, h), "white")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 16)
        font_small = ImageFont.truetype("arial.ttf", 13)
        font_bold = ImageFont.truetype("arial.ttf", 18)
    except:
        font = ImageFont.load_default()
        font_small = ImageFont.load_default()
        font_bold = ImageFont.load_default()

    # 枠・グリッド
    # 列番号
    for c in range(cols):
        x = margin_x + c*cell + cell/2
        draw.text((x-6, margin_y-28), str(c+1), fill="black", font=font)

    # 行ラベル
    for r in range(rows):
        y = margin_y + r*cell + cell/2
        draw.text((margin_x-50, y-8), index_to_letters(r), fill="black", font=font)

    # wells
    wells_info = {w["well"]: w for w in plate["wells"]}
    r_circle = int(cell*0.32)
    for r in range(rows):
        for c in range(cols):
            cx = margin_x + c*cell + cell/2
            cy = margin_y + r*cell + cell/2
            wl = well_label(r, c)
            circle_bbox = [cx-r_circle, cy-r_circle, cx+r_circle, cy+r_circle]
            if wl in wells_info:
                fill = wells_info[wl]["color"]
                draw.ellipse(circle_bbox, fill=fill, outline="black", width=2)
                lbl = wells_info[wl]["label"]
                if lbl:
                    tw, th = draw.textsize(lbl, font=font_small)
                    draw.text((cx - tw/2, cy - th/2), lbl, fill="black", font=font_small)
            else:
                draw.ellipse(circle_bbox, fill="#F2F2F2", outline="#CCCCCC", width=1)

    # タイトル
    title = f"Plate {plate['plate_index']}  ({rows} x {cols})"
    draw.text((margin_x, 20), title, fill="black", font=font_bold)

    return img

def compose_many(plates: List[Dict], per_row: int = 1, cell: int = 48) -> Image.Image:
    imgs = [draw_plate_image(p, cell=cell) for p in plates]
    if not imgs:
        return Image.new("RGB", (600, 400), "white")
    w, h = imgs[0].size
    cols = max(1, per_row)
    rows = math.ceil(len(imgs)/cols)
    canvas = Image.new("RGB", (w*cols, h*rows), "white")
    for i, im in enumerate(imgs):
        r = i // cols
        c = i % cols
        canvas.paste(im, (c*w, r*h))
    # 簡易凡例
    # plates[0]["wells"] から plate_id 色の一覧を作る代わりに、呼び出し側で凡例画像を別途返してもよい
    return canvas

# ---------- API ----------

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/pack")
def pack(req: PackRequest):
    try:
        result = pack_wells(req)
        return JSONResponse(result)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

@app.post("/pack/tsv")
def pack_tsv(req: PackRequest):
    try:
        result = pack_wells(req)
        lines = ["dest_plate\tdest_well\tsource_plate\tsource_well"]
        for m in result["mapping"]:
            lines.append(f"{m['dest_plate_index']}\t{m['dest_well']}\t{m['source_plate']}\t{m['source_well']}")
        tsv = "\n".join(lines)
        headers = {"Content-Disposition": "attachment; filename=packing.tsv"}
        return PlainTextResponse(tsv, headers=headers, media_type="text/tab-separated-values")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

@app.post("/render.png")
def render_png(req: PackRequest, per_row: int = 1, cell: int = 48, filename: Optional[str] = None):
    try:
        result = pack_wells(req)
        img = compose_many(result["plates"], per_row=per_row, cell=cell)
        buf = BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        headers = {}
        if filename:
            headers["Content-Disposition"] = f'attachment; filename="{filename}.png"'
        return StreamingResponse(buf, media_type="image/png", headers=headers)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
