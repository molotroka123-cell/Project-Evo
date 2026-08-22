#!/bin/bash
# tools/swarm-log.sh — журнал сдачи агентов, чтобы не потерять нить при обрыве.
#
# Зачем: рои идут часами, а лимиты могут кончиться в любой момент. Если это
# случится посреди работы, надо знать, кто уже сдал модуль, а кого перезапускать.
# Скрипт пишет в docs/рой_журнал.md каждые три минуты. Только дописывает,
# никогда не перезаписывает: история важнее краткости.
cd /home/user/Project-Evo || exit 1
LOG=docs/рой_журнал.md
WF=/root/.claude/projects/-home-user-Project-Evo/117dce05-3788-5c71-b0d1-656c2becb2f6/subagents/workflows

[ -f "$LOG" ] || printf '# Журнал роёв\n\nПишется автоматически раз в три минуты (tools/swarm-log.sh).\nНужен, чтобы при обрыве по лимитам было видно, кто сдал модуль, а кого перезапускать.\n' > "$LOG"

prev=""
while true; do
  now=$(date -u '+%Y-%m-%d %H:%M UTC')

  # Только ДВА текущих роя. В каталоге лежат и рои прошлых сессий — если брать
  # все подряд, строка распухает до нечитаемости и полезное в ней тонет.
  #
  # Счётчик через tr -d: grep -c при пустом файле возвращает 0 с переносом
  # строки, и в журнал попадало «сдано 0\n0» — строка ломалась пополам.
  summary=""
  for pair in "графика:wf_04e7ea21-8d9" "стада+династия:wf_594e2d1a-deb"; do
    name="${pair%%:*}"; id="${pair##*:}"
    j="$WF/$id/journal.jsonl"
    [ -f "$j" ] || { summary="${summary}${name}: журнала нет; "; continue; }
    started=$(grep -c '"type":"started"' "$j" 2>/dev/null | tr -d '\n ')
    done_n=$(grep -c '"type":"result"' "$j" 2>/dev/null | tr -d '\n ')
    summary="${summary}${name} ${done_n:-0}/${started:-0}; "
  done

  # Какие модули уже лежат в дереве
  files=""
  for f in app/src/render/select.js app/src/render/minimap.js app/src/render/icons.js \
           app/src/render/city_lights.js app/src/render/postfx.js app/src/render/damage.js \
           app/src/render/construction.js app/src/render/borders_view.js \
           app/src/render/era_transition.js app/src/render/notifications.js \
           app/src/render/herds_view.js \
           app/src/render3d/pick3d.js app/src/render3d/water3d.js \
           app/src/render3d/veg3d.js app/src/render3d/sky3d.js \
           app/src/core/systems/herds.js app/src/core/systems/link_hunt.js \
           app/src/core/systems/dynasty.js app/src/core/systems/link_dynasty.js \
           app/src/ui/panel_dynasty.js; do
    [ -f "$f" ] && files="${files}$(basename "$f" .js) "
  done
  n=$(echo $files | wc -w)

  line="$now — $summary файлов в дереве: $n [$files]"
  # Пишем только при изменении: иначе за ночь набежит триста одинаковых строк.
  if [ "$line" != "$prev" ]; then
    echo "" >> "$LOG"
    echo "- $line" >> "$LOG"
    prev="$line"
  fi
  sleep 180
done
