"""One owned processing group, separate from externally launched graphs."""

from __future__ import annotations

import copy
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from .execution_document import GraphDocument, runtime_name


class ExecutionConflict(ValueError):
    pass


class ExecutionSupervisor:
    def __init__(self):
        self._lock = threading.RLock()
        self._directory = tempfile.TemporaryDirectory(prefix="ezmsg-run-")
        self._root = Path(self._directory.name)
        self._logs = deque(maxlen=60)
        self._process = None
        self._status_path = None
        self._document = None
        self._revision = 0
        self._state = "stopped"
        self._error = None
        self._root_name = "dashboard_" + uuid.uuid4().hex

    def _spawn(self, mode, request, status, logs=None):
        process = subprocess.Popen(
            [sys.executable, "-m", "ezmsg.dashboard.backend.execution_worker", mode, str(request), str(status)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            start_new_session=os.name != "nt",
        )
        logs = self._logs if logs is None else logs

        def drain():
            with process.stdout:
                while chunk := process.stdout.readline(4096):
                    logs.append(chunk.rstrip())

        threading.Thread(target=drain, daemon=True).start()
        return process

    @staticmethod
    def _read(path):
        if path is None or not path.exists():
            return {}
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            return {}

    @staticmethod
    def _terminate(process, status_path=None):
        # The worker publishes failure before its finally block joins children.
        # Let that cleanup finish before signalling: GraphRunner may have restored
        # SIGTERM's default handler, so an immediate signal interrupts cleanup.
        if process.poll() is None and ExecutionSupervisor._read(status_path).get("state") == "failed":
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        # Windows terminate() kills the worker without running its cleanup.
        # Request a cooperative stop first so GraphRunner can join its children
        # and release their unit ownership before a replacement starts.
        if process.poll() is None and status_path is not None:
            status_path.with_suffix(".stop").touch()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        # Only signal the process group created by _spawn, never GraphService.
        if process.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False)
            else:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        # A zero exit plus our completion marker means GraphRunner.stop joined
        # its children. Avoid signalling a now-empty/recycled group on macOS.
        if process.returncode == 0 and ExecutionSupervisor._read(status_path).get("state") in {
            "valid",
            "stopped",
            "failed",
        }:
            return
        if os.name != "nt":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False)
        process.wait(timeout=5)

    def status(self):
        with self._lock:
            if self._process is not None:
                payload = self._read(self._status_path)
                if payload.get("state") == "failed" or self._process.poll() is not None:
                    self._state = "failed"
                    self._error = payload.get("error", "Managed runner exited unexpectedly")
                    self._terminate(self._process, self._status_path)
                    self._process = None
                    self._revision += 1
            nodes = (self._document or {}).get("nodes", [])
            return {
                "logs": list(self._logs),
                "state": self._state,
                "error": self._error,
                "revision": self._revision,
                "root_name": self._root_name,
                "document": copy.deepcopy(self._document),
                "runtime_addresses": {
                    n["id"]: f"{self._root_name}/{runtime_name(n['id'], n.get('name'))}" for n in nodes
                },
            }

    def _check_revision(self, revision):
        self.status()
        if revision != self._revision:
            raise ExecutionConflict("Execution changed in another request. Refresh status and try again.")

    def _stop(self):
        if self._process is not None:
            self._terminate(self._process, self._status_path)
            self._process = None
        self._state, self._error = "stopped", None

    def stop(self, revision):
        with self._lock:
            self._check_revision(revision)
            self._stop()
            self._revision += 1
            return self.status()

    def deploy(self, document, graph_address, revision, *, apply=False):
        with self._lock:
            self._check_revision(revision)
            if apply != (self._state == "running"):
                raise ExecutionConflict("Use Apply for a running group and Run for a stopped group")
            document = copy.deepcopy(document)
            GraphDocument.model_validate(document)
            token = uuid.uuid4().hex
            request = self._root / f"{token}.json"
            status = self._root / f"{token}.status.json"
            request.write_text(
                json.dumps(
                    {"document": document, "root_name": self._root_name, "graph_address": graph_address},
                    allow_nan=False,
                )
            )
            validator = self._spawn("validate", request, status, deque(maxlen=60))
            try:
                validator.wait(timeout=30)
                result = self._read(status)
                if validator.returncode != 0 or result.get("state") != "valid":
                    raise ValueError(result.get("error", "Document validation failed"))
            except subprocess.TimeoutExpired as exc:
                raise ValueError("Document validation timed out") from exc
            finally:
                self._terminate(validator, status)
            # Validation failure above leaves the existing group running.
            status.unlink(missing_ok=True)
            self._stop()
            self._revision += 1
            self._status_path = status
            self._logs = deque(maxlen=60)
            try:
                self._process = self._spawn("run", request, status)
            except OSError as exc:
                self._state, self._error = "failed", str(exc)
                return self.status()
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                result = self._read(status)
                if result.get("state") == "running" and self._process.poll() is None:
                    self._document = document
                    self._state = "running"
                    return self.status()
                if result.get("state") == "failed" or self._process.poll() is not None:
                    break
                time.sleep(0.05)
            self._error = result.get("error", "Managed group startup timed out or exited")
            self._state = "failed"
            self._terminate(self._process, self._status_path)
            self._process = None
            return self.status()

    def close(self):
        with self._lock:
            self._stop()
            self._directory.cleanup()
