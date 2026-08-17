from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from ttymate_core.launcher import load_config


class ConfigDiscoveryTest(unittest.TestCase):
    def test_missing_package_uses_portable_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            options = load_config(Path(temp_dir) / "missing")

        self.assertEqual({}, options)

    def test_package_without_configure_uses_portable_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_dir = Path(temp_dir)
            (config_dir / "__init__.py").write_text("VALUE = 1\n", encoding="utf-8")

            options = load_config(config_dir)

        self.assertEqual({}, options)

    def test_configure_options_are_loaded(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_dir = Path(temp_dir)
            (config_dir / "__init__.py").write_text(
                "def configure():\n"
                "    return {'default_backend': 'custom', 'default_model': 'model'}\n",
                encoding="utf-8",
            )

            options = load_config(config_dir)

        self.assertEqual("custom", options["default_backend"])
        self.assertEqual("model", options["default_model"])

    def test_unknown_option_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_dir = Path(temp_dir)
            (config_dir / "__init__.py").write_text(
                "def configure():\n    return {'unknown': True}\n",
                encoding="utf-8",
            )

            with self.assertRaises(ValueError):
                load_config(config_dir)
