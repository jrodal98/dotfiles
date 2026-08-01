require "events"

local dotgk = require "dotgk"

-- enkaku (`ek`) only exists on meta machines. This is a machine-level gate, so
-- it belongs here: inside enkaku.lua the handlers must stay unconditional,
-- because `ek wezterm` often spawns into an existing GUI process that does not
-- carry the ENKAKU_* env vars.
if dotgk.check "meta" then
   require "enkaku"
end

local bindings = require "bindings"
local select = require "select"
local aesthetics = require "aesthetics"
local misc = require "misc"

local config = {
   ----------- Aesthetics ----------
   window_background_opacity = aesthetics.window_background_opacity,
   hide_tab_bar_if_only_one_tab = aesthetics.hide_tab_bar_if_only_one_tab,
   font_size = aesthetics.font_size,
   window_decorations = aesthetics.window_decorations,
   initial_cols = aesthetics.initial_cols,
   initial_rows = aesthetics.initial_rows,
   ----------- Bindings ----------
   keys = bindings.keys,
   key_tables = bindings.key_tables,
   mouse_bindings = bindings.mouse,
   leader = bindings.leader,
   ----------- Selection ----------
   quick_select_patterns = select.quick_select_patterns,
   hyperlink_rules = select.hyperlink_rules,
   ----------- Misc ----------
   -- prevents terminal hanging when exiting with ctrl-d
   exit_behavior = misc.exit_behavior,
   audible_bell = misc.audible_bell,
   scrollback_lines = misc.scrollback_lines,
   selection_word_boundary = misc.selection_word_boundary,
   default_domain = misc.default_domain,
   launch_menu = misc.launch_menu,
}

return config
