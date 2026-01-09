#!/usr/bin/env zsh

SCRIPT_DIR="${0:A:h}"
# this file comes from https://raw.githubusercontent.com/wezterm/wezterm/refs/heads/main/assets/shell-integration/wezterm.sh
source "$SCRIPT_DIR/wezterm.sh"

# Example: weznotify --title "Example notification" --message "Click on this notification to see documentation details" --url https://wezterm.org/config/lua/window/toast_notification.html --timeout 5000
# See https://github.com/wezterm/wezterm/issues/5476 if this is not working on mac
function weznotify() {
  local title="" message="" url="" timeout=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --message) message="$2"; shift 2 ;;
      --url) url="$2"; shift 2 ;;
      --timeout) timeout="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  local title_json=${title:+\"$title\"}; title_json=${title_json:-null}
  local message_json=${message:+\"$message\"}; message_json=${message_json:-null}
  local url_json=${url:+\"$url\"}; url_json=${url_json:-null}
  local timeout_json=${timeout:-null}
  local json="{\"title\":$title_json,\"message\":$message_json,\"url\":$url_json,\"timeout\":$timeout_json}"
  __wezterm_set_user_var 'event:notify' "$json"
}

# Copy to clipboard: `wezcopy "text"` or `echo "text" | wezcopy`
function wezcopy() {
  local text="${1:-$(cat)}"
  __wezterm_set_user_var 'event:copy' "$text"
}
