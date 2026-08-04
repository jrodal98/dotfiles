-- dotgk wrapper for wezterm
-- Loads dotgk cache or falls back to all-false defaults

local wezterm = require "wezterm"

local home = wezterm.home_dir
local cache_path = home .. "/.config/dotgk/caches/dotgk.lua"

local function load_dotgk()
   local f = io.open(cache_path, "r")
   if not f then
      return nil
   end
   local content = f:read "*a"
   f:close()

   local chunk = load(content, "dotgk-cache")
   if chunk then
      local ok, result = pcall(chunk)
      if ok then
         return result
      end
   end
   return nil
end

local dotgk = load_dotgk()

if not dotgk then
   wezterm.log_warn "dotgk not configured - using defaults (all checks return false)"
   dotgk = {
      check = function(_)
         return false
      end,
   }
end

return dotgk
