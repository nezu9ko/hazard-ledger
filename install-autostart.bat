@echo off
chcp 65001 >nul
setlocal

REM =====================================================================
REM  Hazard Ledger - local deployment setup
REM    1) allow inbound TCP 3000 in Windows Firewall
REM    2) register a Scheduled Task so the server starts at boot
REM  MUST be run as Administrator.
REM =====================================================================

set "TASK=HazardLedger"
set "RULE=HazardLedger 3000"
REM Watchdog task (added 2026-10-15): checks the port every 5 minutes and
REM starts the server again when it is down.
set "WD_TASK=HazardLedgerWatchdog"
REM Do not hardcode drive paths: derive from this script's own folder
REM (%~dp0 ends with a backslash, so it is stripped below).
REM That way nothing needs editing when the project moves.
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"
if "%APPDIR:~-1%"==":" set "APPDIR=%APPDIR%\"
set "RUNNER=%APPDIR%\run-server.bat"
set "WD_RUNNER=%APPDIR%\watchdog.bat"
set "LOG=%APPDIR%\deploy-setup.log"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Not running as Administrator.
  echo         Right-click this file and choose "Run as administrator".
  if not "%1"=="nopause" pause
  exit /b 1
)

REM ---- PRODUCTION GUARD ----------------------------------------------
REM  This script registers/repairs the PRODUCTION service. Since it now
REM  derives its path from %~dp0, running it from a DEV copy would point
REM  the production task at the dev folder. Only the production checkout
REM  has pgdata (git-ignored), so use that as the identity marker.
if not exist "%APPDIR%\pgdata" (
    echo [ERROR] Refusing to run: this is NOT the production folder.
    echo         %APPDIR%\pgdata not found.
    echo         This script only operates on the production copy,
    echo         i.e. the folder that owns pgdata and port 3000.
  if not "%1"=="nopause" pause
  exit /b 1
)
REM --------------------------------------------------------------------

echo ==== deployment setup ==== > "%LOG%"
echo time: %date% %time% >> "%LOG%"

echo [1/4] Add firewall rule for TCP 3000 >> "%LOG%"
netsh advfirewall firewall delete rule name="%RULE%" >> "%LOG%" 2>&1
netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=3000 profile=any >> "%LOG%" 2>&1
set "RC_FW=%errorlevel%"

echo [2/4] Remove old scheduled task >> "%LOG%"
schtasks /Delete /TN "%TASK%" /F >> "%LOG%" 2>&1

echo [3/5] Create scheduled task (start at boot, run as SYSTEM) >> "%LOG%"
schtasks /Create /TN "%TASK%" /TR "\"%RUNNER%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /DELAY 0000:30 /F >> "%LOG%" 2>&1
set "RC_TASK=%errorlevel%"

REM ---- 2026-10-15 fix: schtasks /Create gives the task a DEFAULT 72-hour
REM execution time limit. Observed consequence: Task Scheduler TERMINATED the
REM server after exactly 3 days of uptime, and because the trigger is
REM ONSTART only, nothing ever started it again (this is how it died on
REM 10-14 08:27). Fix: set ExecutionTimeLimit to PT0S (no limit) and set
REM MultipleInstances to IgnoreNew so repeats never spawn a second copy.
echo [3b/5] Remove the default 72-hour execution limit >> "%LOG%"
powershell -NoProfile -Command "$t=Get-ScheduledTask -TaskName '%TASK%' -ErrorAction Stop; $s=$t.Settings; $s.ExecutionTimeLimit='PT0S'; $s.MultipleInstances='IgnoreNew'; [void](Set-ScheduledTask -TaskName '%TASK%' -Settings $s)" >> "%LOG%" 2>&1
set "RC_LIMIT=%errorlevel%"

REM ---- Watchdog task: checks the port every 5 minutes and starts the
REM server when it is down, so it recovers from ANY kind of death
REM (crash, accidental close, missed trigger after a power loss, ...).
echo [4/5] Install watchdog task (check port every 5 min) >> "%LOG%"
REM NOTE: do not read %errorlevel% inside an if/else block - cmd expands it
REM when the block is PARSED, so it would report a stale value. The checks
REM below therefore run at top level.
if not exist "%WD_RUNNER%" echo [WARN] "%WD_RUNNER%" not found - watchdog NOT installed >> "%LOG%"
if exist "%WD_RUNNER%" schtasks /Delete /TN "%WD_TASK%" /F >> "%LOG%" 2>&1
if exist "%WD_RUNNER%" schtasks /Create /TN "%WD_TASK%" /TR "\"%WD_RUNNER%\"" /SC MINUTE /MO 5 /RU SYSTEM /RL HIGHEST /F >> "%LOG%" 2>&1
set "RC_WD=%errorlevel%"
if exist "%WD_RUNNER%" powershell -NoProfile -Command "$t=Get-ScheduledTask -TaskName '%WD_TASK%' -ErrorAction Stop; $s=$t.Settings; $s.ExecutionTimeLimit='PT0S'; $s.MultipleInstances='IgnoreNew'; [void](Set-ScheduledTask -TaskName '%WD_TASK%' -Settings $s)" >> "%LOG%" 2>&1

echo [5/5] Start task now >> "%LOG%"
schtasks /Run /TN "%TASK%" >> "%LOG%" 2>&1

echo ---- >> "%LOG%"
echo FW_RC=%RC_FW%  TASK_RC=%RC_TASK%  LIMIT_RC=%RC_LIMIT%  WD_RC=%RC_WD% >> "%LOG%"
netsh advfirewall firewall show rule name="%RULE%" >> "%LOG%" 2>&1
schtasks /Query /TN "%TASK%" /FO LIST /V >> "%LOG%" 2>&1
schtasks /Query /TN "%WD_TASK%" /FO LIST /V >> "%LOG%" 2>&1

if "%RC_FW%%RC_TASK%%RC_LIMIT%"=="000" (echo RESULT=SUCCESS >> "%LOG%") else (echo RESULT=FAILED >> "%LOG%")

if not "%1"=="nopause" (
  echo Done. See %LOG%
  pause
)
endlocal
