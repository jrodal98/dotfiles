#!/usr/bin/env bash

# Check if version is provided
if [ -z "$1" ]; then
  echo "Usage: $0 <version>" >&2
  exit 1
fi

# Normalize version to start with 'v'
version=${1/#v/v}

# Define installation directories
SOFTWARE_DIR="$HOME/software"
INSTALL_DIR="$SOFTWARE_DIR/nvim-linux-x86_64"
BIN_DIR="$HOME/bin"

# Ensure software directory exists
mkdir -p "$SOFTWARE_DIR"

# Download and install Neovim
(
  cd "$SOFTWARE_DIR" || exit 1
  curl -LO "https://github.com/neovim/neovim/releases/download/$version/nvim-linux-x86_64.tar.gz"
  rm -rf "$INSTALL_DIR"
  tar xzf nvim-linux-x86_64.tar.gz
  chmod +x "$INSTALL_DIR/bin/nvim"
)

# Update symlink to nvim executable
if [ -e "$BIN_DIR/nvim" ]; then
  rm "$BIN_DIR/nvim"
fi
mkdir -p "$BIN_DIR"
ln -s "$INSTALL_DIR/bin/nvim" "$BIN_DIR/nvim"
