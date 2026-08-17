"""Engines — ask (identity) and shell (templated + fence stripping)."""

from __future__ import annotations

from abc import ABC, abstractmethod

from .config import SHELL_TEMPLATE


class Engine(ABC):
    @abstractmethod
    def build_prompt(self, raw: str) -> str: ...

    def post_process(self, text: str) -> str:
        return text


class AskEngine(Engine):
    """Identity engine — prompt is the user's text verbatim."""

    def build_prompt(self, raw: str) -> str:
        return raw


class ShellEngine(Engine):
    """Wraps description in CRITICAL INSTRUCTIONS and strips markdown fences."""

    def build_prompt(self, raw: str) -> str:
        desc = raw.strip()
        if desc.startswith("-- "):
            desc = desc[3:].lstrip()
        elif desc == "--":
            desc = ""
        return SHELL_TEMPLATE.format(desc=desc)

    def post_process(self, text: str) -> str:
        t = text.strip()
        if t.startswith("```"):
            lines = t.splitlines()
            if len(lines) >= 2:
                # Strip opening fence (first line)
                start = 1
                # Strip closing fence: last line may be "```" or "<content>```"
                last = lines[-1]
                if last.strip() == "```" or last.strip().startswith("```"):
                    end = len(lines) - 1
                elif last.endswith("```"):
                    # Same-line closing like "ls -la```" -> strip suffix
                    lines[-1] = last[:-3].rstrip()
                    end = len(lines)
                else:
                    end = len(lines)
                return "\n".join(lines[start:end]).strip()
            if t.endswith("```") and len(t) > 6:
                inner = t[3:-3].strip()
                if "\n" not in inner:
                    return inner
            return t.strip("`").strip()
        return t
