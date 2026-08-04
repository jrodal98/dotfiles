local wezterm = require "wezterm"
local aesthetics = require "aesthetics"

wezterm.on("toggle-opacity", function(window, _)
   local overrides = window:get_config_overrides() or {}
   if overrides.window_background_opacity == 1 then
      overrides.window_background_opacity = aesthetics.window_background_opacity
   else
      overrides.window_background_opacity = 1
   end
   window:set_config_overrides(overrides)
end)

local act = wezterm.action

wezterm.on("augment-command-palette", function(window, pane)
   return {
      {
         brief = "Rename tab",
         icon = "md_rename_box",

         action = act.PromptInputLine {
            description = "Enter new name for tab",
            action = wezterm.action_callback(function(window, pane, line)
               if line then
                  window:active_tab():set_title(line)
               end
            end),
         },
      },
   }
end)

-- Highlight the active tab, and flag background tabs that produced output
-- since they were last visible.
local TAB_ACTIVE_BG = "#3700b3"
local TAB_UNSEEN_BG = "#014443"

wezterm.on("format-tab-title", function(tab, _, _, _, _, _)
   local title = string.format(" %-11s", tab.active_pane.title)

   if tab.is_active then
      return { { Background = { Color = TAB_ACTIVE_BG } }, { Text = title } }
   end

   for _, pane in ipairs(tab.panes) do
      if pane.has_unseen_output then
         return { { Background = { Color = TAB_UNSEEN_BG } }, { Text = title } }
      end
   end

   return title
end)

-- https://wezterm.org/config/lua/pane/get_user_vars.html
wezterm.on("user-var-changed", function(window, pane, name, value)
   wezterm.log_info("var", name, value)
   if name == "event:notify" then
      local ok, fields = pcall(wezterm.json_parse, value)
      fields = ok and type(fields) == "table" and fields or {}
      window:toast_notification(fields.title or "wezterm", fields.message or value, fields.url, fields.timeout)
   elseif name == "event:copy" then
      window:copy_to_clipboard(value, "Clipboard")
   end
end)
