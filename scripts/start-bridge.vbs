' start-bridge.vbs - hidden launcher for the claude-remote bridge daemon.
' A copy lives in shell:startup so the bridge comes up at logon, windowless.
' If the port is already taken, the bridge exits on its own (EADDRINUSE guard)
' so double starts are harmless. Edit NODE/BASE below if paths change.
Dim sh, NODE, BASE
Set sh = CreateObject("WScript.Shell")
NODE = "C:\Users\Administrator\AppData\Local\hermes\node\node.exe"
BASE = "D:\dev_workspaces\claude-remote\bridge\index.js"
sh.Run """" & NODE & """ """ & BASE & """", 0, False
