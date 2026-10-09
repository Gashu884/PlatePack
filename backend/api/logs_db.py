"""Log storage for PlatePack UI snapshots (SQLite locally, Postgres on Vercel)."""

from __future__ import annotations

import json
import os
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


@dataclass(frozen=True)
class LogEntry(LogSummary):
    payload: Dict[str, Any]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@contextmanager
def _connect():
    import sqlite3

    conn = None
    try:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=10)
        conn.row_factory = sqlite3.Row
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
    except StorageUnavailableError:
        raise
    except Exception as exc:
        # Never expose connection strings, credentials, or provider errors to clients.
        raise StorageUnavailableError(
            "Database storage is temporarily unavailable. Keep a downloaded backup and retry saving."
        ) from exc


def init_db() -> bool:
    try:
        _ensure_persistence_available()
    except StorageUnavailableError:
        return False
    if _HAS_POSTGRES:
        try:
            with _pg_connect() as conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS logs (
                      id TEXT PRIMARY KEY,
                      name TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      payload_json JSONB NOT NULL
                    )
                    """
                )
                conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at)")
            return True
        except Exception:
            # Do not silently fall back if Postgres is configured; callers want persistence.
            return False
    try:
        with _connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS logs (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  payload_json TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at)")
        return True
    except Exception:
        # Allow app to run even when persistence is unavailable (e.g. read-only FS).
        return False


def storage_health() -> Dict[str, Any]:
    """Report the usable storage backend without claiming serverless /tmp is durable."""
    backend = "postgres" if _HAS_POSTGRES else ("unconfigured" if _is_vercel() else "sqlite")
    try:
        _ensure_persistence_available()
        if not init_db():
            raise StorageUnavailableError(
                "Database storage is temporarily unavailable. Keep a downloaded backup and retry saving."
            )
        # Check INSERT and read permissions, then roll back the probe so no log is retained.
        probe_id = uuid4().hex
        if _HAS_POSTGRES:
            with _pg_connect() as conn:
                with conn.transaction(force_rollback=True):
                    conn.execute(
                        "INSERT INTO logs (id, name, created_at, payload_json) VALUES (%s, %s, %s, %s)",
                        (probe_id, "__storage_health__", _now_iso(), Json({})),
                    )
                    conn.execute("SELECT id FROM logs WHERE id = %s", (probe_id,)).fetchone()
        else:
            with _connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute(
                    "INSERT INTO logs (id, name, created_at, payload_json) VALUES (?, ?, ?, ?)",
                    (probe_id, "__storage_health__", _now_iso(), "{}"),
                )
                conn.execute("SELECT id FROM logs WHERE id = ?", (probe_id,)).fetchone()
                conn.rollback()
    except StorageUnavailableError as exc:
        return {"available": False, "durable": False, "backend": backend, "message": str(exc)}
    return {
        "available": True,
        "durable": True,
        "backend": backend,
        "message": "Database storage is available." if _HAS_POSTGRES else "Local database storage is available.",
    }


def create_log(name: str, payload: Dict[str, Any]) -> LogSummary:
    _ensure_persistence_available()
    log_id = uuid4().hex
    created_at = _now_iso()
    if _HAS_POSTGRES:
        if Json is None:
            raise RuntimeError("Postgres JSON adapter unavailable")
        with _pg_connect() as conn:
            conn.execute(
                "INSERT INTO logs (id, name, created_at, payload_json) VALUES (%s, %s, %s, %s)",
                (log_id, name, created_at, Json(payload)),
            )
        return LogSummary(id=log_id, name=name, created_at=created_at)
    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _connect() as conn:
        conn.execute(
            "INSERT INTO logs (id, name, created_at, payload_json) VALUES (?, ?, ?, ?)",
            (log_id, name, created_at, payload_json),
        )
    return LogSummary(id=log_id, name=name, created_at=created_at)


def list_logs(limit: int = 50) -> List[LogSummary]:
    _ensure_persistence_available()
    bounded = max(1, min(int(limit), 200))
    if _HAS_POSTGRES:
        with _pg_connect() as conn:
            rows = conn.execute(
                "SELECT id, name, created_at FROM logs ORDER BY created_at DESC LIMIT %s",
                (bounded,),
            ).fetchall()
        return [LogSummary(id=row["id"], name=row["name"], created_at=row["created_at"]) for row in rows]
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at FROM logs ORDER BY created_at DESC LIMIT ?",
            (bounded,),
        ).fetchall()
    return [LogSummary(id=row["id"], name=row["name"], created_at=row["created_at"]) for row in rows]


def get_log(log_id: str) -> Optional[LogEntry]:
    _ensure_persistence_available()
    if _HAS_POSTGRES:
        with _pg_connect() as conn:
            row = conn.execute(
                "SELECT id, name, created_at, payload_json FROM logs WHERE id = %s",
                (log_id,),
            ).fetchone()
        if row is None:
            return None
        payload_raw = row["payload_json"]
        payload = payload_raw
        if isinstance(payload_raw, str):
            payload = json.loads(payload_raw)
        if not isinstance(payload, dict):
            payload = {}
        return LogEntry(
            id=row["id"],
            name=row["name"],
            created_at=row["created_at"],
            payload=payload,
        )
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, name, created_at, payload_json FROM logs WHERE id = ?",
            (log_id,),
        ).fetchone()
    if row is None:
        return None
    payload = json.loads(row["payload_json"])
    if not isinstance(payload, dict):
        payload = {}
    return LogEntry(
        id=row["id"],
        name=row["name"],
        created_at=row["created_at"],
        payload=payload,
    )


def delete_log(log_id: str) -> bool:
    _ensure_persistence_available()
    if _HAS_POSTGRES:
        with _pg_connect() as conn:
            cur = conn.execute("DELETE FROM logs WHERE id = %s", (log_id,))
            return cur.rowcount > 0
    with _connect() as conn:
        cur = conn.execute("DELETE FROM logs WHERE id = ?", (log_id,))
    return cur.rowcount > 0
