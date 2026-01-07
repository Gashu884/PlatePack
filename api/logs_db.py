"""SQLite-backed log storage for PlatePack UI snapshots."""

from __future__ import annotations

import json
import os
import sqlite3
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
if _HAS_POSTGRES:
    try:
        import psycopg  # type: ignore
        from psycopg.rows import dict_row  # type: ignore
    except Exception:  # pragma: no cover
        psycopg = None
        dict_row = None
        _HAS_POSTGRES = False


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


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _pg_connect():
    if not _HAS_POSTGRES or POSTGRES_DSN is None:
        raise RuntimeError("Postgres not configured")
    # autocommit=True so DDL/DML is persisted in serverless environments without explicit commits
    return psycopg.connect(POSTGRES_DSN, autocommit=True, row_factory=dict_row)


def init_db() -> bool:
    if _HAS_POSTGRES:
        try:
            with _pg_connect() as conn:
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
            # fall back to sqlite below
            pass
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
    except sqlite3.Error:
        # Allow app to run even when persistence is unavailable (e.g. read-only FS).
        return False


def create_log(name: str, payload: Dict[str, Any]) -> LogSummary:
    log_id = uuid4().hex
    created_at = _now_iso()
    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if _HAS_POSTGRES:
        with _pg_connect() as conn:
            conn.execute(
                "INSERT INTO logs (id, name, created_at, payload_json) VALUES (%s, %s, %s, %s)",
                (log_id, name, created_at, payload_json),
            )
        return LogSummary(id=log_id, name=name, created_at=created_at)
    with _connect() as conn:
        conn.execute(
            "INSERT INTO logs (id, name, created_at, payload_json) VALUES (?, ?, ?, ?)",
            (log_id, name, created_at, payload_json),
        )
    return LogSummary(id=log_id, name=name, created_at=created_at)


def list_logs(limit: int = 50) -> List[LogSummary]:
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
    if _HAS_POSTGRES:
        with _pg_connect() as conn:
            row = conn.execute(
                "SELECT id, name, created_at, payload_json FROM logs WHERE id = %s",
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
    if _HAS_POSTGRES:
        with _pg_connect() as conn:
            cur = conn.execute("DELETE FROM logs WHERE id = %s", (log_id,))
            return cur.rowcount > 0
    with _connect() as conn:
        cur = conn.execute("DELETE FROM logs WHERE id = ?", (log_id,))
    return cur.rowcount > 0
