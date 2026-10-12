#!/usr/bin/env bash
set -euo pipefail

# Run on a dedicated verifier VM after Docker starts, before customer jobs or service credentials are loaded.
[[ $(uname -s) == Linux && $EUID == 0 ]] || { printf '%s\n' 'A dedicated rootful Linux Docker host is required' >&2; exit 1; }
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT
[[ -z $(docker ps -q) ]] || { printf '%s\n' 'Refusing to change forwarding rules while containers are running' >&2; exit 1; }
guard=ACCESSWRIGHT-METADATA

for family in ipv4 ipv6; do
  if [[ $family == ipv4 ]]; then tool=/usr/sbin/iptables; address=169.254.169.254/32
  else tool=/usr/sbin/ip6tables; address=fd20:ce::254/128; fi
  [[ -x $tool ]] || { printf '%s\n' 'Both IPv4 and IPv6 firewall tools are required' >&2; exit 1; }
  if ! "$tool" -S "$guard" >/dev/null 2>&1; then
    "$tool" -N "$guard"
    "$tool" -A "$guard" -d "$address" -p udp --dport 53 -j RETURN
    "$tool" -A "$guard" -d "$address" -p tcp --dport 53 -j RETURN
    "$tool" -A "$guard" -d "$address" -j DROP
    "$tool" -A "$guard" -j RETURN
  fi
  expected=$(printf '%s\n' \
    "-A $guard -d $address -p udp -m udp --dport 53 -j RETURN" \
    "-A $guard -d $address -p tcp -m tcp --dport 53 -j RETURN" \
    "-A $guard -d $address -j DROP" "-A $guard -j RETURN")
  actual=$("$tool" -S "$guard" | sed -n "/^-A $guard /p")
  [[ $actual == "$expected" ]] || { printf '%s\n' 'Existing metadata chain is different; preserve it and reconcile manually' >&2; exit 1; }
  first=$("$tool" -S FORWARD | sed -n '/^-A FORWARD /{p;q;}')
  if [[ $first != "-A FORWARD -j $guard" ]]; then "$tool" -I FORWARD 1 -j "$guard"; fi
  [[ $("$tool" -S FORWARD | sed -n '/^-A FORWARD /{p;q;}') == "-A FORWARD -j $guard" ]] || exit 1
done
printf '%s\n' 'Metadata forwarding guard installed; verifier startup independently rechecks it'
