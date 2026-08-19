local dotgk = require "dotgk"

local is_mac = dotgk.check "meta/mac"

return {
   window_background_opacity = dotgk.check "meta/windows" and 0 or 0.75,
   hide_tab_bar_if_only_one_tab = true,
   font_size = is_mac and 20 or 16,
   -- Configures whether the window has a title bar and/or resizable border.
   window_decorations = is_mac and "RESIZE" or "INTEGRATED_BUTTONS|RESIZE",
}
