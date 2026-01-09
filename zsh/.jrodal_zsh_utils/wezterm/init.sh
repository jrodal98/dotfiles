#!/usr/bin/env zsh

SCRIPT_DIR="${0:A:h}"
# this file comes from https://raw.githubusercontent.com/wezterm/wezterm/refs/heads/main/assets/shell-integration/wezterm.sh
source "$SCRIPT_DIR/wezterm.sh"

function weznotify() {
  __wezterm_set_user_var 'event:notify' "$1"
}

# Copy to clipboard: `wezcopy "text"` or `echo "text" | wezcopy`
function wezcopy() {
  local text="${1:-$(cat)}"
  __wezterm_set_user_var 'event:copy' "$text"
}
