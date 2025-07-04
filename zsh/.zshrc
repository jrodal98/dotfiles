export PATH="$HOME/go/bin:$HOME/.gem/ruby/2.7.0/bin:$HOME/.local/bin/:$HOME/bin:$HOME/.cargo/bin:/opt/nvim-linux64/bin:$PATH"

# zmodload zsh/zprof # uncomment top and bottom of file to profile startup
if ! command -v dotgk &> /dev/null; then
  curl -fsSL https://raw.githubusercontent.com/jrodal98/dotgk/refs/heads/master/install.sh | sh
  dotgk sync --force
fi

passes_gk() {
  case "$(dotgk get "$1")" in
    true) return 0 ;;
    *) return 1 ;;
  esac
}

[ -f ~/.metarc.zsh ] && source ~/.metarc.zsh

if passes_gk "server"; then
  [[ $TMUX || ! -t 0 || $TERM_PROGRAM = vscode ]] || tmux $TMUX_OPTIONS new-session -As auto
fi


alias fuck='eval "sudo $(fc -ln -1)"'

setopt rm_star_silent


export EDITOR='nvim'
export VISUAL='nvim'
export GIT_EDITOR='nvim'
export TERMINAL='wezterm'
export PYTHONWARNINGS="ignore"


# load zgen
# My mac was using the below line, not sure why. If I see something weird, I'll renable it I guess.
# ZSH_DISABLE_COMPFIX="true"
source "${HOME}/.zgen/zgen.zsh"

# if the init script doesn't exist
if ! zgen saved; then

  zgen oh-my-zsh

  # plugins

  zgen oh-my-zsh plugins/extract
  zgen oh-my-zsh plugins/vi-mode
  zgen oh-my-zsh plugins/colored-man-pages
  zgen oh-my-zsh plugins/autojump # note: install autojump first

  zgen load zsh-users/zsh-autosuggestions
  zgen load zsh-users/zsh-syntax-highlighting
  zgen load zsh-users/zsh-completions src

  # generate the init script from plugins above
  zgen save
fi

bindkey -v
bindkey '^y' autosuggest-accept
bindkey '^j' ignore

eval "$(starship init zsh)"

if command -v mcfly &> /dev/null; then
  eval "$(mcfly init zsh)"
fi

if command -v direnv &> /dev/null; then
  eval "$(direnv hook zsh)"
fi

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
touch "${HOME}/.env" && source "${HOME}/.env"
# zprof # uncomment top and bottom of file to profile startup
