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
REM ★ 不写死盘符路径：用脚本自身所在目录（%~dp0 末尾带反斜杠，故去掉）
REM   这样项目整体换位置时，这个脚本一行都不用改。
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"
if "%APPDIR:~-1%"==":" set "APPDIR=%APPDIR%\"
set "RUNNER=%APPDIR%\run-server.bat"
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
  echo         This script only operates on the production copy
  echo         (the one that owns pgdata and port 3000).
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

echo [3/4] Create scheduled task (start at boot, run as SYSTEM) >> "%LOG%"
schtasks /Create /TN "%TASK%" /TR "\"%RUNNER%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /DELAY 0000:30 /F >> "%LOG%" 2>&1
set "RC_TASK=%errorlevel%"

echo [4/4] Start task now >> "%LOG%"
schtasks /Run /TN "%TASK%" >> "%LOG%" 2>&1

echo ---- >> "%LOG%"
echo FW_RC=%RC_FW%  TASK_RC=%RC_TASK% >> "%LOG%"
netsh advfirewall firewall show rule name="%RULE%" >> "%LOG%" 2>&1
schtasks /Query /TN "%TASK%" /FO LIST >> "%LOG%" 2>&1

if "%RC_FW%%RC_TASK%"=="00" (echo RESULT=SUCCESS >> "%LOG%") else (echo RESULT=FAILED >> "%LOG%")

if not "%1"=="nopause" (
  echo Done. See %LOG%
  pause
)
endlocal
