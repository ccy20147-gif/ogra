#!/usr/bin/env python3
"""Offline regression tests for ensure_deps.py.

The installer and package metadata are mocked, so these tests never download
dependencies. They specifically cover a clean venv repaired on first run.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("ensure_deps.py")
SPEC = importlib.util.spec_from_file_location("ensure_deps_under_test", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
ensure_deps = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ensure_deps)


class EnsureDepsTests(unittest.TestCase):
    def run_main(self) -> tuple[int, str]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rc = ensure_deps.main()
        return rc, output.getvalue()

    def test_clean_venv_repaired_on_first_run_succeeds(self) -> None:
        installed: dict[str, str] = {}

        def version(dist: str) -> str:
            if dist not in installed:
                raise ensure_deps.importlib.metadata.PackageNotFoundError(dist)
            return installed[dist]

        def install(_command: list[str]) -> None:
            installed.update(ensure_deps.PINNED)

        with patch.object(ensure_deps.importlib.metadata, "version", side_effect=version), patch.object(
            ensure_deps.subprocess, "check_call", side_effect=install
        ):
            rc, output = self.run_main()

        self.assertEqual(rc, 0)
        self.assertIn("ENSURE_DEPS_PASS", output)
        self.assertNotIn("ENSURE_DEPS_FAIL", output)

    def test_repair_that_leaves_a_dependency_missing_fails(self) -> None:
        def version(dist: str) -> str:
            raise ensure_deps.importlib.metadata.PackageNotFoundError(dist)

        with patch.object(ensure_deps.importlib.metadata, "version", side_effect=version), patch.object(
            ensure_deps.subprocess, "check_call", return_value=None
        ):
            rc, output = self.run_main()

        self.assertNotEqual(rc, 0)
        self.assertIn("ENSURE_DEPS_FAIL", output)


if __name__ == "__main__":
    unittest.main()
