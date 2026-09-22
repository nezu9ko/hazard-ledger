@echo off
chcp 65001 >nul
setlocal

REM =====================================================================
REM  Finalize local deployment:
REM    1) restart the app service task (to load updated server.js)
REM    2) register the daily database backup task
REM  MUST be run as Administrator.
REM =====================================================================

set "APP_TASK=HazardLedger"
set "BAK_TASK=HazardLedgerBackup"
set "APPDIR=D:\hazard-ledger-lan"
set "LOG=%APPDIR%\finalize.log"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Not running as Administrator.
  if not "%1"=="nopause" pause
  exit /b 1
)

echo ==== finalize deployment ==== > "%LOG%"
echo time: %date% %time% >> "%LOG%"

echo [1/3] Restart app task >> "%LOG%"
schtasks /End /TN "%APP_TASK%" >> "%LOG%" 2>&1
timeout /t 3 /nobreak >nul
schtasks /Run /TN "%APP_TASK%" >> "%LOG%" 2>&1

echo [2/3] Register daily backup task (02:00) >> "%LOG%"
schtasks /Delete /TN "%BAK_TASK%" /F >> "%LOG%" 2>&1
schtasks /Create /TN "%BAK_TASK%" /TR "\"%APPDIR%\backup-db.bat\"" /SC DAILY /ST 02:00 /RU SYSTEM /RL HIGHEST /F >> "%LOG%" 2>&1
set "RC_BAK=%errorlevel%"

echo [3/3] Run one backup now >> "%LOG%"
schtasks /Run /TN "%BAK_TASK%" >> "%LOG%" 2>&1

echo ---- >> "%LOG%"
echo BAK_RC=%RC_BAK% >> "%LOG%"
schtasks /Query /TN "%APP_TASK%" /FO LIST >> "%LOG%" 2>&1
schtasks /Query /TN "%BAK_TASK%" /FO LIST >> "%LOG%" 2>&1

if "%RC_BAK%"=="0" (echo RESULT=SUCCESS >> "%LOG%") else (echo RESULT=FAILED >> "%LOG%")

if not "%1"=="nopause" (
  echo Done. See %LOG%
  pause
)
endlocal
