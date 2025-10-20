# api/pack.py
from fastapi import FastAPI, HTTPException, Response, Request
from fastapi.responses import StreamingResponse, PlainTextResponse, JSONResponse
from pydantic import BaseModel, Field, validator
from typing import List, Literal, Optional, Dict, Tuple
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont
import math, re

app = FastAPI(title="Plates Packer API", version="1.0.0")

# ---------- utils ----------
_well_re = re.compile(r"^([A-Za-z]+)(\d+)$")

def letters_to_index(s: str) -> int:
    s = s.upper(); n = 0
    for ch in s: n = n*26 + (ord(ch)-64)
    return n-1

def index_to_letters(i: int) -> str:
    i += 1; r=[]
    while i: i, m = divmod(i-1, 26); r.append(chr(65+m))
    return "".join(reversed(r))

def parse_well(label: str) -> Tuple[int, int]:
    m = _well_re.match(label.strip())
    if not m: raise ValueError(f"Invalid well label: {label}")
    return letters_to_index(m.group(1)), int(m.group(2))-1

def well_label(r: int, c: int) -> str:
    return f"{index_to_letters(r)}{c+1}"

def order_indices(rows: int, cols: int, direction: str):
    return ([(r,c) for r in range(rows) for c in range(cols)]
            if direction=="row" else
            [(r,c) for c in range(cols) for r in range(rows)])

def clamp_well_in_plate(label: str, rows: int, cols: int) -> None:
    r,c = parse_well(label)
    if r<0 or r>=rows or c<0 or c>=cols:
        raise ValueError(f"Well {label} is out of bounds for a {rows}x{cols} plate.")

# ---------- models ----------
class SourceConfig(BaseModel):
    plate_id: str
    rows: int = Field(8, ge=1, le=26)
    cols: int = Field(12, ge=1)
    selected_wells: List[str]
    order: Literal["row","column","given"] = "row"
    color: Optional[str] = None
    @validator("selected_wells")
    def _non_empty(cls, v):
        if not v: raise ValueError("selected_wells must not be empty.")
        return v
    @validator("selected_wells", each_item=True)
    def _well_format(cls, w, values):
        clamp_well_in_plate(w, values.get("rows",8), values.get("cols",12))
        return w

class DestinationConfig(BaseModel):
    rows: int = Field(8, ge=1, le=26)
    cols: int = Field(12, ge=1)
    fill_direction: Literal["row","column"] = "row"
    start_well: str = "A1"
    plate_name_prefix: str = "Dest"
    @validator("start_well")
    def _check_start(cls, w, values):
        clamp_well_in_plate(w, values.get("rows",8), values.get("cols",12))
        return w

class PackRequest(BaseModel):
    sources: List[SourceConfig]
    destination: DestinationConfig = DestinationConfig()
    annotate: Literal["none","source_plate","source_well","both"] = "both"
    serpentine: bool = False

# ---------- core ----------
def default_palette():
    return ["#4472C4","#ED7D31","#A5A5A5","#FFC000","#5B9BD5",
            "#70AD47","#264478","#9E480E","#636363","#997300",
            "#255E91","#43682B","#7030A0","#C00000","#00B0F0",
            "#92D050","#7F7F7F","#FFD966","#2F5597","#B85450"]

def _sort_wells(wells: List[str], order: str) -> List[str]:
    if order=="given": return wells
    keyed=[(*parse_well(w), w) for w in wells]
    keyed.sort(key=(lambda x:(x[0],x[1])) if order=="row" else (lambda x:(x[1],x[0])))
    return [w for _,_,w in keyed]

def compute_destination_sequence(rows:int, cols:int, start_well:str, direction:str):
    seq = order_indices(rows, cols, direction)
    sr,sc = parse_well(start_well)
    return seq[seq.index((sr,sc)):]

def pack_wells(req: PackRequest):
    flat=[]
    for src in req.sources:
        for w in _sort_wells(src.selected_wells, src.order):
            flat.append((src.plate_id, w))

    d = req.destination
    first_seq = compute_destination_sequence(d.rows, d.cols, d.start_well, d.fill_direction)
    full_seq  = order_indices(d.rows, d.cols, d.fill_direction)

    palette = default_palette()
    color_by_plate = {s.plate_id: (s.color or palette[i%len(palette)])
                      for i,s in enumerate(req.sources)}

    mapping=[]; plates={}
    def add(pi, rc, sp, sw):
        wl = well_label(*rc)
        mapping.append({"dest_plate_index":pi,"dest_well":wl,"source_plate":sp,"source_well":sw})
        plates.setdefault(pi,{})
        label=None
        if req.annotate in ("source_well","both"): label = sw
        elif req.annotate=="source_plate": label = sp
        plates[pi][wl]={"well":wl,"label":label,"source_plate":sp,"source_well":sw,"color":color_by_plate[sp]}

    i=0; plate_idx=1
    for rc in first_seq:
        if i>=len(flat): break
        add(plate_idx, rc, flat[i][0], flat[i][1]); i+=1
    while i<len(flat):
        plate_idx += 1
        for rc in full_seq:
            if i>=len(flat): break
            add(plate_idx, rc, flat[i][0], flat[i][1]); i+=1

    plates_arr=[]
    for pi in sorted(plates.keys()):
        plates_arr.append({"plate_index":pi, "rows":d.rows, "cols":d.cols, "wells":list(plates[pi].values())})

    return {"stats":{"total_sources":len(req.sources),"total_picked":len(flat),"dest_plates":len(plates_arr)},
            "mapping":mapping, "plates":plates_arr}

# ---------- drawing ----------
def draw_plate_image(plate: Dict, cell:int=48, mx:int=90, my:int=80):
    rows,cols = plate["rows"], plate["cols"]
    w,h = mx*2+cols*cell, my*2+rows*cell
    img = Image.new("RGB",(w,h),"white"); dr = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf",16)
        small= ImageFont.truetype("arial.ttf",13)
        bold = ImageFont.truetype("arial.ttf",18)
    except:
        font = small = bold = ImageFont.load_default()

    for c in range(cols):
        x = mx + c*cell + cell/2
        dr.text((x-6, my-28), str(c+1), fill="black", font=font)
    for r in range(rows):
        y = my + r*cell + cell/2
        dr.text((mx-50, y-8), index_to_letters(r), fill="black", font=font)

    info = {w["well"]: w for w in plate["wells"]}
    rad = int(cell*0.32)
    for r in range(rows):
        for c in range(cols):
            cx = mx + c*cell + cell/2
            cy = my + r*cell + cell/2
            wl = well_label(r,c)
            box=[cx-rad, cy-rad, cx+rad, cy+rad]
            if wl in info:
                dr.ellipse(box, fill=info[wl]["color"], outline="black", width=2)
                if info[wl]["label"]:
                    tw,th = dr.textsize(info[wl]["label"], font=small)
                    dr.text((cx-tw/2, cy-th/2), info[wl]["label"], fill="black", font=small)
            else:
                dr.ellipse(box, fill="#F2F2F2", outline="#CCCCCC", width=1)
    dr.text((mx,20), f"Plate {plate['plate_index']}  ({rows} x {cols})", fill="black", font=bold)
    return img

def compose_many(plates: List[Dict], per_row:int=1, cell:int=48):
    imgs=[draw_plate_image(p, cell=cell) for p in plates]
    if not imgs: return Image.new("RGB",(600,400),"white")
    w,h = imgs[0].size
    cols=max(1,per_row); rows=math.ceil(len(imgs)/cols)
    canvas = Image.new("RGB",(w*cols,h*rows),"white")
    for i,im in enumerate(imgs):
        r=i//cols; c=i%cols
        canvas.paste(im,(c*w,r*h))
    return canvas

# ---------- FastAPI routes ----------
@app.get("/health")
def health(): return {"ok": True}

@app.post("/pack")
def pack(req: PackRequest):
    try: return JSONResponse(pack_wells(req))
    except ValueError as e: raise HTTPException(status_code=422, detail=str(e))

@app.post("/pack/tsv")
def pack_tsv(req: PackRequest):
    try:
        result = pack_wells(req)
        lines=["dest_plate\tdest_well\tsource_plate\tsource_well"]
        for m in result["mapping"]:
            lines.append(f"{m['dest_plate_index']}\t{m['dest_well']}\t{m['source_plate']}\t{m['source_well']}")
        tsv="\n".join(lines)
        return PlainTextResponse(tsv, media_type="text/tab-separated-values",
                                 headers={"Content-Disposition":"attachment; filename=packing.tsv"})
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

@app.post("/render.png")
def render_png(req: PackRequest, per_row:int=1, cell:int=48, filename: Optional[str]=None):
    try:
        result = pack_wells(req)
        img = compose_many(result["plates"], per_row=per_row, cell=cell)
        buf = BytesIO(); img.save(buf, format="PNG"); buf.seek(0)
        headers = {}
        if filename: headers["Content-Disposition"] = f'attachment; filename="{filename}.png"'
        return StreamingResponse(buf, media_type="image/png", headers=headers)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
