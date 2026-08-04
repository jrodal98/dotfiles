-- Enkaku (`ek`) integration.
--
-- IMPORTANT: these handlers are registered unconditionally, and enkaku-ness is
-- checked *inside* each callback. Do not gate the module on
-- os.getenv("ENKAKU_WEZTERM_HOSTNAME") at load time: `ek wezterm` frequently
-- hands its spawn to an already-running wezterm GUI process ("Spawned your
-- command via the existing GUI instance" in the gui log), and that process does
-- not have the ENKAKU_* vars in its environment. A load-time gate makes the
-- whole module inert exactly in that case.
--
-- Vars set by `ek wezterm` / `ek connect -W` when it does own the GUI process:
--   ENKAKU_WEZTERM_HOSTNAME     remote host backing the mux session
--   ENKAKU_WEZTERM_DESCRIPTION  description from `ek connect -d <desc>`

local wezterm = require "wezterm"
local aesthetics = require "aesthetics"

-- `wezterm cli activate-pane` can focus a pane but cannot raise the OS window;
-- only lua running inside the GUI can. So `ek claude focus` (and the wezterm
-- grid code) sets the window title to this sentinel and expects the config to
-- notice it and call window:focus().
local FOCUS_SENTINEL = "__ek_focus__"

wezterm.on("format-window-title", function(tab, pane, tabs, panes, config)
   -- Checked first, and unconditionally: this must work even in a GUI process
   -- that was not itself launched by ek.
   if tab.window_title == FOCUS_SENTINEL then
      wezterm.GLOBAL.focus_window_id = tab.window_id
   end

   local hostname = os.getenv "ENKAKU_WEZTERM_HOSTNAME"
   local description = os.getenv "ENKAKU_WEZTERM_DESCRIPTION"

   if hostname then
      hostname = hostname:gsub("%.thefacebook%.com$", ""):gsub("%.facebook%.com$", "")
      if description and description ~= "" then
         return hostname .. " | " .. description
      end
      return hostname
   end

   return "Local"
end)

-- format-window-title runs during render and has no window object, so it hands
-- the focus request off to update-status, which does.
wezterm.on("update-status", function(window, pane)
   local wid = wezterm.GLOBAL.focus_window_id
   if wid ~= nil and window:window_id() == wid then
      wezterm.GLOBAL.focus_window_id = nil
      window:focus()
   end
end)

-- DISABLED: the paste's workaround for `wezterm connect` ignoring
-- initial_cols/initial_rows (https://github.com/wezterm/wezterm/issues/6826)
-- hard-crashes wezterm-gui on this machine. Crash reports in
-- ~/Library/Logs/DiagnosticReports/wezterm-gui-*.ips show:
--
--   window::os::macos::window::WindowInner::set_inner_size
--     -> -[NSWindow _setFrameCommon:display:fromServer:]
--       -> -[NSWindow _adjustNeedsDisplayRegionForNewFrame:]  EXC_BREAKPOINT
--
-- A freshly spawned mux/connect pane reports zeroed pixel metrics (the spawn
-- response logs dpi: 0), so pixel_width/cols is 0 or inf, and NSWindow traps on
-- the resulting 0x0 / non-finite frame. That is why it killed `ek wezterm`
-- specifically and left local windows alone.
--
-- Set ENABLE_CONNECT_RESIZE = true to try the guarded version again; the log
-- line below records the dimensions we would have used.
local ENABLE_CONNECT_RESIZE = false

wezterm.on("window-config-reloaded", function(window, pane)
   local id = tostring(window:window_id())
   local seen = wezterm.GLOBAL.seen_windows or {}
   local is_new_window = not seen[id]
   seen[id] = true
   wezterm.GLOBAL.seen_windows = seen

   if not is_new_window then
      return
   end

   local dims = pane:get_dimensions()
   if not dims then
      return
   end

   local cols, rows = dims.cols, dims.viewport_rows
   local px, py = dims.pixel_width, dims.pixel_height
   wezterm.log_info(
      string.format(
         "enkaku-dims: window=%s cols=%s rows=%s px=%s py=%s",
         id,
         tostring(cols),
         tostring(rows),
         tostring(px),
         tostring(py)
      )
   )

   if not ENABLE_CONNECT_RESIZE then
      return
   end

   -- Every one of these guards matters: a zero or missing value here is an
   -- application-level crash, not a lua error.
   if type(cols) ~= "number" or type(rows) ~= "number" or cols < 1 or rows < 1 then
      return
   end
   if type(px) ~= "number" or type(py) ~= "number" or px < 1 or py < 1 then
      return
   end

   local cell_width = math.floor(px / cols)
   local cell_height = math.floor(py / rows)
   if cell_width < 1 or cell_height < 1 then
      return
   end

   local target_width = aesthetics.initial_cols * cell_width
   local target_height = aesthetics.initial_rows * cell_height
   if target_width < 200 or target_height < 200 or target_width > 20000 or target_height > 20000 then
      return
   end

   window:set_inner_size(target_width, target_height)
end)
