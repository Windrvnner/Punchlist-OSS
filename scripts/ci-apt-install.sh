#!/bin/sh
# Installs Ubuntu packages on a CI runner: sh scripts/ci-apt-install.sh <package>...
# An apt mirror can stall a job until its timeout, so each try is cut off and the install is tried three times.
set -u
for try in 1 2 3; do
  if timeout 180 sudo apt-get update \
    && timeout 300 sudo apt-get install -y --no-install-recommends "$@"; then
    exit 0
  fi
  echo "apt-get try $try failed or stalled"
  # an install cut off part way leaves dpkg half done, and the next try would stop on that
  sudo dpkg --configure -a
done
exit 1
