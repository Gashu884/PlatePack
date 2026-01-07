"""FastAPI application entrypoint for PlatePack HTML API."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import HTMLResponse

from api.generate_html import ReportRequest, build_html_report, sample_payload

app = FastAPI(
    title="PlatePack HTML API",
    version="1.0.0",
    description="Generate printable HTML reports for plate packing plans.",
)

INDEX_PATH = Path("index.html")
PLATES_PATH = Path("plates.html")
RESULTS_PATH = Path("results.html")


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
