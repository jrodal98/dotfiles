# Troubleshooting

If keys aren't being sent, it may be a permissions issue.

The easiest way to maintain write access to /dev/uinput is to use Solaar's alternative udev rule by downloading https://raw.githubusercontent.com/pwr-Solaar/Solaar/master/rules.d-uinput/42-logitech-unify-permissions.rules and copying it as root into the /etc/udev/rules.d directory. You may have to reboot your system for the write permission to be set up. Another way to get write access to /dev/uinput is to run sudo setfacl -m u:${USER}:rw /dev/uinput but this needs to be done every time the system is rebooted.
