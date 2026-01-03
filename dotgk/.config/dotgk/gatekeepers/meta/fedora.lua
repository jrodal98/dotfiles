return all({
	require("os.linux"),
	file_exists("/var/chef/outputs/cpe_info.json"),
})
