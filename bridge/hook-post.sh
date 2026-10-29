#!/bin/sh
# hook-post.sh - Claude Code hook -> bridge POST (POSIX twin of
# hook-post.cmd). Usage (from ~/.claude/settings.json hooks):
#   hook-post.sh <event> <token>
# The hook JSON payload arrives on stdin and is forwarded as the body.
# Port is fixed here (same convention as hook-post.cmd); change both together.
curl -s --max-time 10 --connect-timeout 3 -X POST -H "Content-Type: application/json" --data-binary @- "http://localhost:3742/hooks/$1?token=$2"
