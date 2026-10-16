@echo off
REM =====================================================================
REM  Hazard Ledger watchdog  (run by the *Watchdog scheduled task)
REM
REM  ONE file serves BOTH checkouts, because it reads the port from its own
REM  config.json instead of hardcoding it:
REM      <folder>\app\config.json  -> port 3000  (production)
REM      <folder>\dev\config.json  -> port 3100  (development)
REM
REM  Started every 5 minutes by Task Scheduler:
REM    - if something is ALREADY listening on the app port -> exit quietly
REM    - otherwise start the server IN THE FOREGROUND and stay alive,
REM      so this task instance owns (and keeps) the server process
REM
REM  Why it must stay in the foreground:
REM    Task Scheduler stops a task instance when its action returns, and a
REM    stopped instance can take its child processes down with it. Keeping
REM    run-server.bat in the foreground ties the server's lifetime to this
REM    instance, which is exactly what we want.
REM
REM  NOTE: keep this file ASCII-only and CRLF-terminated.
REM =====================================================================
setlocal
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"
if "%APPDIR:~-1%"==":" set "APPDIR=%APPDIR%\"
set "LOG=%APPDIR%\watchdog.log"
cd /d "%APPDIR%"

REM Resolve node with the same rule run-server.bat uses.
set "NODE_EXE=D:\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

REM Read the port from THIS folder's config.json, so the port is never
REM duplicated in a second place and can never drift out of sync.
set "PORT="
"%NODE_EXE%" -e "console.log(require('./config.json').port)" > "%TEMP%\_hl_wd_port.txt" 2>nul
if exist "%TEMP%\_hl_wd_port.txt" set /p PORT=<"%TEMP%\_hl_wd_port.txt"
del "%TEMP%\_hl_wd_port.txt" >nul 2>&1
if not defined PORT set "PORT=3000"

set "LISTENING="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do set "LISTENING=%%p"

if defined LISTENING (
  REM Server is up - nothing to do. Stay quiet to keep the log small.
  exit /b 0
)

REM Locale-neutral timestamp: %date% embeds the weekday in the system
REM language, which would write non-ASCII bytes into the log.
set "TS="
for /f "delims=" %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH:mm:ss" 2^>nul') do set "TS=%%t"
if not defined TS set "TS=unknown-time"

echo [%TS%] port %PORT% was NOT listening - starting the server >> "%LOG%"
call "%APPDIR%\run-server.bat"
set "TS2="
for /f "delims=" %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH:mm:ss" 2^>nul') do set "TS2=%%t"
if not defined TS2 set "TS2=unknown-time"
echo [%TS2%] server process exited >> "%LOG%"
exit /b 0
