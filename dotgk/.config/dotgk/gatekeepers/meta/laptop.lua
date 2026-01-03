return any({
  file_exists("/var/chef/outputs/cpe_info.json"),
  file_exists("C:/chef/outputs/cpe_info.json"),
  file_exists("/mnt/c/chef/outputs/cpe_info.json"),
})
