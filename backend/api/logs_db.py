"""Log storage for PlatePack UI snapshots (SQLite locally, Postgres on Vercel)."""

from __future__ import annotations

import json
import os
import re
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4


def _default_db_path() -> Path:
    configured = os.getenv("PLATEPACK_DB_PATH")
    if configured:
        return Path(configured)
    # Vercel serverless filesystem is read-only except /tmp.
    if os.getenv("VERCEL"):
        return Path("/tmp/platepack.db")
    return Path("platepack.db")


DB_PATH = _default_db_path()

POSTGRES_DSN = (
    os.getenv("POSTGRES_URL")
    or os.getenv("POSTGRES_URL_NON_POOLING")
    or os.getenv("DATABASE_URL")
)

_HAS_POSTGRES = bool(POSTGRES_DSN)
psycopg = None
dict_row = None
Json = None
if _HAS_POSTGRES:
    try:
        import psycopg  # type: ignore
        from psycopg.rows import dict_row  # type: ignore
        from psycopg.types.json import Json  # type: ignore
    except Exception:  # pragma: no cover
        psycopg = None
        dict_row = None
        Json = None


class StorageUnavailableError(RuntimeError):
    """A storage failure with a safe, user-facing explanation."""


class RecordNotFoundError(LookupError):
    """The requested folder or log does not exist."""


class StorageValidationError(ValueError):
    """The requested hierarchy relationship is invalid."""


class FolderConflictError(ValueError):
    """A client-supplied folder ID already identifies a different folder."""


DEFAULT_PERSON_ID = "default-person"
DEFAULT_PROJECT_ID = "default-project"
_FOLDER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_UNSET = object()


def _is_vercel() -> bool:
    return bool(os.getenv("VERCEL"))


def _ensure_persistence_available() -> None:
    if _HAS_POSTGRES and (psycopg is None or Json is None):
        raise StorageUnavailableError(
            "The persistent database is configured, but its driver is unavailable. Please contact the administrator."
        )
    if _is_vercel() and not _HAS_POSTGRES:
        raise StorageUnavailableError(
            "Persistent storage is not configured on the server. Keep a downloaded backup until database storage is connected."
        )


@dataclass(frozen=True)
class LogSummary:
    id: str
    name: str
    created_at: str
    project_id: str
    updated_at: str


@dataclass(frozen=True)
class LogEntry(LogSummary):
    payload: Dict[str, Any]


@dataclass(frozen=True)
class Folder:
    id: str
    name: str
    kind: str
    parent_id: Optional[str]
    created_at: str
    updated_at: str
    log_count: int = 0
    project_count: int = 0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


@contextmanager
def _connect():
    import sqlite3

    conn = None
    try:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        # A successful commit flushes data to disk, and lock contention is retried.
        conn.execute("PRAGMA synchronous = FULL")
        with conn:
            yield conn
    except (sqlite3.Error, OSError) as exc:
        raise StorageUnavailableError(
            "Database storage is temporarily unavailable. Keep a downloaded backup and retry saving."
        ) from exc
    finally:
        if conn is not None:
            conn.close()


@contextmanager
def _pg_connect():
    _ensure_persistence_available()
    if not _HAS_POSTGRES or POSTGRES_DSN is None:
        raise StorageUnavailableError("Persistent database storage is not configured.")
    try:
        # autocommit=True persists each statement before returning an acknowledgement.
        with psycopg.connect(
            POSTGRES_DSN, autocommit=True, row_factory=dict_row, connect_timeout=5
        ) as conn:
            yield conn
    except (StorageUnavailableError, RecordNotFoundError, StorageValidationError, FolderConflictError):
        raise
    except Exception as exc:
        # Never expose connection strings, credentials, or provider errors to clients.
        raise StorageUnavailableError(
            "Database storage is temporarily unavailable. Keep a downloaded backup and retry saving."
        ) from exc



@contextmanager
def _database(*, write: bool = False, rollback: bool = False):
    """Run a complete operation atomically on either supported backend."""
    _ensure_persistence_available()
    if _HAS_POSTGRES:
        with _pg_connect() as conn:
            with conn.transaction(force_rollback=rollback):
                yield conn
    else:
        with _connect() as conn:
            if write:
                conn.execute("BEGIN IMMEDIATE")
            yield conn
            if rollback:
                conn.rollback()


def _execute(conn, sql: str, parameters: tuple = ()):
    return conn.execute(sql.replace("?", "%s") if _HAS_POSTGRES else sql, parameters)


def _initialize(conn) -> None:
    if _HAS_POSTGRES:
        # Serialize migrations across serverless instances; the lock ends with this transaction.
        conn.execute("SELECT pg_advisory_xact_lock(746892314)")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('person', 'project')),
          parent_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((kind = 'person' AND parent_id IS NULL) OR
                 (kind = 'project' AND parent_id IS NOT NULL))
        )"""
    )
    now = _now_iso()
    for folder_id, name, kind, parent_id in (
        (DEFAULT_PERSON_ID, "研究者 1", "person", None),
        (DEFAULT_PROJECT_ID, "プロジェクト 1", "project", DEFAULT_PERSON_ID),
    ):
        _execute(
            conn,
            "INSERT INTO folders (id, name, kind, parent_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
            (folder_id, name, kind, parent_id, now, now),
        )
    payload_type = "JSONB" if _HAS_POSTGRES else "TEXT"
    conn.execute(
        f"""CREATE TABLE IF NOT EXISTS logs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json {payload_type} NOT NULL,
          project_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
          updated_at TEXT
        )"""
    )
    if _HAS_POSTGRES:
        conn.execute("ALTER TABLE logs ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES folders(id) ON DELETE RESTRICT")
        conn.execute("ALTER TABLE logs ADD COLUMN IF NOT EXISTS updated_at TEXT")
    else:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(logs)").fetchall()}
        if "project_id" not in columns:
            conn.execute("ALTER TABLE logs ADD COLUMN project_id TEXT REFERENCES folders(id) ON DELETE RESTRICT")
        if "updated_at" not in columns:
            conn.execute("ALTER TABLE logs ADD COLUMN updated_at TEXT")
    # Only legacy rows are assigned to defaults. Existing moves and names remain untouched.
    _execute(conn, "UPDATE logs SET project_id = ? WHERE project_id IS NULL OR project_id = ''", (DEFAULT_PROJECT_ID,))
    conn.execute("UPDATE logs SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_project_created_at ON logs(project_id, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)")


def init_db() -> bool:
    try:
        with _database(write=True) as conn:
            _initialize(conn)
        return True
    except StorageUnavailableError:
        # Never fall back to another database or replace existing data on migration failure.
        return False


def _summary(row) -> LogSummary:
    return LogSummary(
        id=row["id"], name=row["name"], created_at=row["created_at"],
        project_id=row["project_id"], updated_at=row["updated_at"] or row["created_at"],
    )


def _folder(row) -> Folder:
    return Folder(
        id=row["id"], name=row["name"], kind=row["kind"], parent_id=row["parent_id"],
        created_at=row["created_at"], updated_at=row["updated_at"],
        log_count=row["log_count"] if "log_count" in row.keys() else 0,
        project_count=row["project_count"] if "project_count" in row.keys() else 0,
    )


def _validate_name(name: str) -> str:
    value = str(name).strip()
    if not value or len(value) > 120:
        raise StorageValidationError("Name must contain 1–120 characters.")
    return value


def _validate_folder_id(folder_id: str) -> str:
    if not isinstance(folder_id, str) or not _FOLDER_ID_RE.fullmatch(folder_id):
        raise StorageValidationError("Folder ID must contain 1–128 letters, digits, underscores or hyphens.")
    return folder_id


def _get_folder(conn, folder_id: str) -> Optional[Folder]:
    row = _execute(conn, "SELECT * FROM folders WHERE id = ?", (_validate_folder_id(folder_id),)).fetchone()
    return _folder(row) if row is not None else None


def _require_project(conn, project_id: Optional[str]) -> str:
    resolved = project_id if project_id is not None else DEFAULT_PROJECT_ID
    folder = _get_folder(conn, resolved)
    if folder is None:
        raise RecordNotFoundError("Project folder not found.")
    if folder.kind != "project":
        raise StorageValidationError("Plate logs must be stored inside a project folder.")
    return resolved


def _validate_parent(conn, kind: str, parent_id: Optional[str]) -> None:
    if kind == "person":
        if parent_id is not None:
            raise StorageValidationError("A person folder cannot have a parent.")
        return
    if kind != "project":
        raise StorageValidationError("Folder kind must be person or project.")
    if parent_id is None:
        raise StorageValidationError("A project folder must belong to a person folder.")
    parent = _get_folder(conn, parent_id)
    if parent is None:
        raise RecordNotFoundError("Person folder not found.")
    if parent.kind != "person":
        raise StorageValidationError("A project folder must belong directly to a person folder.")


def list_folders() -> List[Folder]:
    with _database() as conn:
        rows = conn.execute(
            """SELECT f.*,
              (SELECT COUNT(*) FROM logs l WHERE l.project_id = f.id OR l.project_id IN
                (SELECT p.id FROM folders p WHERE p.parent_id = f.id AND p.kind = 'project')) AS log_count,
              (SELECT COUNT(*) FROM folders p WHERE p.parent_id = f.id AND p.kind = 'project') AS project_count
            FROM folders f ORDER BY f.created_at, f.id"""
        ).fetchall()
    return [_folder(row) for row in rows]


def create_folder(name: str, kind: str, parent_id: Optional[str] = None, folder_id: Optional[str] = None) -> Folder:
    cleaned = _validate_name(name)
    resolved_id = _validate_folder_id(folder_id) if folder_id is not None else uuid4().hex
    with _database(write=True) as conn:
        # A client ID makes retries safe without creating duplicate folders.
        existing = _get_folder(conn, resolved_id)
        if existing is not None:
            if (existing.name, existing.kind, existing.parent_id) == (cleaned, kind, parent_id):
                return existing
            raise FolderConflictError("This folder ID already belongs to a different folder.")
        _validate_parent(conn, kind, parent_id)
        now = _now_iso()
        cursor = _execute(
            conn,
            "INSERT INTO folders (id, name, kind, parent_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
            (resolved_id, cleaned, kind, parent_id, now, now),
        )
        if cursor.rowcount == 0:
            existing = _get_folder(conn, resolved_id)
            if existing is None or (existing.name, existing.kind, existing.parent_id) != (cleaned, kind, parent_id):
                raise FolderConflictError("This folder ID already belongs to a different folder.")
            return existing
        return Folder(resolved_id, cleaned, kind, parent_id, now, now)


def update_folder(folder_id: str, name: Optional[str] = None, parent_id: Any = _UNSET) -> Optional[Folder]:
    with _database(write=True) as conn:
        lock = " FOR UPDATE" if _HAS_POSTGRES else ""
        row = _execute(conn, "SELECT * FROM folders WHERE id = ?" + lock, (_validate_folder_id(folder_id),)).fetchone()
        if row is None:
            return None
        existing = _folder(row)
        cleaned = _validate_name(name) if name is not None else existing.name
        parent = existing.parent_id if parent_id is _UNSET else parent_id
        _validate_parent(conn, existing.kind, parent)
        updated_at = _now_iso()
        _execute(conn, "UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?",
                 (cleaned, parent, updated_at, folder_id))
        return Folder(existing.id, cleaned, existing.kind, parent, existing.created_at, updated_at)


def storage_health() -> Dict[str, Any]:
    """Verify durable database writes, without retaining a probe log."""
    backend = "postgres" if _HAS_POSTGRES else ("unconfigured" if _is_vercel() else "sqlite")
    try:
        _ensure_persistence_available()
        if not init_db():
            raise StorageUnavailableError(
                "Database storage is temporarily unavailable. Keep a downloaded backup and retry saving."
            )
        with _database(write=True, rollback=True) as conn:
            probe_id = uuid4().hex
            now = _now_iso()
            payload = Json({}) if _HAS_POSTGRES else "{}"
            _execute(conn,
                     "INSERT INTO logs (id, name, created_at, payload_json, project_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                     (probe_id, "__storage_health__", now, payload, DEFAULT_PROJECT_ID, now))
            _execute(conn, "SELECT id FROM logs WHERE id = ?", (probe_id,)).fetchone()
    except StorageUnavailableError as exc:
        return {"available": False, "durable": False, "backend": backend, "message": str(exc)}
    return {
        "available": True, "durable": True, "backend": backend,
        "message": "Database storage is available." if _HAS_POSTGRES else "Local database storage is available.",
    }


def create_log(name: str, payload: Dict[str, Any], project_id: Optional[str] = None) -> LogSummary:
    cleaned = _validate_name(name)
    log_id = uuid4().hex
    created_at = _now_iso()
    stored_payload = Json(payload) if _HAS_POSTGRES and Json is not None else json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _database(write=True) as conn:
        project = _require_project(conn, project_id)
        _execute(conn,
                 "INSERT INTO logs (id, name, created_at, payload_json, project_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                 (log_id, cleaned, created_at, stored_payload, project, created_at))
    return LogSummary(log_id, cleaned, created_at, project, created_at)


def list_logs(limit: int = 50, project_id: Optional[str] = None, offset: int = 0) -> List[LogSummary]:
    bounded = max(1, min(int(limit), 1000))
    start = max(0, int(offset))
    with _database() as conn:
        condition = ""
        parameters = ()
        if project_id is not None:
            project = _require_project(conn, project_id)
            condition = " WHERE project_id = ?"
            parameters = (project,)
        rows = _execute(conn,
                        "SELECT id, name, created_at, project_id, updated_at FROM logs" + condition +
                        " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", parameters + (bounded, start)).fetchall()
    return [_summary(row) for row in rows]


def get_log(log_id: str) -> Optional[LogEntry]:
    with _database() as conn:
        row = _execute(conn, "SELECT id, name, created_at, payload_json, project_id, updated_at FROM logs WHERE id = ?", (log_id,)).fetchone()
    if row is None:
        return None
    payload = row["payload_json"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    if not isinstance(payload, dict):
        payload = {}
    summary = _summary(row)
    return LogEntry(summary.id, summary.name, summary.created_at, summary.project_id, summary.updated_at, payload)


def update_log(log_id: str, name: Optional[str] = None, project_id: Optional[str] = None) -> Optional[LogSummary]:
    with _database(write=True) as conn:
        lock = " FOR UPDATE" if _HAS_POSTGRES else ""
        row = _execute(conn, "SELECT id, name, created_at, project_id, updated_at FROM logs WHERE id = ?" + lock, (log_id,)).fetchone()
        if row is None:
            return None
        cleaned = _validate_name(name) if name is not None else row["name"]
        project = _require_project(conn, project_id if project_id is not None else row["project_id"])
        updated_at = _now_iso()
        _execute(conn, "UPDATE logs SET name = ?, project_id = ?, updated_at = ? WHERE id = ?",
                 (cleaned, project, updated_at, log_id))
        return LogSummary(row["id"], cleaned, row["created_at"], project, updated_at)


def copy_log(log_id: str, project_id: str) -> Optional[LogSummary]:
    with _database(write=True) as conn:
        lock = " FOR SHARE" if _HAS_POSTGRES else ""
        row = _execute(conn, "SELECT id, name, created_at, project_id, updated_at FROM logs WHERE id = ?" + lock, (log_id,)).fetchone()
        if row is None:
            return None
        project = _require_project(conn, project_id)
        new_id = uuid4().hex
        updated_at = _now_iso()
        # Copy in the database, preserving every payload field and the original experiment date.
        _execute(conn,
                 "INSERT INTO logs (id, name, created_at, payload_json, project_id, updated_at) "
                 "SELECT ?, name, created_at, payload_json, ?, ? FROM logs WHERE id = ?",
                 (new_id, project, updated_at, log_id))
        return LogSummary(new_id, row["name"], row["created_at"], project, updated_at)


def delete_log(log_id: str) -> bool:
    with _database(write=True) as conn:
        cursor = _execute(conn, "DELETE FROM logs WHERE id = ?", (log_id,))
        return cursor.rowcount > 0
