local wezterm = require "wezterm"
local patterns = require "patterns"

local select = {}

-- quick select mode (CTRL-SHIFT-SPACE)
select.quick_select_patterns = {
   patterns.url,
   patterns.ip_addr,
   patterns.diff_paste_task,
   -- patterns.github_project,
   patterns.scvm,
   patterns.frecli,
   patterns.buck_target,
   patterns.windows_path,
   patterns.devmate_trajectory,
}

select.hyperlink_rules = wezterm.default_hyperlink_rules()

table.insert(select.hyperlink_rules, {
   regex = patterns.diff_paste_task,
   format = "https://fburl.com/b/$1",
})

table.insert(select.hyperlink_rules, {
   regex = patterns.github_project,
   format = "https://www.github.com/$1/$3",
})

table.insert(select.hyperlink_rules, {
   regex = patterns.devmate_trajectory,
   format = "https://www.internalfb.com/intern/devai/devmate/inspector/$1_0",
})

return select
