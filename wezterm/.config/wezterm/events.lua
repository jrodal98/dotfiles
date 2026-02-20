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

-- https://wezterm.org/config/lua/pane/get_user_vars.html
wezterm.on('user-var-changed', function(window, pane, name, value)
  wezterm.log_info('var', name, value)
  if name == 'event:notify' then
      local ok, fields = pcall(wezterm.json_parse, value)
      fields = ok and type(fields) == "table" and fields or {}
      window:toast_notification(
        fields.title or 'wezterm',
        fields.message or value,
        fields.url or nil,
        fields.timeout or nil
      )
   elseif name == 'event:copy' then
    window:copy_to_clipboard(value, 'Clipboard')
  elseif name == 'WEZTERM_IN_TMUX' then
   -- User var changed in a specific pane, update window config based on active pane
   update_tmux_config(window)
  end
end)

-- Track the last known tmux state per window to avoid redundant updates
local window_tmux_state = {}

-- Helper function to update tmux config based on active pane's user vars
function update_tmux_config(window)
   local bindings = require "bindings"

   -- Get the active pane from the active tab
   local tab = window:active_tab()
   if not tab then
      return
   end

   local pane = tab:active_pane()
   if not pane then
      return
   end

   -- Check the active pane's WEZTERM_IN_TMUX value
   local user_vars = pane:get_user_vars()
   local in_tmux = user_vars.WEZTERM_IN_TMUX or "0"

   -- Get window ID for tracking state
   local window_id = window:window_id()

   -- Only update if state has changed
   if window_tmux_state[window_id] == in_tmux then
      return
   end

   -- Update tracked state
   window_tmux_state[window_id] = in_tmux

   local overrides = window:get_config_overrides() or {}

   if in_tmux == '1' then
      -- In tmux: disable WezTerm tmux keybindings to avoid conflicts
      overrides.leader = { key = "VoidSymbol", mods = "CTRL" }
      overrides.keys = bindings.base_keys
      wezterm.log_info('In tmux - WezTerm tmux keybindings disabled')
   else
      -- Not in tmux: enable WezTerm tmux-like keybindings
      overrides.leader = bindings.leader
      overrides.keys = nil
      wezterm.log_info('Not in tmux - WezTerm tmux keybindings enabled')
   end

   window:set_config_overrides(overrides)
end

-- Update tmux config when tabs are switched or status updates
wezterm.on('update-status', function(window, pane)
   update_tmux_config(window)
end)
