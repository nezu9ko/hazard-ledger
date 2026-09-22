@echo off
REM =====================================================================
REM  Hazard Ledger local server launcher (for Windows Scheduled Task)
REM  Output is appended to server-out.log
REM =====================================================================
cd /d "%~dp0"

set "NODE_EXE=D:\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" server.js >> "%~dp0server-out.log" 2>&1
