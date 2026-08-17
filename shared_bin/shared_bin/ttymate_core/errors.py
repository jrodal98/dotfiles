from __future__ import annotations


class TtymateError(Exception):
    pass


class UsageError(TtymateError):
    """Bad CLI usage — exit 2."""


class ProviderError(TtymateError):
    """Invalid backend or model configuration."""


class TransportError(TtymateError):
    """All configured service endpoints failed."""

    def __init__(self, message: str, last_body: str | None = None) -> None:
        super().__init__(message)
        self.last_body = last_body
