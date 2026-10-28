#!/bin/sh
# Runs once as a NET_ADMIN initializer, before untrusted renderer code starts.
# No credential, persistent mount or service-account token is present.
set -eu
install_rules() {
  command="$1"
  "$command" -w 5 -N ASSET_RENDERER_OUT
  "$command" -w 5 -A ASSET_RENDERER_OUT -o lo -j ACCEPT
  "$command" -w 5 -A ASSET_RENDERER_OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  "$command" -w 5 -A ASSET_RENDERER_OUT -j DROP
  "$command" -w 5 -I OUTPUT 1 -j ASSET_RENDERER_OUT
}
install_rules iptables
if ip6tables -w 5 -L OUTPUT >/dev/null 2>&1; then
  install_rules ip6tables
elif [ -e /proc/net/if_inet6 ]; then
  # Fail closed even for link-local IPv6 when filtering is unavailable.
  if awk '$1 != "00000000000000000000000000000001" {found=1} END {exit !found}' /proc/net/if_inet6; then
    echo 'IPv6 isolation could not be configured' >&2
    exit 1
  fi
fi
echo 'Renderer egress firewall installed'
