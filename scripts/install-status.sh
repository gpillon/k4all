#!/bin/bash

watch -t "echo '--- Service status ---'; \
          systemctl list-units | grep fck8s | awk '{ printf  \" - %-50s %-10s %-10s %-10s\\n\", \$1, \$2, \$3, \$4}'; \
          echo ''; echo '--- Logs ---'; \
          journalctl -u fck8s* -n 30 --no-pager"
