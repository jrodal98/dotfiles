# zmodload zsh/zprof # uncomment top and bottom of file to profile startup
# Prepend directories to PATH (highest priority first). Uses a loop so
# ordering is explicit and adding a new entry is one line. shared_bin must
# stay before pi-node so the pi wrapper takes precedence.
typeset -a _path_prepends=(
  "$HOME/shared_bin"
  "$HOME/.local/share/pi-node/node-v22.23.2-linux-x64/bin"
  "$HOME/go/bin"
  "$HOME/.gem/ruby/2.7.0/bin"
  "$HOME/.local/bin"
  "$HOME/bin"
  "$HOME/.cargo/bin"
  "/opt/nvim-linux-x86_64/bin"
)
for (( i=${#_path_prepends} ; i>=1 ; i-- )); do
  [[ -d "${_path_prepends[i]}" ]] || continue
  case ":$PATH:" in
    *":${_path_prepends[i]}:"*) ;;
    *) PATH="${_path_prepends[i]}:$PATH" ;;
  esac
done
unset _path_prepends i
export PATH

if ! command -v dotgk &> /dev/null; then
  curl -fsSL https://raw.githubusercontent.com/jrodal98/dotgk/refs/heads/master/install.sh | sh
  rehash # apparently, this refreshes the path so that dotgk can be found
  dotgk cache enable shell
  dotgk sync
fi

source ~/.config/dotgk/caches/dotgk.sh

[ -f ~/meta.zshrc ] && source ~/meta.zshrc

if dotgk_check "server"; then
  # 1. Don't call tmux if already in a tmux session
  # 2. Don't call tmux if the term program is vscode
  # 3. Don't call tmux if in a non-interactive ssh session (e.g. ek connect, ssh host "ls")
  [[ $TMUX || ! -t 0 || $TERM_PROGRAM = vscode || -z $SSH_TTY ]] || tmux $TMUX_OPTIONS new-session -As auto
fi


alias fuck='eval "sudo $(fc -ln -1)"'
alias gsl='git smartlog'

setopt rm_star_silent

# allow comments in interactive shell
setopt INTERACTIVE_COMMENTS

export EDITOR='nvim'
export VISUAL='nvim'
export GIT_EDITOR='nvim'
export TERMINAL='wezterm'
export PYTHONWARNINGS="ignore"

# Make it so that ctrl-w on...
#   a/b/c/d removes d instead of the entire path
#   a=b=c=d removes d instead of the entire path
export WORDCHARS=${WORDCHARS//[\/=]}

# load zinit
ZINIT_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/zinit/zinit.git"
[ ! -d $ZINIT_HOME ] && mkdir -p "$(dirname $ZINIT_HOME)"
[ ! -d $ZINIT_HOME/.git ] && git clone --depth 1 https://github.com/zdharma-continuum/zinit.git "$ZINIT_HOME"
source "${ZINIT_HOME}/zinit.zsh"

# Initialize completions with ez-compinit (deferred + cached)
zstyle ':plugin:ez-compinit' 'use-cache' 'yes'
zstyle ':plugin:ez-compinit' 'compstyle' 'prez'
zinit light mattmc3/ez-compinit

# OMZ libraries needed for plugins (load immediately, required for prompt)
zinit snippet OMZL::history.zsh
zinit snippet OMZL::git.zsh
zinit snippet OMZL::key-bindings.zsh

# OMZ plugins with turbo mode (deferred loading for faster startup)
zinit ice wait lucid
zinit snippet OMZP::extract

zinit ice depth=1
zinit light jeffreytse/zsh-vi-mode
# override the '^y' set by zsh-vi-mode
function zvm_after_init() {
  zvm_bindkey viins '^y' autosuggest-accept
  zvm_bindkey viins '^G' __halp_replace
}

zinit ice wait lucid
zinit snippet OMZP::colored-man-pages

# External plugins with turbo mode
zinit ice wait lucid depth"1" atload"_zsh_autosuggest_start"
zinit light zsh-users/zsh-autosuggestions

# Completions - blockf prevents default completion install, zinit handles it
zinit ice wait lucid depth"1" blockf atpull"zinit creinstall -q ."
zinit light zsh-users/zsh-completions

# Syntax highlighting - must load last, use wait"1" to ensure it loads after other plugins
zinit ice wait"1" lucid depth"1"
zinit light zsh-users/zsh-syntax-highlighting

if command -v starship &> /dev/null; then
  eval "$(starship init zsh)"
fi

if command -v direnv &> /dev/null; then
  eval "$(direnv hook zsh)"
fi

if command -v zoxide &> /dev/null; then
  eval "$(zoxide init zsh --cmd j)"
fi

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

if command -v tv &> /dev/null; then
  eval "$(tv init zsh)" 2>/dev/null
fi

source ~/.jrodal_zsh_utils/wezterm/init.sh

alias ls='ls --color=auto'


# halp — Ctrl+G to replace command line text with an LLM-suggested shell command
__halp_replace() {
    local query="$BUFFER"
    if [[ -z "$query" ]]; then
        return
    fi
    # Show thinking indicator
    zle -R "# thinking..."
    # Query ttymate for a shell command
    local result
    result=$(ttymate shell --no-stream "$query" 2>/dev/null)
    if [[ $? -ne 0 || -z "$result" ]]; then
        # On error, restore original text and redisplay
        zle redisplay
        return
    fi
    # Replace command line with the result
    BUFFER="$result"
    CURSOR=${#BUFFER}
    zle redisplay
}
zle -N __halp_replace

shelp ()
{
  (
  ttymate --no-stream 2>/dev/null shell "$1" &
  ttymate --no-stream 2>/dev/null shell "$1" &
  ttymate --no-stream 2>/dev/null shell "$1" &
) | tv | awk 'BEGIN { print "-----------------------" > "/dev/stderr" } { print $0; print $0 > "/dev/stderr" } END { print "-----------------------" > "/dev/stderr" }' | sh
}

touch "${HOME}/.env" && source "${HOME}/.env"
# zprof # uncomment top and bottom of file to profile startup

# History configuration - prevent massive history files
HISTSIZE=50000           # Commands in memory
SAVEHIST=10000           # Commands saved to disk
setopt HIST_IGNORE_DUPS  # Don't save duplicate commands
setopt HIST_IGNORE_SPACE # Don't save commands starting with space
setopt HIST_EXPIRE_DUPS_FIRST # Expire duplicates first when trimming

