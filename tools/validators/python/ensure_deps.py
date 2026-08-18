#!/usr/bin/env python3
"""Verify that the M0 Python validator venv runs the DECLARED dependency
versions, and repair mismatches in place.

The reviewer's point (P2-4 round 2): installing pins only when the venv does
not exist lets an existing venv drift (e.g. referencing 0.36.2 while the
declared pin is 0.35.1). This script compares installed versions against the
declared pins and force-reinstalls any mismatch.

Usage: <venv>/bin/python tools/validators/python/ensure_deps.py
Exit 0 when all declared versions are satisfied; non-zero otherwise.
"""
from __future__ import annotations

import importlib.metadata
import subprocess
import sys

# distribution name -> exact version (import name differs for two entries)
PINNED = {
    "jsonschema": "4.23.0",
    "referencing": "0.35.1",
    "openapi-spec-validator": "0.7.1",
    "PyYAML": "6.0.2",
}


def dependency_problems() -> list[str]:
    """Return mismatches for the currently installed environment only."""
    problems: list[str] = []
    for dist, wanted in PINNED.items():
        try:
            got = importlib.metadata.version(dist)
        except importlib.metadata.PackageNotFoundError:
            problems.append(f"{dist}: NOT INSTALLED (want {wanted})")
            continue
        if got != wanted:
            problems.append(f"{dist}: installed {got}, declared {wanted}")
    return problems


def main() -> int:
    initial_problems = dependency_problems()
    if initial_problems:
        to_fix = [f"{dist}=={wanted}" for dist, wanted in PINNED.items()]
        print("ensure_deps: repairing " + ", ".join(to_fix))
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check",
                 "--no-cache-dir", "--force-reinstall", *to_fix]
            )
        except subprocess.CalledProcessError as exc:
            print(f"ENSURE_DEPS_FAIL installer exited {exc.returncode}")
            return 1

    # The exit verdict intentionally reflects only the post-repair state. A
    # clean venv repaired successfully on its first invocation is a success.
    final_problems = dependency_problems()
    if final_problems:
        for p in final_problems:
            print(f"ENSURE_DEPS_FAIL {p}")
        return 1
    print("ENSURE_DEPS_PASS pinned versions: "
          + ", ".join(f"{d}=={v}" for d, v in PINNED.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
