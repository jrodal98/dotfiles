local wezterm = require "wezterm"
local patterns = require "patterns"
local dotgk = require "dotgk"
local misc = require "misc"

local actions = {}

-- wezterm on macOS doesn't inherit the shell PATH, so homebrew nvim needs an
-- absolute path.
local nvim = dotgk.check "meta/mac" and "/opt/homebrew/bin/nvim" or "nvim"

actions.open_url_action = wezterm.action.QuickSelectArgs {
   label = "open url",
   -- Only patterns that resolve to something openable; the full
   -- quick_select_patterns list includes things like buck targets that
   -- wezterm.open_with can't do anything with.
   patterns = { patterns.url, patterns.diff_paste_task },
   action = wezterm.action_callback(function(window, pane)
      local url = window:get_selection_text_for_pane(pane)
      -- Rewrite diff/paste/task ids (D123, P123, T123) the same way
      -- hyperlink_rules does, so they open as fburls instead of raw text.
      if url:match "^[dDpPtT]%d+$" then
         url = "https://fburl.com/b/" .. url
      end
      wezterm.log_info("opening url: " .. url)
      wezterm.open_with(url)
   end),
}

-- https://wezfurlong.org/wezterm/config/lua/wezterm/on.html#custom-actions
actions.open_pane_in_vim = wezterm.action_callback(function(window, pane)
   -- Retrieve the scrollback text (misc.scrollback_lines caps what exists).
   local viewport_text = pane:get_lines_as_text(misc.scrollback_lines)

   -- Create a temporary file to pass to vim
   local name = os.tmpname()
   local f = io.open(name, "w+")
   f:write(viewport_text)
   f:flush()
   f:close()

   -- Open a new window running vim and tell it to open the file
   window:perform_action(
      wezterm.action.SpawnCommandInNewWindow {
         args = { nvim, name },
      },
      pane
   )

   -- Wait "enough" time for vim to read the file before we remove it.
   -- The window creation and process spawn are asynchronous wrt. running
   -- this script and are not awaitable, so we just pick a number.
   --
   -- Note: We don't strictly need to remove this file, but it is nice
   -- to avoid cluttering up the temporary directory.
   wezterm.sleep_ms(1000)
   os.remove(name)
end)

return actions
