local wezterm = require "wezterm"

local tmux_bindings = {}

-- Tmux-style leader key
tmux_bindings.leader = { key = "j", mods = "CTRL", timeout_milliseconds = 1000 }

-- Tmux-style keybindings (always active)
tmux_bindings.keys = {
   -- Pane splitting
   {
      key = "|",
      mods = "LEADER",
      action = wezterm.action.SplitHorizontal { domain = "CurrentPaneDomain" }
   },
   {
      key = "-",
      mods = "LEADER",
      action = wezterm.action.SplitVertical { domain = "CurrentPaneDomain" }
   },

   -- Pane navigation
   {
      key = "h",
      mods = "LEADER",
      action = wezterm.action.ActivatePaneDirection "Left"
   },
   {
      key = "j",
      mods = "LEADER",
      action = wezterm.action.ActivatePaneDirection "Down"
   },
   {
      key = "k",
      mods = "LEADER",
      action = wezterm.action.ActivatePaneDirection "Up"
   },
   {
      key = "l",
      mods = "LEADER",
      action = wezterm.action.ActivatePaneDirection "Right"
   },

   -- Copy mode
   {
      key = "[",
      mods = "LEADER",
      action = wezterm.action.ActivateCopyMode
   },

   -- Previous tab
   {
      key = "p",
      mods = "LEADER",
      action = wezterm.action.ActivateTabRelative(-1)
   },

   -- Paste
   {
      key = "P",
      mods = "LEADER",
      action = wezterm.action.PasteFrom "Clipboard"
   },

   -- Close current pane
   {
      key = "x",
      mods = "LEADER",
      action = wezterm.action.CloseCurrentPane { confirm = true }
   },

   -- Zoom pane
   {
      key = "z",
      mods = "LEADER",
      action = wezterm.action.TogglePaneZoomState
   },

   -- Create new tab
   {
      key = "c",
      mods = "LEADER",
      action = wezterm.action.SpawnTab "CurrentPaneDomain"
   },

   -- Next tab
   {
      key = "n",
      mods = "LEADER",
      action = wezterm.action.ActivateTabRelative(1)
   },

   -- Detach
   {
      key = "d",
      mods = "LEADER",
      action = wezterm.action.QuitApplication
   },

   -- Pane selection mode
   {
      key = "q",
      mods = "LEADER",
      action = wezterm.action.PaneSelect
   },

   -- Rotate panes
   {
      key = "o",
      mods = "LEADER",
      action = wezterm.action.RotatePanes "Clockwise"
   },

   -- Swap pane mode
   {
      key = "Space",
      mods = "LEADER",
      action = wezterm.action.PaneSelect { mode = "SwapWithActive" }
   },
}

return tmux_bindings
