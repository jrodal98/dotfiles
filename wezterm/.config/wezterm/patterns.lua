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

-- pi --session 01a0cf8e-54b6-7233-93d9-93af81f0edfe
patterns.pi_session = "\\bpi --session [0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b"

return patterns
