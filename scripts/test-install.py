#!/usr/bin/env python3
"""Incremental installer regression tests (requires rsync and util-linux script)."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copy2(Path(__file__).resolve().parents[1] / "install", self.root / "install")
        self.src = self.root / "extensions/hub"
        self.src.mkdir(parents=True)
        (self.src / "index.ts").write_text("original\n")
        (self.src / "package.json").write_text('{"name":"fixture"}\n')
        (self.src / "bun.lock").write_text("lock v1\n")
        (self.src / "node_modules").mkdir()
        (self.src / "node_modules/source-only").write_text("do not copy")
        self.dest = self.root / "installed/hub"
        self.log = self.root / "installs"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        bun = bin_dir / "bun"
        bun.write_text('#!/bin/sh\necho install >> "$INSTALL_LOG"\nmkdir -p node_modules\necho local > node_modules/local\n[ ! -f "$FAIL_INSTALL" ]\n')
        bun.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}",
                        PI_EXTENSIONS_DIR=str(self.dest.parent),
                        PI_THEMES_DIR=str(self.root / "themes-dest"),
                        PI_AGENTS_DIR=str(self.root / "agents-dest"),
                        PI_PROMPTS_DIR=str(self.root / "prompts-dest"),
                        INSTALL_LOG=str(self.log), FAIL_INSTALL=str(self.root / "fail"))

    def run_install(self, success=True):
        result = subprocess.run(["script", "-qec", "./install", "/dev/null"],
                                cwd=self.root, env=self.env, input="y\n",
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode == 0, success, result.stdout)
        return result.stdout

    def installs(self):
        return len(self.log.read_text().splitlines()) if self.log.exists() else 0

    def test_terminal_formatting(self):
        self.env["TERM"] = "xterm-256color"
        self.env.pop("NO_COLOR", None)
        output = self.run_install()
        self.assertIn("\x1b[", output)
        self.assertIn("1/4 · Sync extensions", output)
        self.assertIn("[done]", output)
        self.env["NO_COLOR"] = ""
        output = self.run_install()
        self.assertNotIn("\x1b[", output)
        self.assertIn("[same] hub: unchanged", output)
        self.assertIn("Dependencies are up to date.", output)
        self.env.pop("NO_COLOR")
        self.env["TERM"] = "dumb"
        self.assertNotIn("\x1b[", self.run_install())

    def test_redirected_output_is_plain(self):
        self.env["TERM"] = "xterm-256color"
        self.env.pop("NO_COLOR", None)
        result = subprocess.run(["./install"], cwd=self.root, env=self.env,
                                input="y\n", text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("\x1b[", result.stdout + result.stderr)
        self.assertIn("confirmation required", result.stderr)

    def test_incremental_sync(self):
        self.run_install()
        self.assertEqual(self.installs(), 1)
        self.assertFalse((self.dest / "node_modules/source-only").exists())
        self.assertIn("hub: unchanged", self.run_install())
        self.assertEqual(self.installs(), 1)
        # Content changes of identical size and mtime must still be detected.
        before = (self.src / "index.ts").stat()
        (self.src / "index.ts").write_text("modified\n")
        os.utime(self.src / "index.ts", ns=(before.st_atime_ns, before.st_mtime_ns))
        self.run_install()
        self.assertEqual((self.dest / "index.ts").read_text(), "modified\n")
        self.assertEqual(self.installs(), 1)
        (self.dest / "stale.ts").write_text("stale")
        self.run_install()
        self.assertFalse((self.dest / "stale.ts").exists())
        self.assertTrue((self.dest / "node_modules/local").exists())
        (self.src / "bun.lock").write_text("lock v2\n")
        self.run_install()
        self.assertEqual(self.installs(), 2)
        (self.src / "package.json").write_text('{"name":"updated"}\n')
        self.run_install()
        self.assertEqual(self.installs(), 3)
        shutil.rmtree(self.dest / "node_modules")
        self.run_install()
        self.assertEqual(self.installs(), 4)

    def test_local_lock_and_timestamp_are_ignored(self):
        self.run_install()
        (self.dest / "package-lock.json").write_text("generated locally")
        os.utime(self.src / "index.ts", (1, 1))
        self.assertIn("hub: unchanged", self.run_install())
        self.assertEqual(self.installs(), 1)
        self.assertTrue((self.dest / "package-lock.json").exists())

    def test_failed_dependencies_are_retried(self):
        (self.root / "fail").touch()
        self.run_install(success=False)
        self.assertTrue((self.dest / ".pi-x-install-pending").exists())
        (self.root / "fail").unlink()
        self.run_install()
        self.assertEqual(self.installs(), 2)
        self.assertFalse((self.dest / ".pi-x-install-pending").exists())
        self.run_install()
        self.assertEqual(self.installs(), 2)

    def test_flat_herdr_file_is_not_rewritten(self):
        src = self.root / "extensions/herdr-agent-state"
        src.mkdir()
        (src / "index.ts").write_text("// FORK of the official Herdr Pi integration\n")
        self.run_install()
        flat = self.dest.parent / "herdr-agent-state.ts"
        before = flat.stat().st_mtime_ns
        self.assertIn("herdr-agent-state: unchanged", self.run_install())
        self.assertEqual(flat.stat().st_mtime_ns, before)


if __name__ == "__main__":
    unittest.main()
