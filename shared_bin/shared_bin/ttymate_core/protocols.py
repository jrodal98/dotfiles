"""Portable LLM API wire protocols."""

from __future__ import annotations

import json
import urllib.parse
from abc import ABC, abstractmethod

from .config import ANTHROPIC_VERSION
from .errors import TransportError


def _parse_json_or_raise(data: bytes, who: str) -> dict:
    try:
        value = json.loads(data.decode())
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise TransportError(f"Invalid JSON from {who}: {e}") from e
    if not isinstance(value, dict):
        raise TransportError(f"Unexpected {who} response shape: {data[:500]!r}")
    return value


class Protocol(ABC):
    """An LLM service's HTTP request and response wire format."""

    name: str

    @abstractmethod
    def build_url(self, base: str, model: str, stream: bool = False) -> str: ...

    @abstractmethod
    def build_headers(self) -> dict[str, str]: ...

    @abstractmethod
    def build_body(
        self,
        prompt: str,
        model: str,
        max_tokens: int | None,
        stream: bool = False,
    ) -> bytes: ...

    @abstractmethod
    def parse_response(self, data: bytes) -> str: ...

    def parse_stream_chunk(self, data: str, event: str | None = None) -> str | None:
        return None


class AnthropicProtocol(Protocol):
    name = "anthropic"

    def build_url(self, base: str, model: str, stream: bool = False) -> str:
        return f"{base.rstrip('/')}/v1/messages"

    def build_headers(self) -> dict[str, str]:
        return {
            "content-type": "application/json",
            "anthropic-version": ANTHROPIC_VERSION,
        }

    def build_body(
        self,
        prompt: str,
        model: str,
        max_tokens: int | None,
        stream: bool = False,
    ) -> bytes:
        body: dict[str, object] = {
            "model": model,
            "max_tokens": max_tokens or 4096,
            "messages": [{"role": "user", "content": prompt}],
        }
        if stream:
            body["stream"] = True
        return json.dumps(body).encode()

    def parse_response(self, data: bytes) -> str:
        obj = _parse_json_or_raise(data, "Anthropic")
        content = obj.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    text = block.get("text")
                    if isinstance(text, str) and text:
                        return text
                elif isinstance(block, str) and block:
                    return block
            raise TransportError(
                "Empty Anthropic response (no text block)", str(data[:500])
            )
        raise TransportError(f"Unexpected Anthropic response shape: {data[:500]!r}")

    def parse_stream_chunk(self, data: str, event: str | None = None) -> str | None:
        if data == "[DONE]":
            return None
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            return None
        if not isinstance(obj, dict):
            return None
        delta = obj.get("delta")
        if isinstance(delta, dict):
            text = delta.get("text")
            if isinstance(text, str) and text:
                return text
        return None


class OpenAIProtocol(Protocol):
    name = "openai"

    def build_url(self, base: str, model: str, stream: bool = False) -> str:
        return f"{base.rstrip('/')}/chat/completions"

    def build_headers(self) -> dict[str, str]:
        return {"content-type": "application/json"}

    def build_body(
        self,
        prompt: str,
        model: str,
        max_tokens: int | None,
        stream: bool = False,
    ) -> bytes:
        body: dict[str, object] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
        }
        if max_tokens is not None:
            body["max_completion_tokens"] = max_tokens
        if stream:
            body["stream"] = True
        return json.dumps(body).encode()

    def parse_response(self, data: bytes) -> str:
        obj = _parse_json_or_raise(data, "OpenAI-compatible service")
        choices = obj.get("choices")
        if not isinstance(choices, list) or not choices:
            raise TransportError(f"Unexpected OpenAI response shape: {data[:500]!r}")
        choice = choices[0]
        if not isinstance(choice, dict):
            raise TransportError(f"Unexpected OpenAI response shape: {data[:500]!r}")
        if choice.get("finish_reason") == "length":
            raise TransportError(
                "Empty OpenAI response (truncated: finish_reason=length)",
                str(data[:500]),
            )
        message = choice.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str) and content:
                return content
        text = choice.get("text")
        if isinstance(text, str) and text:
            return text
        raise TransportError("Empty OpenAI response (no content)", str(data[:500]))

    def parse_stream_chunk(self, data: str, event: str | None = None) -> str | None:
        if data == "[DONE]":
            return None
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            return None
        if not isinstance(obj, dict):
            return None
        choices = obj.get("choices")
        if not isinstance(choices, list) or not choices:
            return None
        choice = choices[0]
        if not isinstance(choice, dict):
            return None
        delta = choice.get("delta")
        if isinstance(delta, dict):
            content = delta.get("content")
            if isinstance(content, str) and content:
                return content
        message = choice.get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str) and content:
                return content
        text = choice.get("text")
        if isinstance(text, str) and text:
            return text
        return None


class GeminiProtocol(Protocol):
    name = "gemini"

    def build_url(self, base: str, model: str, stream: bool = False) -> str:
        base = base.rstrip("/")
        quoted = urllib.parse.quote(model, safe="")
        if stream:
            return f"{base}/models/{quoted}:streamGenerateContent?alt=sse"
        return f"{base}/models/{quoted}:generateContent"

    def build_headers(self) -> dict[str, str]:
        return {"content-type": "application/json"}

    def build_body(
        self,
        prompt: str,
        model: str,
        max_tokens: int | None,
        stream: bool = False,
    ) -> bytes:
        body: dict[str, object] = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}]
        }
        if max_tokens is not None:
            body["generationConfig"] = {"maxOutputTokens": max_tokens}
        return json.dumps(body).encode()

    def parse_response(self, data: bytes) -> str:
        obj = _parse_json_or_raise(data, "Gemini")
        candidates = obj.get("candidates")
        if isinstance(candidates, list) and candidates:
            first = candidates[0]
            if isinstance(first, dict):
                content = first.get("content")
                if isinstance(content, dict):
                    parts = content.get("parts")
                    if isinstance(parts, list):
                        for part in parts:
                            if isinstance(part, dict):
                                text = part.get("text")
                                if isinstance(text, str) and text:
                                    return text
            raise TransportError(
                "Empty Gemini response (no text part)", str(data[:500])
            )
        raise TransportError(f"Unexpected Gemini response shape: {data[:500]!r}")

    def parse_stream_chunk(self, data: str, event: str | None = None) -> str | None:
        if data == "[DONE]":
            return None
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            return None
        if not isinstance(obj, dict):
            return None
        candidates = obj.get("candidates")
        if isinstance(candidates, list) and candidates:
            first = candidates[0]
            if isinstance(first, dict):
                content = first.get("content")
                if isinstance(content, dict):
                    parts = content.get("parts")
                    if isinstance(parts, list):
                        for part in parts:
                            if isinstance(part, dict):
                                text = part.get("text")
                                if isinstance(text, str) and text:
                                    return text
        return None
