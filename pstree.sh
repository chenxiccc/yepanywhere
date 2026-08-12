#!/usr/bin/env bash

set -euo pipefail

sample_seconds=${1:-1}
self_pid=$$
if ! [[ $sample_seconds =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ ]] ||
  ! awk -v seconds="$sample_seconds" 'BEGIN { exit !(seconds > 0) }'; then
  echo "usage: $0 [positive-sample-seconds]" >&2
  exit 2
fi

clock_ticks=$(getconf CLK_TCK)
page_bytes=$(getconf PAGESIZE)

declare -A first_ticks=()
declare -A ppid=()
declare -A command_name=()
declare -A command_line=()
declare -A virtual_bytes=()
declare -A resident_bytes=()
declare -A cpu_percent=()
declare -A children=()
declare -A is_ya_root=()
declare -A tree_cpu=()
declare -A tree_virtual=()
declare -A tree_resident=()

read_process_stat() {
  local pid=$1
  local stat_line stat_tail
  local -a stat_fields

  [[ -r /proc/$pid/stat ]] || return 1
  IFS= read -r stat_line < "/proc/$pid/stat" || return 1
  stat_tail=${stat_line##*) }
  read -r -a stat_fields <<< "$stat_tail"
  ((${#stat_fields[@]} >= 22)) || return 1

  # /proc/PID/stat fields after the parenthesized comm start at field 3.
  PROC_PPID=${stat_fields[1]}
  PROC_TICKS=$((stat_fields[11] + stat_fields[12]))
  PROC_VIRTUAL=${stat_fields[20]}
  PROC_RESIDENT=$((stat_fields[21] * page_bytes))
}

read_command_line() {
  local pid=$1
  local -a argv=()

  while IFS= read -r -d '' argument; do
    argv+=("$argument")
  done < "/proc/$pid/cmdline" 2>/dev/null || true
  printf '%s\034' "${argv[*]-}"
}

is_dev_wrapper() {
  local pid=$1 argument
  while IFS= read -r -d '' argument; do
    case "$argument" in
      scripts/dev.js|*/scripts/dev.js) return 0 ;;
    esac
  done < "/proc/$pid/cmdline" 2>/dev/null || true
  return 1
}

is_ya_checkout() {
  local pid=$1
  local working_dir
  working_dir=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || return 1
  [[ -f $working_dir/package.json && -f $working_dir/scripts/dev.js ]] || return 1
  grep -Eq '"name"[[:space:]]*:[[:space:]]*"yep-anywhere"' \
    "$working_dir/package.json" 2>/dev/null
}

capture_first_ticks() {
  local proc_dir pid
  for proc_dir in /proc/[0-9]*; do
    pid=${proc_dir##*/}
    if read_process_stat "$pid"; then
      first_ticks[$pid]=$PROC_TICKS
    fi
  done
}

capture_current_processes() {
  local proc_dir pid line
  for proc_dir in /proc/[0-9]*; do
    pid=${proc_dir##*/}
    [[ $pid == "$self_pid" ]] && continue
    read_process_stat "$pid" || continue

    ppid[$pid]=$PROC_PPID
    virtual_bytes[$pid]=$PROC_VIRTUAL
    resident_bytes[$pid]=$PROC_RESIDENT
    IFS= read -r command_name[$pid] < "/proc/$pid/comm" || command_name[$pid]='?'
    line=$(read_command_line "$pid")
    line=${line%$'\034'}
    command_line[$pid]=$line

    if is_dev_wrapper "$pid" && is_ya_checkout "$pid"; then
      is_ya_root[$pid]=1
    fi

    if [[ -n ${first_ticks[$pid]+x} ]]; then
      cpu_percent[$pid]=$(awk \
        -v delta="$((PROC_TICKS - first_ticks[$pid]))" \
        -v ticks="$clock_ticks" \
        -v seconds="$sample_seconds" \
        'BEGIN { printf "%.1f", 100 * delta / ticks / seconds }')
    else
      cpu_percent[$pid]='?'
    fi
  done

  for pid in "${!ppid[@]}"; do
    children[${ppid[$pid]}]+=" $pid"
  done
}

owner_for() {
  local pid=$1
  local inherited_owner=$2
  local line=${command_line[$pid]}

  if [[ -n ${is_ya_root[$pid]+x} ]]; then
    echo 'YA wrapper'
    return
  fi

  case "$line" in
    *provider-runtime-host.mjs*) echo 'YA host: providers' ;;
    *summary-parser-worker-entry*) echo 'YA parser worker' ;;
    *vite/bin/vite.js*|*vite.js*) echo 'YA client: Vite' ;;
    *node_modules*/@esbuild/*|*node_modules*/esbuild*) echo 'YA build: esbuild' ;;
    *packages/server*src/index.ts*|*'--conditions source src/index.ts'*) echo 'YA server' ;;
    *codex*app-server*|*codex*' app-server'*) echo 'Codex harness' ;;
    *claude*|*@anthropic-ai/claude-agent-sdk*) echo 'Claude harness' ;;
    *opencode*) echo 'OpenCode harness' ;;
    *gemini*) echo 'Gemini harness' ;;
    *)
      if [[ $inherited_owner == 'Codex harness' ]]; then
        echo 'Codex harness'
      elif [[ $inherited_owner == *'harness' ]]; then
        echo "$inherited_owner"
      else
        echo 'YA descendant'
      fi
      ;;
  esac
}

sum_tree() {
  local pid=$1 child
  local cpu=${cpu_percent[$pid]}
  local cpu_total=0
  local virtual_total=${virtual_bytes[$pid]}
  local resident_total=${resident_bytes[$pid]}

  [[ $cpu != '?' ]] && cpu_total=$cpu
  for child in ${children[$pid]-}; do
    [[ -n ${ppid[$child]+x} ]] || continue
    sum_tree "$child"
    cpu_total=$(awk -v left="$cpu_total" -v right="${tree_cpu[$child]}" \
      'BEGIN { printf "%.1f", left + right }')
    virtual_total=$((virtual_total + tree_virtual[$child]))
    resident_total=$((resident_total + tree_resident[$child]))
  done

  tree_cpu[$pid]=$cpu_total
  tree_virtual[$pid]=$virtual_total
  tree_resident[$pid]=$resident_total
}

format_bytes() {
  awk -v bytes="$1" 'BEGIN {
    if (bytes >= 1073741824) printf "%.1fG", bytes / 1073741824;
    else if (bytes >= 1048576) printf "%.0fM", bytes / 1048576;
    else if (bytes >= 1024) printf "%.0fK", bytes / 1024;
    else printf "%dB", bytes;
  }'
}

print_tree() {
  local pid=$1 line_prefix=$2 children_prefix=$3 inherited_owner=$4
  local child owner branch next_children_prefix i
  local -a live_children=()

  owner=$(owner_for "$pid" "$inherited_owner")
  printf '%s%-8s %-15.15s %-19.19s %6s %7s %7s | %6s %7s %7s\n' \
    "$line_prefix" "$pid" "${command_name[$pid]}" "$owner" \
    "${cpu_percent[$pid]}" "$(format_bytes "${virtual_bytes[$pid]}")" \
    "$(format_bytes "${resident_bytes[$pid]}")" \
    "${tree_cpu[$pid]}" "$(format_bytes "${tree_virtual[$pid]}")" \
    "$(format_bytes "${tree_resident[$pid]}")"

  for child in ${children[$pid]-}; do
    [[ -n ${ppid[$child]+x} ]] && live_children+=("$child")
  done
  for ((i = 0; i < ${#live_children[@]}; i++)); do
    child=${live_children[$i]}
    if ((i == ${#live_children[@]} - 1)); then
      branch='└─'
      next_children_prefix="$children_prefix  "
    else
      branch='├─'
      next_children_prefix="$children_prefix│ "
    fi
    print_tree "$child" "$children_prefix$branch" "$next_children_prefix" "$owner"
  done
}

capture_first_ticks
sleep "$sample_seconds"
capture_current_processes

if ((${#is_ya_root[@]} == 0)); then
  echo 'No running YA scripts/dev.js wrapper found.' >&2
  exit 1
fi

echo "CPU is a ${sample_seconds}s interval sample; 100% = one fully used core."
echo 'Left of |: direct process values.  Right of |: descendant-inclusive tree sums (Σ).'
echo 'ΣRSS and ΣVIRT are attribution sums and may double-count shared pages/mappings.'
printf '%-8s %-15s %-19s %6s %7s %7s | %6s %7s %7s\n' \
  PID COMMAND OWNER CPU% VIRT RSS ΣCPU% ΣVIRT ΣRSS

for pid in $(printf '%s\n' "${!is_ya_root[@]}" | sort -n); do
  sum_tree "$pid"
  print_tree "$pid" '' '' ''
done
