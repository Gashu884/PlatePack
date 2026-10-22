"""Data-preservation and hierarchy regression checks against an isolated database."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app import app
from backend.api import logs_db


class FolderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / "hierarchy.sqlite"
        self.addCleanup(patch.stopall)
        patch.object(logs_db, "DB_PATH", self.db_path).start()
        patch.object(logs_db, "_HAS_POSTGRES", False).start()
        patch.dict(os.environ, {}, clear=True).start()
        self.assertTrue(logs_db.init_db())

    def make_project(self, name="実験 A"):
        person = logs_db.create_folder("研究者 B", "person")
        return logs_db.create_folder(name, "project", person.id)

    def test_legacy_migration_preserves_every_record_and_raw_payload(self):
        legacy_path = Path(self.temp.name) / "legacy.sqlite"
        raw_payload = '{ "version": 2, "future": {"a": [1, 2]}, "memo": "増殖 μ" }'
        with sqlite3.connect(legacy_path) as conn:
            conn.execute("CREATE TABLE logs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL)")
            conn.execute("INSERT INTO logs VALUES (?, ?, ?, ?)", ("original-id", "元の実験", "2024-01-02T03:04:05Z", raw_payload))
        with patch.object(logs_db, "DB_PATH", legacy_path):
            self.assertTrue(logs_db.init_db())
            self.assertTrue(logs_db.init_db())
            with sqlite3.connect(legacy_path) as conn:
                row = conn.execute("SELECT id, name, created_at, payload_json, project_id, updated_at FROM logs").fetchone()
            self.assertEqual(row, ("original-id", "元の実験", "2024-01-02T03:04:05Z", raw_payload,
                                   logs_db.DEFAULT_PROJECT_ID, "2024-01-02T03:04:05Z"))
            self.assertEqual(len(logs_db.list_folders()), 2)
            self.assertEqual(logs_db.get_log("original-id").payload["memo"], "増殖 μ")

    def test_failed_migration_rolls_back_schema_and_keeps_legacy_payload(self):
        legacy_path = Path(self.temp.name) / "failed-migration.sqlite"
        with sqlite3.connect(legacy_path) as conn:
            conn.execute("CREATE TABLE logs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL)")
            conn.execute("INSERT INTO logs VALUES ('legacy', 'Original', '2020-01-01T00:00:00Z', '{\"keep\":true}')")
            conn.execute("CREATE TRIGGER reject_migration BEFORE UPDATE ON logs BEGIN SELECT RAISE(ABORT, 'blocked'); END;")
        with patch.object(logs_db, "DB_PATH", legacy_path):
            self.assertFalse(logs_db.init_db())
        with sqlite3.connect(legacy_path) as conn:
            self.assertEqual([row[1] for row in conn.execute("PRAGMA table_info(logs)")], ["id", "name", "created_at", "payload_json"])
            self.assertEqual(conn.execute("SELECT payload_json FROM logs").fetchone()[0], '{"keep":true}')
            self.assertIsNone(conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='folders'").fetchone())

    def test_default_folder_names_and_idempotent_reinitialization(self):
        folders = {folder.id: folder for folder in logs_db.list_folders()}
        self.assertEqual(folders[logs_db.DEFAULT_PERSON_ID].name, "メンバー 1")
        self.assertEqual(folders[logs_db.DEFAULT_PROJECT_ID].name, "プロジェクト 1")
        self.assertEqual(folders[logs_db.DEFAULT_PROJECT_ID].parent_id, logs_db.DEFAULT_PERSON_ID)
        project = self.make_project()
        original = logs_db.create_log("Original", {"keep": [1, 2]})
        moved = logs_db.update_log(original.id, project_id=project.id)
        logs_db.update_folder(logs_db.DEFAULT_PERSON_ID, name="既存の研究者")
        self.assertTrue(logs_db.init_db())
        self.assertEqual(logs_db.get_log(original.id).project_id, project.id)
        self.assertEqual(logs_db.get_log(original.id).created_at, original.created_at)
        self.assertEqual(logs_db.get_log(original.id).updated_at, moved.updated_at)
        self.assertEqual(next(folder.name for folder in logs_db.list_folders() if folder.id == logs_db.DEFAULT_PERSON_ID), "既存の研究者")

    def test_move_and_rename_keep_payload_id_date_and_update_timestamp(self):
        project = self.make_project()
        payload = {"plates": [{"wells": ["A1"], "growthWeeks": {"A1": 5}}], "future": {"nested": [None, True, "μ"]}}
        original = logs_db.create_log("元のログ", payload)
        moved = logs_db.update_log(original.id, name="移動したログ", project_id=project.id)
        loaded = logs_db.get_log(original.id)
        self.assertEqual((loaded.id, loaded.created_at, loaded.payload), (original.id, original.created_at, payload))
        self.assertEqual((loaded.name, loaded.project_id), ("移動したログ", project.id))
        self.assertGreater(moved.updated_at, original.updated_at)
        self.assertEqual(loaded.updated_at, moved.updated_at)

    def test_copy_preserves_exact_payload_and_date_but_has_independent_id(self):
        project = self.make_project()
        payload = {"packedPlates": [{"data": [1, 2, 3]}], "plates": [{"wells": ["H12"], "growthWeeks": {"H12": 4}}]}
        original = logs_db.create_log("Experiment", payload)
        copied = logs_db.copy_log(original.id, project.id)
        self.assertNotEqual(copied.id, original.id)
        self.assertEqual((copied.name, copied.created_at), (original.name, original.created_at))
        self.assertEqual(logs_db.get_log(copied.id).payload, payload)
        self.assertGreater(copied.updated_at, original.updated_at)
        logs_db.update_log(copied.id, name="Renamed copy")
        self.assertEqual(logs_db.get_log(original.id).name, "Experiment")
        logs_db.delete_log(copied.id)
        self.assertEqual(logs_db.get_log(original.id).payload, payload)

    def test_failed_move_and_copy_are_atomic(self):
        project = self.make_project()
        original = logs_db.create_log("Original", {"keep": True})
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("CREATE TRIGGER reject_move BEFORE UPDATE ON logs BEGIN SELECT RAISE(ABORT, 'blocked'); END;")
            conn.execute("CREATE TRIGGER reject_copy BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT, 'blocked'); END;")
        for action in (
            lambda: logs_db.update_log(original.id, name="Lost?", project_id=project.id),
            lambda: logs_db.copy_log(original.id, project.id),
        ):
            with self.assertRaises(logs_db.StorageUnavailableError):
                action()
        loaded = logs_db.get_log(original.id)
        self.assertEqual((loaded.name, loaded.project_id, loaded.updated_at, loaded.payload),
                         (original.name, original.project_id, original.updated_at, {"keep": True}))
        self.assertEqual(len(logs_db.list_logs(limit=1000)), 1)

    def test_project_move_between_people_preserves_plate_membership(self):
        project = self.make_project()
        original = logs_db.create_log("Experiment", {"keep": True}, project.id)
        other_person = logs_db.create_folder("研究者 C", "person")
        updated = logs_db.update_folder(project.id, parent_id=other_person.id, name="実験 B")
        self.assertEqual(updated.parent_id, other_person.id)
        self.assertEqual(logs_db.get_log(original.id).project_id, project.id)
        self.assertTrue(logs_db.init_db())
        self.assertEqual(next(folder.parent_id for folder in logs_db.list_folders() if folder.id == project.id), other_person.id)

    def test_folder_counts_include_descendant_logs(self):
        project = self.make_project()
        second = logs_db.create_folder("実験 B", "project", project.parent_id)
        logs_db.create_log("A", {}, project.id)
        logs_db.create_log("B", {}, project.id)
        logs_db.create_log("C", {}, second.id)
        folders = {folder.id: folder for folder in logs_db.list_folders()}
        self.assertEqual(folders[project.id].log_count, 2)
        self.assertEqual(folders[project.parent_id].log_count, 3)
        self.assertEqual(folders[project.parent_id].project_count, 2)

    def test_api_folder_lifecycle_and_client_id_retry(self):
        with TestClient(app) as client:
            body = {"id": "client-person-uuid", "name": "  Alice  ", "kind": "person"}
            first = client.post("/api/folders", json=body)
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json()["name"], "Alice")
            retry = client.post("/api/folders", json=body)
            self.assertEqual(retry.json(), first.json())
            collision = client.post("/api/folders", json={**body, "name": "Someone else"})
            self.assertEqual(collision.status_code, 409)
            project = client.post("/api/folders", json={"name": "Project", "kind": "project", "parent_id": first.json()["id"]})
            self.assertEqual(project.status_code, 200)
            renamed = client.patch(f"/api/folders/{project.json()['id']}", json={"name": "Renamed"})
            self.assertEqual(renamed.status_code, 200)
            self.assertEqual(renamed.json()["created_at"], project.json()["created_at"])
            self.assertGreater(renamed.json()["updated_at"], project.json()["updated_at"])
            self.assertEqual(len(client.get("/api/folders").json()), 4)

    def test_api_invalid_hierarchy_is_rejected_without_changes(self):
        with TestClient(app) as client:
            for body in (
                {"name": "Bad", "kind": "person", "parent_id": logs_db.DEFAULT_PERSON_ID},
                {"name": "Bad", "kind": "project"},
                {"name": "Bad", "kind": "project", "parent_id": logs_db.DEFAULT_PROJECT_ID},
                {"name": "Bad", "kind": "unknown"},
                {"name": "   ", "kind": "person"},
                {"id": "../unsafe", "name": "Bad", "kind": "person"},
            ):
                with self.subTest(body=body):
                    self.assertEqual(client.post("/api/folders", json=body).status_code, 422)
            self.assertEqual(client.post("/api/folders", json={"name": "Bad", "kind": "project", "parent_id": "missing"}).status_code, 404)
            self.assertEqual(client.patch(f"/api/folders/{logs_db.DEFAULT_PROJECT_ID}", json={"parent_id": None}).status_code, 422)
            self.assertEqual(client.patch(f"/api/folders/{logs_db.DEFAULT_PERSON_ID}", json={"parent_id": logs_db.DEFAULT_PROJECT_ID}).status_code, 422)
            self.assertEqual(client.patch("/api/folders/missing", json={"name": "Name"}).status_code, 404)
            self.assertEqual(len(client.get("/api/folders").json()), 2)

    def test_api_log_move_copy_and_project_validation(self):
        project = self.make_project()
        payload = {"version": 2, "plates": [{"wells": ["A2"], "growthWeeks": {"A2": 3}}]}
        with TestClient(app) as client:
            created = client.post("/api/logs", json={"name": "Experiment", "payload": payload}).json()
            self.assertEqual(created["project_id"], logs_db.DEFAULT_PROJECT_ID)
            self.assertEqual(client.patch(f"/api/logs/{created['id']}", json={"project_id": logs_db.DEFAULT_PERSON_ID}).status_code, 422)
            self.assertEqual(client.patch(f"/api/logs/{created['id']}", json={"project_id": "missing"}).status_code, 404)
            moved = client.patch(f"/api/logs/{created['id']}", json={"project_id": project.id, "name": "Moved"})
            self.assertEqual(moved.status_code, 200)
            self.assertEqual(moved.json()["created_at"], created["created_at"])
            copied = client.post(f"/api/logs/{created['id']}/copy", json={"project_id": logs_db.DEFAULT_PROJECT_ID})
            self.assertEqual(copied.status_code, 200)
            self.assertNotEqual(copied.json()["id"], created["id"])
            self.assertEqual(client.get(f"/api/logs/{copied.json()['id']}").json()["payload"], payload)
            self.assertEqual(client.post("/api/logs/missing/copy", json={"project_id": project.id}).status_code, 404)
            self.assertEqual(client.patch("/api/logs/missing", json={"name": "Name"}).status_code, 404)
            self.assertEqual(client.patch(f"/api/logs/{created['id']}", json={}).status_code, 422)
            self.assertEqual(client.post("/api/logs", json={"name": "Wrong", "payload": payload, "project_id": logs_db.DEFAULT_PERSON_ID}).status_code, 422)

    def test_project_filter_and_pagination_expose_more_than_200_records(self):
        project = self.make_project()
        with sqlite3.connect(self.db_path) as conn:
            conn.executemany(
                "INSERT INTO logs (id, name, created_at, payload_json, project_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                [(f"fixture-{i:04}", f"Record {i}", f"2025-01-{1 + i // 24:02}T{i % 24:02}:00:00Z", "{}", project.id, "2025-01-01T00:00:00Z") for i in range(240)],
            )
        logs_db.create_log("Other project", {})
        with TestClient(app) as client:
            all_records = client.get("/api/logs", params={"project_id": project.id, "limit": 1000}).json()
            self.assertEqual(len(all_records), 240)
            page1 = client.get("/api/logs", params={"project_id": project.id, "limit": 200, "offset": 0}).json()
            page2 = client.get("/api/logs", params={"project_id": project.id, "limit": 200, "offset": 200}).json()
            self.assertEqual([record["id"] for record in page1 + page2], [record["id"] for record in all_records])
            self.assertEqual(client.get("/api/logs", params={"offset": -1}).status_code, 422)
            self.assertEqual(client.get("/api/logs", params={"limit": 1001}).status_code, 422)

    def test_new_routes_return_safe_503_on_database_failure(self):
        with patch.object(logs_db, "DB_PATH", Path(self.temp.name)), TestClient(app) as client:
            self.assertEqual(client.get("/api/folders").status_code, 503)
            self.assertEqual(client.post("/api/folders", json={"name": "Person", "kind": "person"}).status_code, 503)
            self.assertEqual(client.patch("/api/folders/missing", json={"name": "Name"}).status_code, 503)
            self.assertEqual(client.patch("/api/logs/missing", json={"name": "Name"}).status_code, 503)
            self.assertEqual(client.post("/api/logs/missing/copy", json={"project_id": logs_db.DEFAULT_PROJECT_ID}).status_code, 503)


class PostgresTransactionTests(unittest.TestCase):
    def fake_connection(self, fail_migration=False):
        class Connection:
            def __init__(self):
                self.statements = []
                self.outcomes = []

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            @contextmanager
            def transaction(self, force_rollback=False):
                try:
                    yield
                except Exception:
                    self.outcomes.append("rollback")
                    raise
                else:
                    self.outcomes.append("rollback" if force_rollback else "commit")

            def execute(self, sql, parameters=()):
                self.statements.append((sql, parameters))
                if fail_migration and sql.startswith("UPDATE logs SET project_id"):
                    raise RuntimeError("provider connection failure with private details")
                return SimpleNamespace(rowcount=1)
        return Connection()

    def postgres_patches(self, connection):
        self.addCleanup(patch.stopall)
        patch.object(logs_db, "_HAS_POSTGRES", True).start()
        patch.object(logs_db, "POSTGRES_DSN", "postgres://test-only").start()
        patch.object(logs_db, "Json", lambda payload: payload).start()
        patch.object(logs_db, "psycopg", SimpleNamespace(connect=lambda *args, **kwargs: connection)).start()

    def test_postgres_migration_is_one_transaction_and_failure_rolls_back(self):
        connection = self.fake_connection(fail_migration=True)
        self.postgres_patches(connection)
        with patch.object(logs_db, "_connect") as sqlite_fallback:
            self.assertFalse(logs_db.init_db())
            sqlite_fallback.assert_not_called()
        self.assertEqual(connection.outcomes, ["rollback"])
        self.assertTrue(connection.statements[0][0].startswith("SELECT pg_advisory_xact_lock"))
        self.assertTrue(any("ADD COLUMN IF NOT EXISTS project_id" in sql for sql, _ in connection.statements))
        self.assertTrue(any("WHERE project_id IS NULL OR project_id = ''" in sql for sql, _ in connection.statements))

    def test_postgres_validation_keeps_http_domain_error_and_rolls_back(self):
        connection = self.fake_connection()
        self.postgres_patches(connection)
        with self.assertRaisesRegex(logs_db.StorageValidationError, "Invalid hierarchy"):
            with logs_db._database(write=True):
                raise logs_db.StorageValidationError("Invalid hierarchy")
        self.assertEqual(connection.outcomes, ["rollback"])


if __name__ == "__main__":
    unittest.main()
