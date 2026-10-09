"""Regression checks for week metadata and acknowledged persistent saves."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.app import app
from backend.api import logs_db
from backend.api.generate_html import ReportRequest, build_html_report


def report_payload(week=None):
    assignment = {"well": "A1", "source_plate": "1", "source_well": "A1"}
    if week is not None:
        assignment["growth_week"] = week
    return {
        "title": "Growth Report",
        "sources": [{"plate_id": "1", "wells": ["A1"]}],
        "destinations": [{"plate_id": "DEST-001", "assignments": [assignment]}],
    }


class GrowthWeekTests(unittest.TestCase):
    def test_old_report_payload_remains_valid_without_week(self):
        payload = ReportRequest(**report_payload())
        self.assertIsNone(payload.destinations[0].assignments[0].growth_week)
        self.assertEqual(payload.sources[0].growth_weeks, {})
        html = build_html_report(payload)
        self.assertNotIn('<span class="growth-week"', html)
        self.assertIn("1 · A1", html)

    def test_all_five_weeks_appear_in_well_and_derived_plan(self):
        for week in range(1, 6):
            with self.subTest(week=week):
                html = build_html_report(ReportRequest(**report_payload(week)))
                self.assertIn(f'aria-label="Growth observed in week {week}">{week}</span>', html)
                self.assertIn(f"<td>A1</td><td>{week}</td>", html)

    def test_source_metadata_is_normalized_and_used_for_report(self):
        raw = report_payload()
        raw["sources"][0]["growth_weeks"] = {"a1": 3}
        payload = ReportRequest(**raw)
        self.assertEqual(payload.sources[0].growth_weeks, {"A1": 3})
        html = build_html_report(payload)
        self.assertIn('aria-label="Growth observed in week 3">3</span>', html)
        self.assertIn("<td>A1</td><td>3</td>", html)

    def test_explicit_plan_week_is_preserved(self):
        raw = report_payload(5)
        raw["plan"] = [{
            "source_plate": "1", "source_well": "A1",
            "destination_plate": "DEST-001", "destination_well": "A1", "growth_week": 5,
        }]
        html = build_html_report(ReportRequest(**raw))
        self.assertIn("<th scope=\"col\">Growth Week</th>", html)
        self.assertIn("<td>A1</td><td>5</td>", html)

    def test_invalid_week_values_are_rejected_in_all_locations(self):
        for value in (0, 6, -1, True, "3", 1.5):
            for location in ("assignment", "source", "plan"):
                with self.subTest(value=value, location=location):
                    raw = report_payload()
                    if location == "assignment":
                        raw["destinations"][0]["assignments"][0]["growth_week"] = value
                    elif location == "source":
                        raw["sources"][0]["growth_weeks"] = {"A1": value}
                    else:
                        raw["plan"] = [{
                            "source_plate": "1", "source_well": "A1",
                            "destination_plate": "DEST-001", "destination_well": "A1", "growth_week": value,
                        }]
                    with self.assertRaises(ValidationError):
                        ReportRequest(**raw)

    def test_growth_cannot_be_attached_to_an_unselected_source_well(self):
        raw = report_payload()
        raw["sources"][0]["growth_weeks"] = {"A2": 2}
        with self.assertRaises(ValidationError):
            ReportRequest(**raw)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / "logs.sqlite"
        self.addCleanup(patch.stopall)
        patch.object(logs_db, "DB_PATH", self.db_path).start()
        patch.object(logs_db, "_HAS_POSTGRES", False).start()
        patch.dict(os.environ, {}, clear=True).start()
        self.assertTrue(logs_db.init_db())

    def test_save_reopen_and_reinitialize_keep_old_and_week_metadata(self):
        old = logs_db.create_log("Legacy", {"plates": [{"wells": ["A1"]}]})
        snapshot = {"version": 2, "plates": [{"wells": ["B2"], "growthWeeks": {"B2": 4}}]}
        saved = logs_db.create_log("Week 4", snapshot)
        self.assertTrue(logs_db.init_db())
        self.assertEqual(logs_db.get_log(saved.id).payload, snapshot)
        self.assertEqual(logs_db.get_log(old.id).payload, {"plates": [{"wells": ["A1"]}]})
        self.assertEqual({log.id for log in logs_db.list_logs()}, {old.id, saved.id})

    def test_local_health_reports_available_persistent_sqlite(self):
        health = logs_db.storage_health()
        self.assertEqual((health["available"], health["durable"], health["backend"]), (True, True, "sqlite"))
        self.assertEqual(logs_db.list_logs(), [])

    def test_vercel_never_writes_ephemeral_sqlite(self):
        with patch.dict(os.environ, {"VERCEL": "1"}), patch.object(logs_db, "_connect") as connect:
            self.assertFalse(logs_db.init_db())
            health = logs_db.storage_health()
            self.assertFalse(health["available"])
            self.assertFalse(health["durable"])
            with self.assertRaises(logs_db.StorageUnavailableError):
                logs_db.create_log("Blocked", {})
            connect.assert_not_called()

    def test_configured_postgres_with_missing_driver_never_falls_back_to_sqlite(self):
        with patch.object(logs_db, "_HAS_POSTGRES", True), patch.object(logs_db, "psycopg", None), \
                patch.object(logs_db, "Json", None), patch.object(logs_db, "_connect") as connect:
            self.assertFalse(logs_db.init_db())
            health = logs_db.storage_health()
            self.assertEqual(health["backend"], "postgres")
            self.assertFalse(health["available"])
            with self.assertRaises(logs_db.StorageUnavailableError):
                logs_db.create_log("Blocked", {})
            connect.assert_not_called()

    def test_unwritable_path_returns_storage_error_without_false_acknowledgement(self):
        with patch.object(logs_db, "DB_PATH", Path(self.temp.name)):
            self.assertFalse(logs_db.storage_health()["available"])
            with self.assertRaises(logs_db.StorageUnavailableError):
                logs_db.create_log("Cannot save", {})

    def test_failed_insert_keeps_existing_log_and_is_not_acknowledged(self):
        saved = logs_db.create_log("Existing", {"preserve": True})
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("CREATE TRIGGER reject_new BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT, 'blocked'); END;")
        with self.assertRaises(logs_db.StorageUnavailableError):
            logs_db.create_log("Blocked", {"preserve": False})
        self.assertEqual(logs_db.get_log(saved.id).payload, {"preserve": True})
        self.assertEqual(len(logs_db.list_logs()), 1)
        self.assertFalse(logs_db.storage_health()["available"])
        self.assertEqual(len(logs_db.list_logs()), 1)

    def test_api_save_and_reload_preserve_snapshot(self):
        snapshot = {"version": 2, "plates": [{"wells": ["C5"], "growthWeeks": {"C5": 5}}]}
        with TestClient(app) as client:
            created = client.post("/api/logs", json={"name": "  Week 5  ", "payload": snapshot})
            self.assertEqual(created.status_code, 200)
            self.assertEqual(created.json()["name"], "Week 5")
            reloaded = client.get(f"/api/logs/{created.json()['id']}")
            self.assertEqual(reloaded.json()["payload"], snapshot)
            self.assertTrue(client.get("/api/storage-health").json()["available"])

    def test_api_storage_failures_are_503(self):
        with patch.object(logs_db, "DB_PATH", Path(self.temp.name)), TestClient(app) as client:
            for path, method in (("/api/logs", "get"), ("/api/logs/missing", "get"), ("/api/logs/missing", "delete")):
                with self.subTest(path=path, method=method):
                    self.assertEqual(getattr(client, method)(path).status_code, 503)
            response = client.post("/api/logs", json={"name": "Failed", "payload": {}})
            self.assertEqual(response.status_code, 503)
            self.assertFalse(client.get("/api/storage-health").json()["durable"])

    def test_postgres_error_does_not_expose_connection_credentials(self):
        secret_dsn = "postgres://user:private-password@private-host/database"
        def fail_connect(*args, **kwargs):
            raise RuntimeError(f"Cannot connect to {secret_dsn}")
        with patch.object(logs_db, "_HAS_POSTGRES", True), \
                patch.object(logs_db, "POSTGRES_DSN", secret_dsn), \
                patch.object(logs_db, "psycopg", SimpleNamespace(connect=fail_connect)), \
                patch.object(logs_db, "Json", lambda payload: payload), TestClient(app) as client:
            response = client.post("/api/logs", json={"name": "Safe", "payload": {}})
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("private-password", response.text)
            self.assertNotIn("private-host", response.text)
            self.assertNotIn("private-password", client.get("/api/storage-health").text)

    def test_api_rejects_blank_name(self):
        with TestClient(app) as client:
            self.assertEqual(client.post("/api/logs", json={"name": "   ", "payload": {}}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
