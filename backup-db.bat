@echo off
REM =====================================================================
REM  Daily backup of the hazard_ledger PostgreSQL database.
REM  Keeps the newest 14 backups; older ones are deleted.
REM =====================================================================
setlocal
REM 切到脚本所在目录：保证下面的相对路径 config.json 一定能找到
REM （计划任务的工作目录不确定，必须显式 cd）
cd /d "%~dp0"

set "DIR=D:\hazard-ledger-lan\backup"
set "LOG=D:\hazard-ledger-lan\backup.log"
set "PGBIN=D:\PostgreSQL\pgsql\bin"

REM node 可执行文件：优先用已知绝对路径，找不到再退回 PATH 中的 node
set "NODEEXE=D:\nodejs\node.exe"
if not exist "%NODEEXE%" set "NODEEXE=node"

if not exist "%DIR%" mkdir "%DIR%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%i"

REM 数据库口令从 config.json 读取（不写死在脚本里，避免口令随代码外泄）
for /f "delims=" %%p in ('"%NODEEXE%" -e "process.stdout.write(require('./config.json').db.password||'')" 2^>nul') do set "PGPASSWORD=%%p"
if "%PGPASSWORD%"=="" (
  echo [%date% %time%] ERROR: 无法从 config.json 读取数据库口令 >> "%LOG%"
  echo 无法从 config.json 读取数据库口令，请检查该文件是否存在及 db.password 是否已填写。
  exit /b 1
)
"%PGBIN%\pg_dump.exe" -U postgres -h 127.0.0.1 -p 5432 -d hazard_ledger -f "%DIR%\hazard_%STAMP%.sql" >> "%LOG%" 2>&1
set "RC=%errorlevel%"
set "PGPASSWORD="

echo [%date% %time%] rc=%RC% file=hazard_%STAMP%.sql >> "%LOG%"

REM keep newest 14, delete the rest
for /f "skip=14 delims=" %%f in ('dir /b /o-d "%DIR%\hazard_*.sql" 2^>nul') do del /q "%DIR%\%%f"

endlocal
