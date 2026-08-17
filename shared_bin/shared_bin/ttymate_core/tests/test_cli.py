from __future__ import annotations

import io
import os
import unittest
from unittest.mock import patch

from ttymate_core.backends import Backend, ResolvedBackend
from ttymate_core.config import DEFAULT_MODEL
from ttymate_core.main import build_parser, main
from ttymate_core.protocols import OpenAIProtocol
from ttymate_core.transport import StandardTransport


class RecordingBackend(Backend):
    name = "recording"

    def __init__(self) -> None:
        self.models: list[str] = []

    def resolve(self, model: str) -> ResolvedBackend:
        self.models.append(model)
        return ResolvedBackend(
            name=self.name,
            protocol=OpenAIProtocol(),
            endpoints=("https://example.test/v1",),
            wire_model=model,
            max_tokens=None,
            headers={},
            transport=StandardTransport(),
        )


class InvalidTextInput:
    def isatty(self) -> bool:
        return False

    def read(self) -> str:
        raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")


class FakeClient:
    resolved: ResolvedBackend | None = None

    def __init__(self, resolved: ResolvedBackend) -> None:
        type(self).resolved = resolved

    def send(self, prompt: str) -> str:
        return f"answer:{prompt}"


class StreamModeClient:
    calls: list[str] = []

    def __init__(self, resolved: ResolvedBackend) -> None:
        pass

    def send(self, prompt: str) -> str:
        type(self).calls.append("send")
        return "echo safe"

    def stream(self, prompt: str):
        type(self).calls.append("stream")
        yield "echo safe"


class CliBackendInjectionTest(unittest.TestCase):
    def test_portable_default_model(self) -> None:
        parser = build_parser(
            backend_names=("litellm",),
            default_backend="litellm",
            default_model=DEFAULT_MODEL,
        )

        args = parser.parse_args(["ask", "hello"])

        self.assertEqual("gpt-5-nano", args.model)

    def test_stream_defaults_and_explicit_overrides(self) -> None:
        cases = (
            ("ask defaults to streaming", ["ask", "hello"], "stream"),
            ("shell defaults to buffered", ["shell", "hello"], "send"),
            (
                "global stream enables shell streaming",
                ["--stream", "shell", "hello"],
                "stream",
            ),
            (
                "local stream enables shell streaming",
                ["shell", "--stream", "hello"],
                "stream",
            ),
            (
                "global no-stream keeps shell buffered",
                ["--no-stream", "shell", "hello"],
                "send",
            ),
            (
                "local no-stream keeps shell buffered",
                ["shell", "--no-stream", "hello"],
                "send",
            ),
            ("global no-stream buffers ask", ["--no-stream", "ask", "hello"], "send"),
            ("local no-stream buffers ask", ["ask", "--no-stream", "hello"], "send"),
            ("global stream streams ask", ["--stream", "ask", "hello"], "stream"),
            ("local stream streams ask", ["ask", "--stream", "hello"], "stream"),
        )

        for label, argv, expected_call in cases:
            with self.subTest(label):
                backend = RecordingBackend()
                StreamModeClient.calls = []
                with (
                    patch.dict(os.environ, {}, clear=True),
                    patch("ttymate_core.main.Client", StreamModeClient),
                    patch("sys.stdout", io.StringIO()),
                ):
                    exit_code = main(
                        argv,
                        extra_backends={backend.name: backend},
                        default_backend=backend.name,
                    )

                self.assertEqual(0, exit_code)
                self.assertEqual([expected_call], StreamModeClient.calls)

    def test_injected_backend_and_defaults_are_used(self) -> None:
        backend = RecordingBackend()
        stdout = io.StringIO()
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("ttymate_core.main.Client", FakeClient),
            patch("sys.stdout", stdout),
        ):
            exit_code = main(
                ["--no-stream", "ask", "hello"],
                extra_backends={backend.name: backend},
                default_backend=backend.name,
                default_model="injected-model",
            )

        self.assertEqual(0, exit_code)
        self.assertEqual(["injected-model"], backend.models)
        self.assertEqual("answer:hello\n", stdout.getvalue())
        self.assertEqual("recording", FakeClient.resolved.name)

    def test_environment_overrides_injected_model(self) -> None:
        backend = RecordingBackend()
        environment = {
            "TTYMATE_BACKEND": backend.name,
            "TTYMATE_MODEL": "environment-model",
        }
        with (
            patch.dict(os.environ, environment, clear=True),
            patch("ttymate_core.main.Client", FakeClient),
            patch("sys.stdout", io.StringIO()),
        ):
            exit_code = main(
                ["--no-stream", "ask", "hello"],
                extra_backends={backend.name: backend},
            )

        self.assertEqual(0, exit_code)
        self.assertEqual(["environment-model"], backend.models)

    def test_invalid_stdin_encoding_is_usage_error(self) -> None:
        stderr = io.StringIO()
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("sys.stdin", InvalidTextInput()),
            patch("sys.stderr", stderr),
        ):
            exit_code = main(["ask"])

        self.assertEqual(2, exit_code)
        self.assertIn("Failed to read stdin", stderr.getvalue())
