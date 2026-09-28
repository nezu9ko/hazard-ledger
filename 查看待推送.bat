@echo off
chcp 65001 >nul
REM =====================================================================
REM  Show which commits have NOT been pushed to GitHub yet.
REM  All Chinese output comes from tools\check-pending.js -- do NOT put
REM  non-ASCII text in this file: cmd.exe may split multi-byte chars and
REM  report them as "not recognized as an internal or external command".
REM  This project does NOT auto-push. Turn on the proxy before pushing.
REM =====================================================================
setlocal
cd /d "%~dp0"

set "NODE_EXE=D:\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

REM Clear proxy env vars so sandbox/system proxy does not confuse the check
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="

"%NODE_EXE%" "%~dp0tools\check-pending.js"
echo.
if not "%1"=="nopause" pause
endlocal
