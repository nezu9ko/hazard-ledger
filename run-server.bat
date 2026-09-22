@echo off
REM =====================================================================
REM  Hazard Ledger local server launcher (for Windows Scheduled Task)
REM  Output is appended to server-out.log, with size-based rotation.
REM =====================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NODE_EXE=D:\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

REM ---------- 日志轮转 ----------
REM server-out.log 超过 5MB 就归档到 logs\server-out_<时间戳>.log，只保留最近 5 个。
REM 必须赶在启动 node 之前做：node 一旦运行就占住该文件，Windows 下无法改名。
set "LOGFILE=%~dp0server-out.log"
set "LOGDIR=%~dp0logs"
set "MAXBYTES=5242880"

set "LOGSIZE=0"
if exist "%LOGFILE%" for %%A in ("%LOGFILE%") do set "LOGSIZE=%%~zA"

if %LOGSIZE% GTR %MAXBYTES% (
  if not exist "%LOGDIR%" mkdir "%LOGDIR%"
  for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%d"
  move /y "%LOGFILE%" "%LOGDIR%\server-out_!STAMP!.log" >nul 2>&1
  for /f "skip=5 delims=" %%f in ('dir /b /o-d "%LOGDIR%\server-out_*.log" 2^>nul') do del /q "%LOGDIR%\%%f" >nul 2>&1
)

"%NODE_EXE%" server.js >> "%~dp0server-out.log" 2>&1
