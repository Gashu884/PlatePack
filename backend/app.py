"""FastAPI application entrypoint for PlatePack HTML API."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

try:
    from backend.api.generate_html import ReportRequest, build_html_report, sample_payload
    from backend.api.logs_db import (
        FolderConflictError, RecordNotFoundError, StorageValidationError,
        copy_log, create_folder, create_log, delete_log, get_log, init_db,
        list_folders, list_logs, storage_health, update_folder, update_log,
    )
except ModuleNotFoundError:  # pragma: no cover
    from api.generate_html import ReportRequest, build_html_report, sample_payload
    from api.logs_db import (
        FolderConflictError, RecordNotFoundError, StorageValidationError,
        copy_log, create_folder, create_log, delete_log, get_log, init_db,
        list_folders, list_logs, storage_health, update_folder, update_log,
    )

app = FastAPI(
    title="PlatePack HTML API",
    version="1.0.0",
    description="Generate printable HTML reports for plate packing plans.",
)

ROOT_DIR = Path(__file__).resolve().parent.parent
HOME_HTML_PATH = ROOT_DIR / "frontend" / "home.html"
PACKER_HTML_PATH = ROOT_DIR / "frontend" / "app.html"
DATABASE_HTML_PATH = ROOT_DIR / "frontend" / "database.html"


class LogCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    payload: dict = Field(default_factory=dict)
    project_id: str | None = Field(default=None, min_length=1, max_length=128)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Log name must not be blank.")
        return cleaned


class LogSummaryResponse(BaseModel):
    record_type: str = "plate"
    id: str
    name: str
    created_at: str
    project_id: str
    updated_at: str


class LogEntryResponse(LogSummaryResponse):
    payload: dict


class LogUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=120)
    project_id: str | None = Field(default=None, min_length=1, max_length=128)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("Log name must not be blank.")
        return value.strip() if value is not None else None

    @model_validator(mode="after")
    def validate_update(self):
        if self.name is None and self.project_id is None:
            raise ValueError("Provide a log name or project folder.")
        if "project_id" in self.model_fields_set and self.project_id is None:
            raise ValueError("A plate log must belong to a project folder.")
        return self


class LogCopyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str = Field(..., min_length=1, max_length=128)


class FolderCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str | None = Field(default=None, min_length=1, max_length=128)
    name: str = Field(..., min_length=1, max_length=120)
    kind: str = Field(..., pattern="^(person|project)$")
    parent_id: str | None = Field(default=None, min_length=1, max_length=128)


class FolderUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=120)
    parent_id: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_update(self):
        if not self.model_fields_set:
            raise ValueError("Provide a folder name or parent.")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("Folder name must not be blank.")
        return self


class FolderResponse(BaseModel):
    id: str
    name: str
    kind: str
    parent_id: str | None
    created_at: str
    updated_at: str
    log_count: int = 0
    project_count: int = 0


class StorageHealthResponse(BaseModel):
    available: bool
    durable: bool
    backend: str
    message: str


@app.on_event("startup")
def _startup() -> None:
    init_db()


def _serve_html(path: Path, label: str) -> HTMLResponse:
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{label} not found.")
    return HTMLResponse(path.read_text(encoding="utf-8"))


@app.get("/", response_class=HTMLResponse)
def serve_index() -> HTMLResponse:
    """Return the Home page."""
    return _serve_html(HOME_HTML_PATH, "frontend/home.html")


@app.get("/plates", response_class=HTMLResponse)
def serve_plates() -> HTMLResponse:
    """Return the Packer page."""
    return _serve_html(PACKER_HTML_PATH, "frontend/app.html")


@app.get("/results", response_class=HTMLResponse)
def serve_results() -> HTMLResponse:
    """Return the Database page."""
    return _serve_html(DATABASE_HTML_PATH, "frontend/database.html")


@app.get("/assets/storage.js")
def serve_storage_script() -> FileResponse:
    script_path = ROOT_DIR / "frontend" / "storage.js"
    if not script_path.exists():
        raise HTTPException(status_code=404, detail="Storage script not found.")
    return FileResponse(script_path, media_type="text/javascript; charset=utf-8")


# Register after the compatibility route above so existing pages can still load storage.js.
app.mount("/assets", StaticFiles(directory=ROOT_DIR / "frontend" / "assets", check_dir=False), name="assets")


def _storage_call(action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except FolderConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RecordNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except StorageValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/storage-health", response_model=StorageHealthResponse)
def api_storage_health() -> StorageHealthResponse:
    return StorageHealthResponse(**storage_health())


@app.get("/api/logs", response_model=list[LogSummaryResponse])
def api_list_logs(
    limit: int = Query(50, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    project_id: str | None = Query(None, min_length=1, max_length=128),
) -> list[LogSummaryResponse]:
    logs = _storage_call(list_logs, limit=limit, project_id=project_id, offset=offset)
    return [LogSummaryResponse.model_validate(log, from_attributes=True) for log in logs]


@app.post("/api/logs", response_model=LogSummaryResponse)
def api_create_log(body: LogCreateRequest) -> LogSummaryResponse:
    log = _storage_call(create_log, name=body.name, payload=body.payload, project_id=body.project_id)
    return LogSummaryResponse.model_validate(log, from_attributes=True)


@app.get("/api/logs/{log_id}", response_model=LogEntryResponse)
def api_get_log(log_id: str) -> LogEntryResponse:
    log = _storage_call(get_log, log_id)
    if log is None:
        raise HTTPException(status_code=404, detail="log not found")
    return LogEntryResponse.model_validate(log, from_attributes=True)


@app.patch("/api/logs/{log_id}", response_model=LogSummaryResponse)
def api_update_log(log_id: str, body: LogUpdateRequest) -> LogSummaryResponse:
    log = _storage_call(update_log, log_id, name=body.name, project_id=body.project_id)
    if log is None:
        raise HTTPException(status_code=404, detail="log not found")
    return LogSummaryResponse.model_validate(log, from_attributes=True)


@app.post("/api/logs/{log_id}/copy", response_model=LogSummaryResponse)
def api_copy_log(log_id: str, body: LogCopyRequest) -> LogSummaryResponse:
    log = _storage_call(copy_log, log_id, project_id=body.project_id)
    if log is None:
        raise HTTPException(status_code=404, detail="log not found")
    return LogSummaryResponse.model_validate(log, from_attributes=True)


@app.delete("/api/logs/{log_id}")
def api_delete_log(log_id: str) -> dict:
    deleted = _storage_call(delete_log, log_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="log not found")
    return {"ok": True}


@app.get("/api/folders", response_model=list[FolderResponse])
def api_list_folders() -> list[FolderResponse]:
    folders = _storage_call(list_folders)
    return [FolderResponse.model_validate(folder, from_attributes=True) for folder in folders]


@app.post("/api/folders", response_model=FolderResponse)
def api_create_folder(body: FolderCreateRequest) -> FolderResponse:
    folder = _storage_call(create_folder, body.name, body.kind, parent_id=body.parent_id, folder_id=body.id)
    return FolderResponse.model_validate(folder, from_attributes=True)


@app.patch("/api/folders/{folder_id}", response_model=FolderResponse)
def api_update_folder(folder_id: str, body: FolderUpdateRequest) -> FolderResponse:
    changes = body.model_dump(exclude_unset=True)
    folder = _storage_call(update_folder, folder_id, **changes)
    if folder is None:
        raise HTTPException(status_code=404, detail="folder not found")
    return FolderResponse.model_validate(folder, from_attributes=True)


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


from backend.gel.routes import router as electrophoresis_router
app.include_router(electrophoresis_router)

@app.get("/electrophoresis", response_class=HTMLResponse)
def serve_electrophoresis():
    return _serve_html(ROOT_DIR / "frontend" / "electrophoresis.html", "Electrophoresis")
