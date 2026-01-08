"""FastAPI application entrypoint for PlatePack HTML API."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from api.generate_html import ReportRequest, build_html_report, sample_payload
from api.logs_db import create_log, delete_log, get_log, init_db, list_logs

app = FastAPI(
    title="PlatePack HTML API",
    version="1.0.0",
    description="Generate printable HTML reports for plate packing plans.",
)

INDEX_PATH = Path("index.html")
PLATES_PATH = Path("plates.html")
RESULTS_PATH = Path("results.html")


class LogCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    payload: dict = Field(default_factory=dict)


class LogSummaryResponse(BaseModel):
    id: str
    name: str
    created_at: str


class LogEntryResponse(LogSummaryResponse):
    payload: dict


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/", response_class=HTMLResponse)
def serve_index() -> HTMLResponse:
    """Return the home page."""
    if not INDEX_PATH.exists():
        raise HTTPException(status_code=404, detail="index.html not found.")
    return HTMLResponse(INDEX_PATH.read_text(encoding="utf-8"))


@app.get("/plates", response_class=HTMLResponse)
def serve_plates() -> HTMLResponse:
    """Return the PlatePacker page."""
    if not PLATES_PATH.exists():
        raise HTTPException(status_code=404, detail="plates.html not found.")
    return HTMLResponse(PLATES_PATH.read_text(encoding="utf-8"))


@app.get("/results", response_class=HTMLResponse)
def serve_results() -> HTMLResponse:
    """Return the saved results page."""
    if not RESULTS_PATH.exists():
        raise HTTPException(status_code=404, detail="results.html not found.")
    return HTMLResponse(RESULTS_PATH.read_text(encoding="utf-8"))


@app.get("/api/logs", response_model=list[LogSummaryResponse])
def api_list_logs(limit: int = 50) -> list[LogSummaryResponse]:
    try:
        logs = list_logs(limit=limit)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return [LogSummaryResponse(id=log.id, name=log.name, created_at=log.created_at) for log in logs]


@app.post("/api/logs", response_model=LogSummaryResponse)
def api_create_log(body: LogCreateRequest) -> LogSummaryResponse:
    try:
        log = create_log(name=body.name.strip(), payload=body.payload or {})
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return LogSummaryResponse(id=log.id, name=log.name, created_at=log.created_at)


@app.get("/api/logs/{log_id}", response_model=LogEntryResponse)
def api_get_log(log_id: str) -> LogEntryResponse:
    try:
        log = get_log(log_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if log is None:
        raise HTTPException(status_code=404, detail="log not found")
    return LogEntryResponse(id=log.id, name=log.name, created_at=log.created_at, payload=log.payload)


@app.delete("/api/logs/{log_id}")
def api_delete_log(log_id: str) -> dict:
    try:
        deleted = delete_log(log_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="log not found")
    return {"ok": True}


@app.post("/generate-html", response_class=Response)
def generate_html(payload: ReportRequest) -> Response:
    """Convert structured plate data into an HTML report."""
    try:
        html = build_html_report(payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(content=html, media_type="text/html; charset=utf-8")


@app.get("/generate-html/sample", response_model=ReportRequest)
def get_sample_payload() -> ReportRequest:
    """Return sample JSON payload to bootstrap clients."""
    return sample_payload()
