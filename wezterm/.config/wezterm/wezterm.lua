require "events"

local dotgk = require "dotgk"

-- enkaku (`ek`) only exists on meta machines. This is a machine-level gate, so
-- it belongs here: inside enkaku.lua the handlers must stay unconditional,
-- because `ek wezterm` often spawns into an existing GUI process that does not
-- carry the ENKAKU_* env vars.
if dotgk.check "meta" then
   require "enkaku"
end

-- Each module returns a table of wezterm config options; merge them all.
-- aesthetics: opacity, font, window size/decorations
-- bindings: keys, key_tables, mouse_bindings, leader (incl. tmux_bindings)
-- select: quick_select_patterns, hyperlink_rules
-- misc: exit/bell/scrollback/selection, windows launch menu
local config = {}
for _, name in ipairs { "aesthetics", "bindings", "select", "misc" } do
   for key, value in pairs(require(name)) do
      config[key] = value
   end
end

return config
