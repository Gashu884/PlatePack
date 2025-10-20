"\"\"\"Serverless entrypoint for generating HTML plates reports via API.\"\"\"

from __future__ import annotations

from datetime import datetime
from html import escape
import re
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, validator

app = FastAPI(
    title="PlatePack HTML API",
    version="1.0.0",
    description="Creates printable HTML reports for plate packing plans.",
)

_WELL_RE = re.compile(r"^([A-Za-z]+)(\d+)$")


def _letters_to_index(value: str) -> int:
    value = value.upper()
    total = 0
    for char in value:
        total = total * 26 + (ord(char) - 64)
    return total - 1


def _index_to_letters(index: int) -> str:
    index += 1
    letters: List[str] = []
    while index:
        index, remainder = divmod(index - 1, 26)
        letters.append(chr(65 + remainder))
    return "".join(reversed(letters))


def _parse_well(label: str) -> Optional[Dict[str, int]]:
    match = _WELL_RE.match(label.strip().upper())
    if not match:
        return None
    row_label, col_text = match.groups()
    row = _letters_to_index(row_label)
    col = int(col_text) - 1
    return {"row": row, "col": col, "row_label": row_label, "col_label": col_text}


class SourcePlate(BaseModel):
    plate_id: str = Field(..., description="Identifier for the source plate.")
    wells: List[str] = Field(default_factory=list, description="Selected wells on the plate.")
    description: Optional[str] = Field(default=None, description="Optional free-form description.")

    @validator("wells", each_item=True)
    def _validate_well(cls, value: str) -> str:
        info = _parse_well(value)
        if info is None:
            raise ValueError(f"Invalid well label: {value}")
        return f"{info['row_label']}{info['col_label']}"


class DestinationAssignment(BaseModel):
    well: str = Field(..., description="Destination well label, e.g. A1.")
    source_plate: Optional[str] = Field(default=None, description="Origin plate ID.")
    source_well: Optional[str] = Field(default=None, description="Origin well label.")
    label: Optional[str] = Field(
        default=None, description="Custom label rendered inside the well cell."
    )

    @validator("well")
    def _validate_well(cls, value: str) -> str:
        info = _parse_well(value)
        if info is None:
            raise ValueError(f"Invalid destination well label: {value}")
        return f"{info['row_label']}{info['col_label']}"

    @validator("source_well")
    def _validate_source_well(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        info = _parse_well(value)
        if info is None:
            raise ValueError(f"Invalid source well label: {value}")
        return f"{info['row_label']}{info['col_label']}"


class DestinationPlate(BaseModel):
    plate_id: str = Field(..., description="Identifier for the destination plate.")
    rows: int = Field(8, ge=1, le=26)
    cols: int = Field(12, ge=1)
    assignments: List[DestinationAssignment] = Field(default_factory=list)

    @validator("assignments", each_item=True)
    def _check_bounds(cls, assignment: DestinationAssignment, values) -> DestinationAssignment:
        rows = values.get("rows", 8)
        cols = values.get("cols", 12)
        info = _parse_well(assignment.well)
        assert info is not None  # already validated
        if info["row"] >= rows or info["col"] >= cols:
            raise ValueError(
                f"Destination well {assignment.well} exceeds plate bounds ({rows}x{cols})."
            )
        return assignment


class PlanEntry(BaseModel):
    source_plate: str
    source_well: str
    destination_plate: str
    destination_well: str

    @validator("source_well", "destination_well")
    def _validate(cls, value: str) -> str:
        info = _parse_well(value)
        if info is None:
            raise ValueError(f"Invalid well label: {value}")
        return f"{info['row_label']}{info['col_label']}"


class ReportRequest(BaseModel):
    title: str = Field("Plates Packing Report", description="Document title.")
    analyst: Optional[str] = Field(default=None, description="Person in charge.")
    run_date: Optional[str] = Field(
        default=None, description="ISO8601 timestamp to show in the report."
    )
    notes: Optional[str] = Field(default=None, description="Free-form notes section.")
    sources: List[SourcePlate] = Field(default_factory=list)
    destinations: List[DestinationPlate] = Field(default_factory=list)
    plan: List[PlanEntry] = Field(default_factory=list, description="Optional explicit mapping.")

    @validator("run_date", pre=True, always=True)
    def _default_run_date(cls, value: Optional[str]) -> str:
        if value:
            return value
        return datetime.utcnow().isoformat(timespec="seconds") + "Z"

    @validator("title")
    def _strip_title(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("title must not be empty.")
        return cleaned


def _default_palette() -> List[str]:
    return [
        "#1d4ed8",
        "#dc2626",
        "#16a34a",
        "#f97316",
        "#0d9488",
        "#7c3aed",
        "#eab308",
        "#2563eb",
        "#c026d3",
        "#ea580c",
        "#0891b2",
        "#f59e0b",
    ]


def build_html_report(payload: ReportRequest) -> str:
    stats = {
        "sources": len(payload.sources),
        "total_wells": sum(len(src.wells) for src in payload.sources),
        "destinations": len(payload.destinations),
    }

    legend_sources: Set[str] = {src.plate_id for src in payload.sources}
    for assignment in payload.destinations:
        for well in assignment.assignments:
            if well.source_plate:
                legend_sources.add(well.source_plate)
    for entry in payload.plan:
        legend_sources.add(entry.source_plate)

    palette = _default_palette()
    color_by_source = {
        source_id: palette[idx % len(palette)]
        for idx, source_id in enumerate(sorted(legend_sources))
    }

    def render_sources() -> str:
        if not payload.sources:
            return "<p class=\"muted\">No source plates provided.</p>"
        items = []
        for src in payload.sources:
            wells = len(src.wells)
            desc = f" — {escape(src.description)}" if src.description else ""
            items.append(
                f"<li><span class=\"badge\" style=\"background:{color_by_source.get(src.plate_id, '#94a3b8')}\"></span>"
                f"{escape(src.plate_id)} <small>({wells} wells)</small>{desc}</li>"
            )
        return "<ul class=\"source-list\">" + "".join(items) + "</ul>"

    def render_legend() -> str:
        if not legend_sources:
            return ""
        items = "".join(
            f"<li><span class=\"badge\" style=\"background:{color_by_source[source]}\"></span>{escape(source)}</li>"
            for source in sorted(legend_sources)
        )
        return f"<section><h2>Legend</h2><ul class=\"legend\">{items}</ul></section>"

    def render_plate_table(plate: DestinationPlate) -> str:
        assignments: Dict[tuple, DestinationAssignment] = {}
        for assignment in plate.assignments:
            info = _parse_well(assignment.well)
            assert info is not None
            assignments[(info["row"], info["col"])] = assignment

        header_cells = "".join(
            f"<th scope=\"col\">{col + 1}</th>" for col in range(plate.cols)
        )

        body_rows = []
        for row_idx in range(plate.rows):
            row_label = _index_to_letters(row_idx)
            cells = []
            for col_idx in range(plate.cols):
                assignment = assignments.get((row_idx, col_idx))
                cell_color = "#ffffff"
                text = ""
                if assignment:
                    source_id = assignment.source_plate or ""
                    cell_color = color_by_source.get(source_id, "#e2e8f0")
                    if assignment.label:
                        text = escape(assignment.label)
                    elif assignment.source_plate and assignment.source_well:
                        text = escape(f"{assignment.source_plate} · {assignment.source_well}")
                    elif assignment.source_plate:
                        text = escape(assignment.source_plate)
                cells.append(
                    f"<td style=\"background:{cell_color};\">{text}</td>"
                )
            body_rows.append(
                f"<tr><th scope=\"row\">{row_label}</th>{''.join(cells)}</tr>"
            )

        return f"""
            <section class="plate">
              <h3>{escape(plate.plate_id)} (rows: {plate.rows}, cols: {plate.cols})</h3>
              <table>
                <thead>
                  <tr><th scope="col">Row</th>{header_cells}</tr>
                </thead>
                <tbody>
                  {''.join(body_rows)}
                </tbody>
              </table>
            </section>
        """

    def render_destinations() -> str:
        if not payload.destinations:
            return "<p class=\"muted\">No destination plates supplied.</p>"
        return "".join(render_plate_table(plate) for plate in payload.destinations)

    def render_plan_table() -> str:
        plan_rows: List[PlanEntry] = payload.plan[:]
        if not plan_rows:
            for plate in payload.destinations:
                for assignment in plate.assignments:
                    if assignment.source_plate and assignment.source_well:
                        plan_rows.append(
                            PlanEntry(
                                source_plate=assignment.source_plate,
                                source_well=assignment.source_well,
                                destination_plate=plate.plate_id,
                                destination_well=assignment.well,
                            )
                        )
        if not plan_rows:
            return "<p class=\"muted\">No mapping information available.</p>"

        rows_html = "".join(
            f"<tr>"
            f"<td>{escape(entry.source_plate)}</td>"
            f"<td>{escape(entry.source_well)}</td>"
            f"<td>{escape(entry.destination_plate)}</td>"
            f"<td>{escape(entry.destination_well)}</td>"
            f"</tr>"
            for entry in plan_rows
        )
        return f"""
            <table>
              <thead>
                <tr>
                  <th scope="col">Source Plate</th>
                  <th scope="col">Source Well</th>
                  <th scope="col">Destination Plate</th>
                  <th scope="col">Destination Well</th>
                </tr>
              </thead>
              <tbody>
                {rows_html}
              </tbody>
            </table>
        """

    notes_html = ""
    if payload.notes:
        notes_html = f"<section><h2>Notes</h2><p>{escape(payload.notes)}</p></section>"

    dest_section = render_destinations()
    legend_section = render_legend()
    plan_section = render_plan_table()

    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{escape(payload.title)}</title>
    <style>
      :root {{
        color-scheme: light;
        font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }}
      body {{
        margin: 0;
        padding: 2.5rem clamp(1.5rem, 5vw, 4rem);
        background: #f4f6fb;
        color: #1f2937;
      }}
      header {{
        margin-bottom: 2rem;
      }}
      h1 {{
        margin: 0;
        font-size: clamp(1.8rem, 3vw, 2.4rem);
      }}
      .meta {{
        margin-top: 0.75rem;
        display: flex;
        flex-wrap: wrap;
        gap: 1.25rem;
        color: #4b5563;
        font-size: 0.95rem;
      }}
      section {{
        margin-bottom: 2.5rem;
      }}
      h2 {{
        margin-bottom: 0.75rem;
        color: #1d4ed8;
      }}
      h3 {{
        margin-bottom: 0.5rem;
        color: #4338ca;
      }}
      table {{
        width: 100%;
        border-collapse: collapse;
        background: #fff;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
        border-radius: 16px;
        overflow: hidden;
      }}
      thead {{
        background: linear-gradient(135deg, #1d4ed8, #4338ca);
        color: #fff;
      }}
      th, td {{
        padding: 0.65rem;
        text-align: center;
        border-bottom: 1px solid #e5e7eb;
        font-size: 0.9rem;
      }}
      tbody th {{
        background: #f1f5f9;
        text-align: left;
        font-weight: 600;
      }}
      td {{
        min-width: 72px;
      }}
      ul {{
        margin: 0;
        padding-left: 1.2rem;
      }}
      .legend {{
        list-style: none;
        padding-left: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem 1.25rem;
      }}
      .legend li {{
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.95rem;
      }}
      .source-list {{
        list-style: none;
        padding-left: 0;
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
      }}
      .source-list li {{
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
      }}
      .badge {{
        display: inline-block;
        width: 14px;
        height: 14px;
        border-radius: 4px;
        border: 1px solid rgba(15, 23, 42, 0.12);
      }}
      .muted {{
        color: #9ca3af;
        font-style: italic;
      }}
      footer {{
        margin-top: 3rem;
        text-align: right;
        font-size: 0.85rem;
        color: #6b7280;
      }}
    </style>
  </head>
  <body>
    <header>
      <h1>{escape(payload.title)}</h1>
      <div class="meta">
        <span><strong>Run date:</strong> {escape(payload.run_date)}</span>
        <span><strong>Destination plates:</strong> {stats['destinations']}</span>
        <span><strong>Total wells:</strong> {stats['total_wells']}</span>
        {f"<span><strong>Analyst:</strong> {escape(payload.analyst)}</span>" if payload.analyst else ""}
      </div>
    </header>

    <section>
      <h2>Source Plates</h2>
      {render_sources()}
    </section>

    {legend_section}

    <section>
      <h2>Destination Layouts</h2>
      {dest_section}
    </section>

    <section>
      <h2>Picking Plan</h2>
      {plan_section}
    </section>

    {notes_html}

    <footer>
      Generated by PlatePack HTML API · {escape(payload.run_date)}
    </footer>
  </body>
</html>"""


@app.post("/", response_class=Response)
def generate_html(payload: ReportRequest) -> Response:
    try:
        html = build_html_report(payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(content=html, media_type="text/html; charset=utf-8")


@app.get("/sample", response_model=ReportRequest)
def sample_payload() -> ReportRequest:
    """Handy sample data for quick testing."""
    return ReportRequest(
        title="QC Packing Run",
        analyst="A. Analyst",
        sources=[
            SourcePlate(
                plate_id="SRC-001",
                wells=["A1", "A2", "B1"],
                description="Positive controls",
            ),
            SourcePlate(
                plate_id="SRC-002",
                wells=["C3", "C4", "D5"],
                description="Patient cohort A",
            ),
        ],
        destinations=[
            DestinationPlate(
                plate_id="DEST-001",
                rows=8,
                cols=12,
                assignments=[
                    DestinationAssignment(
                        well="A1",
                        source_plate="SRC-001",
                        source_well="A1",
                    ),
                    DestinationAssignment(
                        well="A2",
                        source_plate="SRC-001",
                        source_well="A2",
                    ),
                    DestinationAssignment(
                        well="B1",
                        source_plate="SRC-002",
                        source_well="C3",
                    ),
                ],
            )
        ],
        notes="Autogenerated sample payload. Replace with your data.",
    )
