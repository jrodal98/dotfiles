local wezterm = require "wezterm"
local actions = require "actions"
local tmux_bindings = require "tmux_bindings"

local META = "CTRL|SHIFT|ALT|SUPER"

-- default bindings: https://wezfurlong.org/wezterm/config/default-keys.html
local keys = {
   -- Enable Shift+Enter for multi-line input in Claude Code
   { key = "\r", mods = "SHIFT", action = wezterm.action { SendString = "\n" } },
   -- Disable default Alt+Enter -> ToggleFullScreen
   { key = "Enter", mods = "ALT", action = wezterm.action.DisableDefaultAssignment },
   { key = "+", mods = "SUPER|SHIFT", action = "IncreaseFontSize" },
   { key = "+", mods = "CTRL|SHIFT", action = "IncreaseFontSize" },
   { key = "Space", mods = META, action = "QuickSelect" },
   { key = "s", mods = META, action = "QuickSelect" },
   { key = "v", mods = META, action = actions.open_pane_in_vim },
   { key = "x", mods = META, action = wezterm.action.ActivateCopyMode },
   { key = "c", mods = META, action = wezterm.action.ActivateCopyMode },
}

-- Bindings that should work under both CTRL|SHIFT and the META chord.
for key, action in pairs {
   e = actions.open_url_action,
   b = wezterm.action.EmitEvent "toggle-opacity",
} do
   table.insert(keys, { key = key, mods = "CTRL|SHIFT", action = action })
   table.insert(keys, { key = key, mods = META, action = action })
end

-- Tmux-style leader bindings
for _, binding in ipairs(tmux_bindings.keys) do
   table.insert(keys, binding)
end

-- Start from the default key tables and append overrides (later entries win).
-- wezterm.gui is nil in mux-server context, hence the guard.
local key_tables = wezterm.gui and wezterm.gui.default_key_tables() or {}

local function extend(name, overrides)
   local tbl = key_tables[name] or {}
   for _, binding in ipairs(overrides) do
      table.insert(tbl, binding)
   end
   key_tables[name] = tbl
end

extend("copy_mode", {
   { key = "u", mods = "CTRL", action = wezterm.action { CopyMode = "PageUp" } },
   { key = "d", mods = "CTRL", action = wezterm.action { CopyMode = "PageDown" } },
   {
      key = "y",
      mods = "NONE",
      action = wezterm.action {
         Multiple = {
            wezterm.action { CopyTo = "ClipboardAndPrimarySelection" },
            wezterm.action { CopyMode = "Close" },
         },
      },
   },
   -- Enter search mode to edit the pattern.
   -- When the search pattern is an empty string the existing pattern is preserved
   { key = "/", mods = "NONE", action = wezterm.action { Search = { CaseInSensitiveString = "" } } },
   -- navigate any search mode results
   { key = "n", mods = "NONE", action = wezterm.action { CopyMode = "NextMatch" } },
   { key = "N", mods = "SHIFT", action = wezterm.action { CopyMode = "PriorMatch" } },
   { key = "n", mods = "CTRL", action = wezterm.action.CopyMode "MoveForwardSemanticZone" },
   { key = "p", mods = "CTRL", action = wezterm.action.CopyMode "MoveBackwardSemanticZone" },
})

extend("search_mode", {
   { key = "Escape", mods = "NONE", action = wezterm.action { CopyMode = "Close" } },
   -- Go back to copy mode when pressing enter, so that we can use unmodified keys like "n"
   -- to navigate search results without conflicting with typing into the search area.
   { key = "Enter", mods = "NONE", action = "ActivateCopyMode" },
   { key = "r", mods = "CTRL", action = wezterm.action { CopyMode = "CycleMatchType" } },
   { key = "u", mods = "CTRL", action = wezterm.action { CopyMode = "ClearPattern" } },
})

return {
   keys = keys,
   key_tables = key_tables,
   leader = tmux_bindings.leader,
   mouse_bindings = {
      --- Triple click on one character of the command output
      --  to select all of the output
      {
         event = { Down = { streak = 3, button = "Left" } },
         action = { SelectTextAtMouseCursor = "SemanticZone" },
         mods = "NONE",
      },
   },
}
