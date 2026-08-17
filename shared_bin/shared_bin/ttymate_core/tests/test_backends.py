from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

from ttymate_core.backends import LiteLLMBackend
from ttymate_core.errors import ProviderError
from ttymate_core.transport import StandardTransport


class LiteLLMBackendTest(unittest.TestCase):
    def test_resolve_uses_proxy_url_key_and_model(self) -> None:
        environment = {
            "LITELLM_BASE_URL": "https://llm.example.test/v1/",
            "LITELLM_API_KEY": "secret",
        }
        with patch.dict(os.environ, environment, clear=True):
            resolved = LiteLLMBackend().resolve("anthropic/claude-sonnet")

        self.assertEqual(("https://llm.example.test/v1",), resolved.endpoints)
        self.assertEqual("anthropic/claude-sonnet", resolved.wire_model)
        self.assertEqual("Bearer secret", resolved.headers["authorization"])
        self.assertIsInstance(resolved.transport, StandardTransport)
        body = json.loads(
            resolved.protocol.build_body(
                "hello", resolved.wire_model, resolved.max_tokens
            )
        )
        self.assertEqual("anthropic/claude-sonnet", body["model"])
        self.assertNotIn("max_completion_tokens", body)

    def test_resolve_rejects_non_http_url(self) -> None:
        with patch.dict(
            os.environ, {"LITELLM_BASE_URL": "file:///tmp/socket"}, clear=True
        ):
            with self.assertRaises(ProviderError):
                LiteLLMBackend().resolve("model")

    def test_resolve_rejects_key_over_remote_plaintext(self) -> None:
        environment = {
            "LITELLM_BASE_URL": "http://llm.example.test/v1",
            "LITELLM_API_KEY": "secret",
        }
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaises(ProviderError):
                LiteLLMBackend().resolve("model")
