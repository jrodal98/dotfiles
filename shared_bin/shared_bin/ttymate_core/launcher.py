"""Shell launcher and optional user-configuration discovery."""

from __future__ import annotations

import importlib.util
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from types import ModuleType
from typing import Any

from .main import main

_CONFIG_MODULE = "_ttymate_config"
_ALLOWED_OPTIONS = {
    "default_backend",
    "default_model",
    "extra_backends",
    "sync_models_command",
}


def default_config_dir() -> Path:
    config_home = os.environ.get("XDG_CONFIG_HOME", "").strip()
    root = Path(config_home).expanduser() if config_home else Path.home() / ".config"
    return root / "ttymate"


def load_config(config_dir: Path | None = None) -> dict[str, Any]:
    directory = config_dir or default_config_dir()
    init_path = directory / "__init__.py"
    if not init_path.is_file():
        return {}

    module = _load_package(init_path, directory)
    configure = getattr(module, "configure", None)
    if configure is None:
        return {}
    if not callable(configure):
        raise TypeError(f"{init_path}: configure must be callable")
    options = configure()
    if not isinstance(options, Mapping):
        raise TypeError(f"{init_path}: configure() must return a mapping")

    unknown = set(options) - _ALLOWED_OPTIONS
    if unknown:
        names = ", ".join(sorted(str(name) for name in unknown))
        raise ValueError(f"{init_path}: unknown configure() options: {names}")
    return dict(options)


def _load_package(init_path: Path, directory: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        _CONFIG_MODULE,
        init_path,
        submodule_search_locations=[str(directory)],
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load ttymate configuration from {init_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_CONFIG_MODULE] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(_CONFIG_MODULE, None)
        raise
    return module


def run(argv: list[str] | None = None) -> int:
    try:
        options = load_config()
    except Exception as error:
        print(f"ttymate: failed to load configuration: {error}", file=sys.stderr)
        return 1
    return main(argv, **options)
