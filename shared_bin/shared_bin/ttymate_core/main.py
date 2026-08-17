#!/usr/bin/env python3
"""Portable ttymate CLI with injectable service backends."""

from __future__ import annotations

import sys

import argparse
import os
import signal
from collections.abc import Callable, Mapping
from pathlib import Path

from .backends import Backend, builtin_backends
from .client import Client
from .config import DEFAULT_BACKEND, DEFAULT_MODEL
from .engines import AskEngine, Engine, ShellEngine
from .errors import ProviderError, TransportError, TtymateError, UsageError


def _read_prompt(args: argparse.Namespace) -> str:
    if args.cmd == "shell":
        description = " ".join(getattr(args, "description", []) or []).strip()
        if not description:
            raise UsageError(
                'shell requires a description (e.g. ttymate shell "list large files")'
            )
        return description

    file_value: str | None = getattr(args, "file", None)
    prompt_value: str | None = getattr(args, "prompt", None)
    if file_value is not None:
        path = Path(file_value)
        if not path.exists():
            raise UsageError(f"--file {file_value!r} does not exist")
        try:
            return path.read_text(encoding="utf-8", errors="strict").strip()
        except (OSError, UnicodeDecodeError) as error:
            raise UsageError(
                f"Failed to read --file {file_value!r}: {error}"
            ) from error
    if prompt_value is not None:
        return prompt_value.strip()
    if sys.stdin.isatty():
        raise UsageError(
            "ask requires a prompt, --file, or piped stdin (e.g. echo hi | ttymate ask)"
        )
    try:
        data = sys.stdin.read()
    except (OSError, UnicodeDecodeError) as error:
        raise UsageError(f"Failed to read stdin: {error}") from error
    if data.strip():
        return data.strip()
    raise UsageError(
        "ask requires a prompt, --file, or piped stdin (e.g. echo hi | ttymate ask)"
    )


def _add_common_overrides(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--backend", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    parser.add_argument("--model", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    parser.add_argument(
        "--stream",
        action=argparse.BooleanOptionalAction,
        default=argparse.SUPPRESS,
        help=argparse.SUPPRESS,
    )


def build_parser(
    *,
    backend_names: tuple[str, ...],
    default_backend: str,
    default_model: str,
    include_sync_models: bool = False,
) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ttymate",
        description="Send prompts or generate shell commands through an LLM backend",
    )
    parser.add_argument(
        "--backend",
        choices=backend_names,
        default=default_backend,
        help=f"LLM backend (default: {default_backend})",
    )
    parser.add_argument(
        "--model", default=default_model, help=f"Model id (default: {default_model})"
    )
    parser.add_argument(
        "--stream",
        action=argparse.BooleanOptionalAction,
        default=argparse.SUPPRESS,
        help="Stream output incrementally (default: ask on, shell off)",
    )
    subparsers = parser.add_subparsers(dest="cmd", required=True)

    ask = subparsers.add_parser(
        "ask", help="Send a prompt to the LLM (reads prompt arg, --file, or stdin)"
    )
    _add_common_overrides(ask)
    ask_group = ask.add_mutually_exclusive_group()
    ask_group.add_argument("prompt", nargs="?", default=None, help="Prompt text")
    ask_group.add_argument("--file", default=None, help="File containing the prompt")

    shell = subparsers.add_parser(
        "shell", help="Generate a shell command from a natural-language description"
    )
    _add_common_overrides(shell)
    shell.add_argument("description", nargs="*", help="Desired command description")

    if include_sync_models:
        sync = subparsers.add_parser(
            "sync-models", help="Sync the internal model registry"
        )
        sync.add_argument(
            "--check",
            action="store_true",
            help="Check for drift without writing changes",
        )
    return parser


def _stdout_write(text: str) -> None:
    try:
        sys.stdout.write(text)
        sys.stdout.flush()
    except BrokenPipeError:
        os._exit(0)


def _run_stream(client: Client, engine: Engine, prompt: str) -> int:
    if not isinstance(engine, ShellEngine):
        collected = ""
        for delta in client.stream(prompt):
            collected += delta
            _stdout_write(delta)
        if not collected.endswith("\n"):
            _stdout_write("\n")
        return 0

    collected = ""
    emitted = ""
    for delta in client.stream(prompt):
        collected += delta
        stripped = collected.lstrip()
        if (
            stripped.startswith("```")
            and stripped.count("```") == 1
            and len(stripped.splitlines()) <= 1
        ):
            continue
        processed = engine.post_process(collected)
        if len(processed) > len(emitted):
            _stdout_write(processed[len(emitted) :])
            emitted = processed
        elif len(processed) < len(emitted):
            emitted = processed
    if emitted and not emitted.endswith("\n"):
        _stdout_write("\n")
    elif not emitted and collected:
        output = engine.post_process(collected)
        if output:
            _stdout_write(output if output.endswith("\n") else output + "\n")
    return 0


def main(
    argv: list[str] | None = None,
    *,
    extra_backends: Mapping[str, Backend] | None = None,
    default_backend: str = DEFAULT_BACKEND,
    default_model: str = DEFAULT_MODEL,
    sync_models_command: Callable[[bool], int] | None = None,
) -> int:
    try:
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    except (AttributeError, ValueError, OSError):
        pass

    backends = builtin_backends()
    backends.update(extra_backends or {})
    effective_backend = os.environ.get("TTYMATE_BACKEND", "").strip() or default_backend
    effective_model = os.environ.get("TTYMATE_MODEL", "").strip() or default_model
    parser = build_parser(
        backend_names=tuple(sorted(backends)),
        default_backend=effective_backend,
        default_model=effective_model,
        include_sync_models=sync_models_command is not None,
    )
    args = parser.parse_args(argv)

    if args.cmd == "sync-models" and sync_models_command is not None:
        return sync_models_command(bool(getattr(args, "check", False)))

    model = str(getattr(args, "model", effective_model) or effective_model)
    backend_name = str(getattr(args, "backend", effective_backend) or effective_backend)
    stream = bool(getattr(args, "stream", args.cmd == "ask"))

    try:
        raw_prompt = _read_prompt(args)
        if not raw_prompt:
            raise UsageError("Prompt is empty after trimming — provide non-empty input")
        backend = backends.get(backend_name)
        if backend is None:
            raise ProviderError(f"Unknown backend {backend_name!r}")
        resolved = backend.resolve(model)
    except UsageError as error:
        print(f"ttymate: {error}", file=sys.stderr)
        parser.print_usage(sys.stderr)
        return 2
    except ProviderError as error:
        print(f"ttymate: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("ttymate: interrupted", file=sys.stderr)
        return 130

    engine: Engine = AskEngine() if args.cmd == "ask" else ShellEngine()
    prompt = engine.build_prompt(raw_prompt)
    client = Client(resolved)
    try:
        if stream:
            return _run_stream(client, engine, prompt)
        text = client.send(prompt)
    except TransportError as error:
        print(f"ttymate: request failed: {error}", file=sys.stderr)
        if error.last_body:
            print(f"ttymate: response body: {error.last_body}", file=sys.stderr)
        return 1
    except TtymateError as error:
        print(f"ttymate: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("ttymate: interrupted", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"ttymate: unexpected error: {error}", file=sys.stderr)
        return 1

    output = engine.post_process(text)
    try:
        sys.stdout.write(output)
        if not output.endswith("\n"):
            sys.stdout.write("\n")
    except BrokenPipeError:
        os._exit(0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
