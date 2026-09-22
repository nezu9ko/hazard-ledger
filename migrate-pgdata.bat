@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM =====================================================================
REM  Migrate the PostgreSQL DATA directory into the hazard project.
REM    OLD: D:\PostgreSQL\data
REM    NEW: D:\hazard-ledger-lan\pgdata
REM  Binaries stay at D:\PostgreSQL\pgsql (unchanged).
REM  The Windows service IS re-registered to point at the new data dir.
REM  On any failure it automatically rolls back.
REM  MUST be run as Administrator.
REM =====================================================================

set "OLD_DATA=D:\PostgreSQL\data"
set "NEW_DATA=D:\hazard-ledger-lan\pgdata"
set "PGBIN=D:\PostgreSQL\pgsql\bin"
set "PGLOG=D:\PostgreSQL\logs\pg-service.log"
set "PGSVC=PostgreSQL-17"
set "APPTASK=HazardLedger"
set "APPDIR=D:\hazard-ledger-lan"
set "LOG=%APPDIR%\migrate-pgdata.log"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Not running as Administrator.
  if not "%1"=="nopause" pause
  exit /b 1
)

echo ==== migrate pgdata ==== > "%LOG%"
echo time: %date% %time% >> "%LOG%"

echo [1/8] Backup database first >> "%LOG%"
call "%APPDIR%\backup-db.bat" >> "%LOG%" 2>&1
echo   backup rc=!errorlevel! >> "%LOG%"

echo [2/8] Stop app (task + process on port 3000) >> "%LOG%"
schtasks /End /TN "%APPTASK%" >> "%LOG%" 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo   kill PID %%p >> "%LOG%"
  taskkill /F /T /PID %%p >> "%LOG%" 2>&1
)

echo [3/8] Stop PostgreSQL service >> "%LOG%"
net stop "%PGSVC%" >> "%LOG%" 2>&1
timeout /t 4 /nobreak >nul

echo [4/8] Verify data dir not in use, then move >> "%LOG%"
if not exist "%OLD_DATA%" ( echo   ERROR: old data dir missing >> "%LOG%" & goto :fail )
if exist "%NEW_DATA%" ( echo   ERROR: target already exists >> "%LOG%" & goto :fail )
move "%OLD_DATA%" "%NEW_DATA%" >> "%LOG%" 2>&1
if errorlevel 1 ( echo   ERROR: move failed >> "%LOG%" & goto :fail )
echo   moved OK >> "%LOG%"

echo [5/8] Re-register service with new data dir >> "%LOG%"
"%PGBIN%\pg_ctl.exe" unregister -N "%PGSVC%" >> "%LOG%" 2>&1
"%PGBIN%\pg_ctl.exe" register -N "%PGSVC%" -D "%NEW_DATA%" -S auto -l "%PGLOG%" -o "-p 5432" >> "%LOG%" 2>&1
if errorlevel 1 ( echo   ERROR: register failed >> "%LOG%" & goto :fail )
echo   registered OK >> "%LOG%"

echo [6/8] Start PostgreSQL service >> "%LOG%"
net start "%PGSVC%" >> "%LOG%" 2>&1
timeout /t 4 /nobreak >nul

  echo [7/8] Verify database connectivity >> "%LOG%"
  REM 数据库口令从 config.json 读取（不写死在脚本里；cd 到脚本目录保证能找到配置）
  cd /d "%~dp0"
  set "NODEEXE=D:\nodejs\node.exe"
  if not exist "!NODEEXE!" set "NODEEXE=node"
  for /f "delims=" %%p in ('"!NODEEXE!" -e "process.stdout.write(require('./config.json').db.password||'')" 2^>nul') do set "PGPASSWORD=%%p"
  if "!PGPASSWORD!"=="" ( echo   ERROR: cannot read db password from config.json >> "%LOG%" & goto :fail )
  "%PGBIN%\psql.exe" -U postgres -h 127.0.0.1 -p 5432 -d hazard_ledger -tAc "select 'DB_OK:'||count(*)||' hazards' from hazard" >> "%LOG%" 2>&1
  set "RC_VERIFY=!errorlevel!"
  set "PGPASSWORD="
if not "%RC_VERIFY%"=="0" ( echo   ERROR: verify failed >> "%LOG%" & goto :fail )

echo [8/8] Update helper scripts + restart app >> "%LOG%"
call :patch_scripts
schtasks /Run /TN "%APPTASK%" >> "%LOG%" 2>&1

echo ---- >> "%LOG%"
echo RESULT=SUCCESS >> "%LOG%"
echo   new data dir: %NEW_DATA% >> "%LOG%"
goto :done

:patch_scripts
echo   patching D:\PostgreSQL\*.bat >> "%LOG%"
powershell -NoProfile -Command "Get-ChildItem 'D:\PostgreSQL\*.bat' | ForEach-Object { $c = Get-Content -Raw $_.FullName; $c = $c -replace [regex]::Escape('D:\PostgreSQL\data'), 'D:\hazard-ledger-lan\pgdata'; Set-Content -NoNewline -Encoding ascii $_.FullName $c }" >> "%LOG%" 2>&1
exit /b 0

:fail
echo RESULT=FAILED - rolling back >> "%LOG%"
if exist "%NEW_DATA%" (
  if not exist "%OLD_DATA%" (
    move "%NEW_DATA%" "%OLD_DATA%" >> "%LOG%" 2>&1
    echo   data dir moved back >> "%LOG%"
  )
)
"%PGBIN%\pg_ctl.exe" unregister -N "%PGSVC%" >> "%LOG%" 2>&1
"%PGBIN%\pg_ctl.exe" register -N "%PGSVC%" -D "%OLD_DATA%" -S auto -l "%PGLOG%" -o "-p 5432" >> "%LOG%" 2>&1
net start "%PGSVC%" >> "%LOG%" 2>&1
schtasks /Run /TN "%APPTASK%" >> "%LOG%" 2>&1
echo ROLLBACK_DONE >> "%LOG%"

:done
echo ---- final state ---- >> "%LOG%"
if exist "%NEW_DATA%" (echo NEW_DATA_EXISTS=yes >> "%LOG%") else (echo NEW_DATA_EXISTS=no >> "%LOG%")
if exist "%OLD_DATA%" (echo OLD_DATA_EXISTS=yes >> "%LOG%") else (echo OLD_DATA_EXISTS=no >> "%LOG%")
"%PGBIN%\pg_ctl.exe" status -D "%NEW_DATA%" >> "%LOG%" 2>&1
if not "%1"=="nopause" ( echo Done. See %LOG% & pause )
endlocal
