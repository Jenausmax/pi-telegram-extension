#!/usr/bin/env bash
# Цикл-обёртка: запускает pi (TUI) и перезапускает его по намерению из control-файла.
# /new и /resume в extension'е пишут намерение и зовут ctx.shutdown() → pi выходит → новый запуск.
set -u

SESSION_DIR="${PI_SESSION_DIR:-$HOME/.pi/agent/sessions}"
CONTROL_FILE="${PI_TG_CONTROL_FILE:-$HOME/.pi/agent/telegram-bridge-relaunch}"
PI_BIN="${PI_BIN:-pi}"

mkdir -p "$SESSION_DIR"
mkdir -p "$(dirname "$CONTROL_FILE")"
: > "$CONTROL_FILE"   # очистить стартовое намерение

while true; do
  intent="$(cat "$CONTROL_FILE" 2>/dev/null || true)"
  : > "$CONTROL_FILE"

  case "$intent" in
    quit)
      echo "pi-telegram: получено 'quit', выходим"
      break
      ;;
    ""|new)
      "$PI_BIN" --session-dir "$SESSION_DIR"
      ;;
    *)
      "$PI_BIN" --session "$intent" --session-dir "$SESSION_DIR"
      ;;
  esac

  sleep 1   # страховка от плотного crash-loop
done
