"""Portable ttymate defaults."""

from __future__ import annotations

DEFAULT_BACKEND = "litellm"
DEFAULT_MODEL = "gpt-5-nano"
DEFAULT_TIMEOUT = 60
ANTHROPIC_VERSION = "2023-06-01"

SHELL_TEMPLATE = (
    "Generate a shell command that does the following: {desc}\n\n"
    "CRITICAL INSTRUCTIONS:\n"
    "- Output ONLY the runnable shell command itself\n"
    "- Do NOT include any explanations, descriptions, or commentary\n"
    "- Do NOT include markdown code blocks or formatting\n"
    "- Do NOT include any text before or after the command\n"
    "- The output must be a single line that can be directly executed\n"
    "- The output may be used in a pipe, so any extra text will cause failures\n"
    "- If multiple commands are needed, chain them with && or ; or |\n"
    "- Do NOT output anything except the executable command"
)
