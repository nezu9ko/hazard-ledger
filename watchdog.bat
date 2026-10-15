@echo off
REM =====================================================================
REM  Hazard Ledger watchdog  (run by the HazardLedgerWatchdog task)
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
REM  Requires no administrator rights (the task itself runs as SYSTEM).
REM  NOTE: keep this file ASCII-only and CRLF-terminated.
REM =====================================================================
setlocal
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"
if "%APPDIR:~-1%"==":" set "APPDIR=%APPDIR%\"
set "PORT=3000"
set "LOG=%APPDIR%\watchdog.log"

set "LISTENING="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do set "LISTENING=%%p"

if defined LISTENING (
  REM Server is up - nothing to do. Stay quiet to keep the log small.
  exit /b 0
)

echo [%date% %time%] port %PORT% was NOT listening - starting the server >> "%LOG%"
call "%APPDIR%\run-server.bat"
echo [%date% %time%] server process exited >> "%LOG%"
exit /b 0
