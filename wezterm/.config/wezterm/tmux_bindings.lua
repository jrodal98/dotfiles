local wezterm = require "wezterm"
local act = wezterm.action

local tmux_bindings = {}

-- Tmux-style leader key
tmux_bindings.leader = { key = "j", mods = "CTRL", timeout_milliseconds = 1000 }

-- Tmux-style keybindings (always active)
local leader_keys = {
   -- Pane splitting
   ["|"] = act.SplitHorizontal { domain = "CurrentPaneDomain" },
   ["-"] = act.SplitVertical { domain = "CurrentPaneDomain" },
   -- Pane navigation
   h = act.ActivatePaneDirection "Left",
   j = act.ActivatePaneDirection "Down",
   k = act.ActivatePaneDirection "Up",
   l = act.ActivatePaneDirection "Right",
   -- Copy mode
   ["["] = act.ActivateCopyMode,
   -- Tabs
   c = act.SpawnTab "CurrentPaneDomain",
   n = act.ActivateTabRelative(1),
   p = act.ActivateTabRelative(-1),
   -- Paste
   P = act.PasteFrom "Clipboard",
   -- Panes
   x = act.CloseCurrentPane { confirm = true },
   z = act.TogglePaneZoomState,
   q = act.PaneSelect,
   o = act.RotatePanes "Clockwise",
   Space = act.PaneSelect { mode = "SwapWithActive" },
   -- Quit. Note: unlike tmux detach, this closes EVERY window (for mux
   -- domains the server keeps running, so it acts like a detach there).
   d = act.QuitApplication,
}

tmux_bindings.keys = {}
for key, action in pairs(leader_keys) do
   table.insert(tmux_bindings.keys, { key = key, mods = "LEADER", action = action })
end

return tmux_bindings
