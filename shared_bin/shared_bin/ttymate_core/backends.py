"""Backend selection and the portable LiteLLM backend."""

from __future__ import annotations

import ipaddress
import os
import urllib.parse
from abc import ABC, abstractmethod
from dataclasses import dataclass

from .errors import ProviderError
from .protocols import OpenAIProtocol, Protocol
from .transport import StandardTransport, Transport


@dataclass(frozen=True)
class ResolvedBackend:
    """Everything the client needs to send one model's requests."""

    name: str
    protocol: Protocol
    endpoints: tuple[str, ...]
    wire_model: str
    max_tokens: int | None
    headers: dict[str, str]
    transport: Transport


class Backend(ABC):
    """Resolve a user-facing model into a concrete service configuration."""

    name: str

    @abstractmethod
    def resolve(self, model: str) -> ResolvedBackend: ...


class LiteLLMBackend(Backend):
    """OpenAI-compatible LiteLLM proxy configured through environment variables."""

    name = "litellm"

    def resolve(self, model: str) -> ResolvedBackend:
        base_url = os.environ.get(
            "LITELLM_BASE_URL", "http://127.0.0.1:4000/v1"
        ).strip()
        try:
            parsed = urllib.parse.urlparse(base_url)
            hostname = parsed.hostname
        except ValueError as error:
            raise ProviderError(f"Invalid LITELLM_BASE_URL: {error}") from error
        if parsed.scheme not in ("http", "https") or not hostname:
            raise ProviderError(
                "LITELLM_BASE_URL must be an absolute http:// or https:// URL"
            )

        headers: dict[str, str] = {}
        api_key = os.environ.get("LITELLM_API_KEY", "").strip()
        if api_key and parsed.scheme == "http" and not _is_loopback(hostname):
            raise ProviderError(
                "LITELLM_API_KEY requires HTTPS unless LITELLM_BASE_URL is loopback"
            )
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"

        return ResolvedBackend(
            name=self.name,
            protocol=OpenAIProtocol(),
            endpoints=(base_url.rstrip("/"),),
            wire_model=model,
            max_tokens=None,
            headers=headers,
            transport=StandardTransport(),
        )


def _is_loopback(hostname: str) -> bool:
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def builtin_backends() -> dict[str, Backend]:
    return {"litellm": LiteLLMBackend()}
