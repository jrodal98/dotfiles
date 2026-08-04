-- Raw regexes shared by select.lua (quick select / hyperlink rules) and
-- actions.lua (open-url quick select).

local patterns = {}

patterns.url = "\\b\\w+://(?:[\\w.-]+)\\.[a-z]{2,15}\\S*\\b"
patterns.ip_addr = "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b"
-- diffs, pastes, and tasks
patterns.diff_paste_task = "\\b([dDpPtT]\\d+)\\b"
-- match username/project paths, e.g. wbthomason/packer.nvim
patterns.github_project = [[["]?([\w\d]{1}[-\w\d]+)(/){1}([-\w\d\.]+)["]?]]
patterns.scvm = "\\bscvm\\d+\\.\\d+\\.\\S*\\b"
patterns.frecli = "frecli cas download-action .*:\\d+"
patterns.buck_target = "\\b([\\w]+//[\\w/]+:[\\w.-]+)\\b"
patterns.windows_path = "\\b([a-zA-Z]:\\\\[\\w .-]+(?:\\\\[\\w .-]+)*)\\b"

-- jrodal_1_c99fA_HzOS_University_unit__2__APIs_unit_local
patterns.devmate_trajectory = [[(jrodal_.+?_local)]]

return patterns
