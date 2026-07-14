from __future__ import annotations

import glob
import os
import pathlib
import subprocess
import sys
import tempfile
import venv


ROOT = pathlib.Path(__file__).resolve().parents[1]
DIST = ROOT / "dist" / "python"
wheels = glob.glob(str(DIST / "lite_harness_sdk-*.whl"))
sdists = glob.glob(str(DIST / "lite_harness_sdk-*.tar.gz"))
if len(wheels) != 1 or len(sdists) != 1:
    raise SystemExit(f"expected one wheel and one sdist, found {wheels!r} and {sdists!r}")

with tempfile.TemporaryDirectory(prefix="lite-python-dist-") as directory:
    environment = pathlib.Path(directory) / "venv"
    venv.EnvBuilder(with_pip=True, clear=True).create(environment)
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    subprocess.run(
        [str(python), "-m", "pip", "install", "--no-deps", "--no-index", wheels[0]],
        check=True,
        cwd=directory,
    )
    result = subprocess.run(
        [str(python), "-I", "-c", "from lite_harness import LiteHarnessClient; print(LiteHarnessClient.__name__)"],
        check=True,
        capture_output=True,
        text=True,
        cwd=directory,
    )
    if result.stdout.strip() != "LiteHarnessClient":
        raise SystemExit(f"unexpected installed distribution output: {result.stdout!r}")

print(f"Installed Python wheel smoke passed; sdist present: {pathlib.Path(sdists[0]).name}")
