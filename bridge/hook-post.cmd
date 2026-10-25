@echo off
rem hook-post.cmd - Claude Code hook -> bridge POST (shell-agnostic wrapper).
rem Claude Code may execute hook commands via PowerShell on Windows, where
rem curl's "--data-binary @-" breaks ("@-" is splatting syntax). A .cmd file
rem always runs under cmd.exe, so the curl line below is parsed correctly.
rem Usage (from ~/.claude/settings.json hooks): hook-post.cmd <event> <token>
rem The hook JSON payload arrives on stdin and is forwarded as the body.
curl.exe -s -X POST -H "Content-Type: application/json" --data-binary @- "http://localhost:3742/hooks/%1?token=%2"
