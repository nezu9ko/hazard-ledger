@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM =====================================================================
REM  Restart the Hazard Ledger service:
REM    - stop the scheduled task
REM    - kill whatever is listening on the app port (process tree)
REM    - start the scheduled task again
REM  MUST be run as Administrator.
REM =====================================================================

set "TASK=HazardLedger"
set "PORT=3000"
REM ★ 不写死盘符路径：用脚本自身所在目录（%~dp0 末尾带反斜杠，故去掉）
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"
if "%APPDIR:~-1%"==":" set "APPDIR=%APPDIR%\"
set "LOG=%APPDIR%\restart.log"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Not running as Administrator.
  if not "%1"=="nopause" pause
  exit /b 1
)

REM ---- PRODUCTION GUARD ----------------------------------------------
REM  This script restarts the PRODUCTION service (kills whatever listens
REM  on port 3000). Only the production checkout owns pgdata (git-ignored).
if not exist "%APPDIR%\pgdata" (
  echo [ERROR] Refusing to run: this is NOT the production folder.
  echo         %APPDIR%\pgdata not found.
    echo         Use the dev launcher to restart the development server.
  if not "%1"=="nopause" pause
  exit /b 1
)
REM --------------------------------------------------------------------

echo ==== restart ==== > "%LOG%"
echo time: %date% %time% >> "%LOG%"

echo [1/3] End scheduled task >> "%LOG%"
schtasks /End /TN "%TASK%" >> "%LOG%" 2>&1

echo [2/3] Kill process listening on port %PORT% >> "%LOG%"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  echo   killing PID %%p >> "%LOG%"
  taskkill /F /T /PID %%p >> "%LOG%" 2>&1
)
timeout /t 3 /nobreak >nul

echo [3/3] Start scheduled task >> "%LOG%"
schtasks /Run /TN "%TASK%" >> "%LOG%" 2>&1
timeout /t 5 /nobreak >nul

echo ---- >> "%LOG%"
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >> "%LOG%" 2>&1
schtasks /Query /TN "%TASK%" /FO LIST >> "%LOG%" 2>&1
echo RESULT=DONE >> "%LOG%"

if not "%1"=="nopause" (
  echo Done. See %LOG%
  pause
)
endlocal
