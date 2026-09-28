@echo off
chcp 65001 >nul
REM =====================================================================
REM  One-time helper: connect this folder to a GitHub repository.
REM
REM  NOTE: keep this file PURE ASCII. cmd.exe may split multi-byte chars
REM  in .bat files and report them as "not recognized as an internal or
REM  external command". All Chinese guidance lives in tools\remote-setup.js
REM
REM  This project's remote is ALREADY configured as SSH
REM  (git@github.com:nezu9ko/hazard-ledger.git), so this script only
REM  reports that and exits -- pass "force" to actually change it.
REM =====================================================================
setlocal
cd /d "%~dp0"

set "NODE_EXE=D:\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" "%~dp0tools\remote-setup.js" %1
echo.
set "SKIP="
if /i "%1"=="nopause" set "SKIP=1"
if /i "%2"=="nopause" set "SKIP=1"
if not defined SKIP pause
endlocal
