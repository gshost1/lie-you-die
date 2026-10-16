#!/bin/bash
# Root-side exec tracer launcher. Picks the best tracer this kernel supports:
#   A exec-tracer.bt        syscall tracepoints: argv + exit codes
#   B exec-tracer-sched.bt  sched tracepoints + BTF: argv (≤200 bytes) + exit codes
#   C exec-tracer-min.bt    sched tracepoint only: executable path, no argv/exit
# plus, always, a /proc poller (argv of processes alive ≥ ~20ms) as a backstop.
# Writes the chosen variant and diagnostics to /opt/lyd/out/tracer.info.
# Usage: start-tracer.sh <uid>
set -u
UID_AGENT="$1"
D=/opt/lyd
O=$D/out
{
  echo "kernel: $(uname -r)"
  echo "btf: $([ -e /sys/kernel/btf/vmlinux ] && echo yes || echo no)"
  echo "execve tracepoint: $(timeout 15 bpftrace -l 'tracepoint:syscalls:sys_enter_execve' 2>/dev/null | head -1)"
  echo "sched_process_exec: $(timeout 15 bpftrace -l 'tracepoint:sched:sched_process_exec' 2>/dev/null | head -1)"
} > $O/tracer.info

try() { # try <variant> <file>: start it, keep it if it is still alive after 3s
  BPFTRACE_MAX_STRLEN=200 nohup bpftrace -f json "$D/$2" "$UID_AGENT" > $O/trace.jsonl 2> $O/trace.err < /dev/null &
  local pid=$!
  sleep 3
  if kill -0 $pid 2>/dev/null; then echo $pid > $O/tracer.pid; echo "variant: $1 ($2)" >> $O/tracer.info; return 0; fi
  echo "variant $1 failed: $(head -3 $O/trace.err | tr '\n' ' ')" >> $O/tracer.info
  return 1
}
try A exec-tracer.bt || try B exec-tracer-sched.bt || try C exec-tracer-min.bt || echo "variant: none" >> $O/tracer.info

# /proc poller backstop: every 20ms, record new PIDs owned by the agent uid
# with their cmdline. Misses very short processes and has no exit codes.
nohup bash -c '
  declare -A seen
  while :; do
    for p in /proc/[0-9]*; do
      pid=${p#/proc/}
      [ -n "${seen[$pid]:-}" ] && continue
      [ "$(stat -c %u $p 2>/dev/null)" = "'"$UID_AGENT"'" ] || continue
      cmd=$(tr "\0" "\037" < $p/cmdline 2>/dev/null) || continue
      [ -n "$cmd" ] || continue
      seen[$pid]=1
      printf "%s\t%s\t%s\n" "$pid" "$(date +%s%N)" "$cmd"
    done
    sleep 0.02
  done' > $O/procpoll.tsv 2>/dev/null < /dev/null &
echo $! > $O/procpoll.pid
