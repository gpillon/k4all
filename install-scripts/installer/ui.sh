#!/bin/bash

set -euo pipefail

# Minimal tput-based UI helpers

ui_init() {
  tput civis || true
  tput clear || true
}

ui_end() {
  tput cnorm || true
}

term_cols() {
  if command -v tput >/dev/null 2>&1; then
    tput cols 2>/dev/null || echo 80
  else
    echo 80
  fi
}

ui_center() {
  local text="$1"
  local cols=$(term_cols)
  local pad=$(( (cols - ${#text}) / 2 ))
  if [ $pad -lt 0 ]; then pad=0; fi
  printf "%*s%s\n" $pad "" "$text" >&2
}

ui_title() {
  local title="$1"
  tput clear || true
  local text=" $title "
  local w=${#text}
  local bar
  printf -v bar '%*s' "$w" ''
  bar=${bar// /-}
  printf "+%s+\n" "$bar" >&2
  printf "|%s|\n" "$text" >&2
  printf "+%s+\n\n" "$bar" >&2
}

ui_msg() {
  printf "%s\n" "$1" >&2
}

ui_pause() {
  printf "\nPress any key to continue..." >&2
  IFS= read -r -n 1 -s _ || true
  printf "\n" >&2
}

ui_prompt_input() {
  # args: prompt, default, timeout_seconds -> echoes value or default on timeout/empty
  local prompt="$1"
  local default_val="${2:-}"
  local timeout="${3:-0}"
  local input=""
  if [ -n "$default_val" ]; then
    printf "%s [%s]: " "$prompt" "$default_val" >&2
  else
    printf "%s: " "$prompt" >&2
  fi
  if [ "$timeout" -gt 0 ]; then
    if read -r -t "$timeout" input; then
      :
    else
      input="$default_val"
    fi
  else
    read -r input || true
  fi
  if [ -z "${input}" ]; then
    input="$default_val"
  fi
  echo "$input"
}

ui_prompt_yesno() {
  # args: question, default_yes(no)=yes|no, timeout_seconds -> returns 0=yes,1=no
  local question="$1"
  local default_ans="${2:-yes}"
  local timeout="${3:-0}"
  local hint="(y/n)"
  if [ "$default_ans" = "yes" ]; then
    hint="(Y/n)"
  else
    hint="(y/N)"
  fi
  local ans=""
  printf "%s %s: " "$question" "$hint" >&2
  if [ "$timeout" -gt 0 ]; then
    if read -r -t "$timeout" ans; then :; else ans=""; fi
  else
    read -r ans || true
  fi
  if [ -z "$ans" ]; then
    [ "$default_ans" = "yes" ] && return 0 || return 1
  fi
  case "$ans" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

ui_prompt_menu() {
  # args: title, default_index(1-based), timeout_seconds, options... -> echoes selected index and value
  local title="$1"
  local default_idx=${2:-1}
  local timeout=${3:-0}
  shift 3 || true
  local options=("$@")
  local count=${#options[@]}
  if [ "$count" -eq 0 ]; then
    if [ -n "$title" ]; then printf "%s\n" "$title" >&2; fi
    ui_msg "No options available." >&2
    echo ""
    return 0
  fi
  if [ -n "$title" ]; then printf "%s\n" "$title" >&2; fi
  local i=1
  for opt in "${options[@]}"; do
    if [ $i -eq $default_idx ]; then
      printf "  %d) %s [default]\n" "$i" "$opt" >&2
    else
      printf "  %d) %s\n" "$i" "$opt" >&2
    fi
    i=$((i+1))
  done
  printf "\n" >&2
  local sel=""
  printf "Enter choice [1-%d]: " "$count" >&2
  if [ "$timeout" -gt 0 ]; then
    if read -r -t "$timeout" sel; then :; else sel=""; fi
  else
    read -r sel || true
  fi
  if ! [[ "$sel" =~ ^[0-9]+$ ]]; then sel="$default_idx"; fi
  if [ "$sel" -lt 1 ] || [ "$sel" -gt "$count" ]; then sel="$default_idx"; fi
  local val="${options[$((sel-1))]}"
  echo "$sel:$val"
}

ui_choice() {
  # args: title, default_value, options... -> echoes selected value
  local title="$1"
  local default_val="$2"
  shift 2 || true
  local options=("$@")
  local default_idx=1
  local idx=1
  for opt in "${options[@]}"; do
    if [ "$opt" = "$default_val" ]; then default_idx=$idx; break; fi
    idx=$((idx+1))
  done
  local res
  res=$(ui_prompt_menu "$title" "$default_idx" 0 "${options[@]}")
  echo "${res#*:}"
}

ui_prompt_password() {
  # args: prompt -> echoes password (silent input)
  local prompt="$1"
  printf "%s: " "$prompt" >&2
  local pw=""
  IFS= read -r -s pw || true
  printf "\n" >&2
  echo "$pw"
}

ui_timed_interactive_prompt() {
  # args: seconds -> returns 0 if user wants interactive, 1 otherwise
  local seconds=${1:-10}
  ui_title "K4All Installer"
  ui_msg "Press I to start INTERACTIVE setup."
  ui_msg "Continuing unattended in ${seconds}s..."
  # ui_center "Press I to start INTERACTIVE setup."
  # ui_center "Continuing unattended in ${seconds}s..."
  printf "\n> "
  local ans=""
  if read -r -t "$seconds" -n 1 ans; then
    case "$ans" in
      i|I|interactive|Interactive|INTERACTIVE) return 0 ;;
      *) return 1 ;;
    esac
  fi
  return 1
}



