#!/usr/bin/env zsh

SCRIPT_DIR="${0:A:h}"
# this file comes from https://raw.githubusercontent.com/wezterm/wezterm/refs/heads/main/assets/shell-integration/wezterm.sh
source "$SCRIPT_DIR/wezterm.sh"
source "$SCRIPT_DIR/wezterm_overrides"

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

# --- Desktop Notification for Long-Running Commands ---
typeset -g __cmd_start_time
typeset -g __cmd_command

__notify_preexec() {
  __cmd_start_time=$EPOCHSECONDS
  __cmd_command="${1:-$3}"
}

__notify_precmd() {
  local exit_code=$?

  [[ -z "$__cmd_start_time" ]] && return

  local duration=$(( EPOCHSECONDS - __cmd_start_time ))

  if (( duration >= 30 )); then
    # Skip interactive commands that are expected to run long
    local cmd_first="${__cmd_command%% *}"
    case "$cmd_first" in
      nvim|vim|vi|claude|ssh|tmux|slo|yazi|sudoedit|dmt|sls|sld|happy)
        __cmd_start_time=
        __cmd_command=
        return
        ;;
    esac

    local cmd_display="$__cmd_command"
    if (( ${#cmd_display} > 40 )); then
      cmd_display="${cmd_display:0:37}..."
    fi

    # Build location info: hostname + tmux window/pane if available
    local location="${HOST:-${HOSTNAME:-unknown}}"
    if [[ -n "${TMUX-}" ]]; then
      local tmux_info=$(tmux display-message -p '#W:#P' 2>/dev/null)
      [[ -n "$tmux_info" ]] && location="$location ($tmux_info)"
    fi

    local message="[$location] $cmd_display (${duration}s)"

    if (( exit_code == 0 )); then
      weznotify --title "Command succeeded" --message "$message" --timeout 10000
    else
      weznotify --title "Command failed" --message "$message" --timeout 10000
    fi
  fi

  __cmd_start_time=
  __cmd_command=
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __notify_preexec
add-zsh-hook precmd __notify_precmd

function zle-focus-in() {
  __wezterm_user_vars_precmd
}
zle -N zle-focus-in
