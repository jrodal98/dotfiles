local wezterm = require "wezterm"

local misc = {}

-- prevents terminal hanging when exiting with ctrl-d
misc.exit_behavior = "Close"
misc.audible_bell = "Disabled"

-- Default is 3500, which silently truncates actions.open_pane_in_vim.
misc.scrollback_lines = 20000

-- Default stops at path separators; this keeps paths/targets in one word.
misc.selection_word_boundary = " \t\n{}[]()'\"`,;:="

misc.launch_menu = {}
misc.default_domain = nil
if wezterm.target_triple == "x86_64-pc-windows-msvc" then
   misc.default_domain = "WSL:Ubuntu"
   table.insert(misc.launch_menu, {
      label = "PowerShell",
      args = { "/mnt/c/Windows/System32/WindowsPowerShell/v1.0//powershell.exe", "-NoLogo" },
   })

   table.insert(misc.launch_menu, {
      label = "Pwsh",
      args = { "/mnt/c/Program Files/PowerShell/7//pwsh.exe", "-NoLogo" },
   })
end

return misc
