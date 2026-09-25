@echo off
REM =====================================================================
REM  Daily backup of the hazard_ledger PostgreSQL database.
REM  Keeps the newest 14 backups; older ones are deleted.
REM =====================================================================
setlocal
REM 切到脚本所在目录：保证相对路径一定能找到
REM （计划任务的工作目录不确定，必须显式 cd）
cd /d "%~dp0"

set "DIR=%~dp0backup"
set "LOG=%~dp0backup.log"
set "PGBIN=D:\PostgreSQL\pgsql\bin"

REM node 可执行文件：优先用已知绝对路径，找不到再退回 PATH 中的 node
set "NODEEXE=D:\nodejs\node.exe"
if not exist "%NODEEXE%" set "NODEEXE=node"

if not exist "%DIR%" mkdir "%DIR%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%i"
REM 日志时间戳用 ISO 格式且全 ASCII —— cmd 默认以本地代码页（GBK）写文件，
REM 若写入中文时间/提示，其他工具按 UTF-8 读取会显示乱码。
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH:mm:ss"') do set "TS=%%i"

REM 数据库口令从 config.json 读取（不写死在脚本里，避免口令随代码外泄）
REM ⚠️ 这里**刻意不用 for /f** 去承接命令输出：
REM    cmd 的 for /f ('命令') 用单引号作分隔符，且对多段引号解析不可靠，
REM    内联 node -e "..." 或 '"exe" "arg"' 都会被截断，导致口令读不到。
REM    改为「node 写入临时文件 → set /p 读取」，彻底绕开引号解析问题。
set "PWTMP=%TEMP%\_hl_dbpw.tmp"
"%NODEEXE%" "%~dp0tools\get-db-password.js" > "%PWTMP%" 2>nul
set /p PGPASSWORD=<"%PWTMP%"
del /q "%PWTMP%" >nul 2>&1

if "%PGPASSWORD%"=="" (
  echo [%TS%] ERROR: cannot read db password from config.json - backup aborted >> "%LOG%"
  echo.
  echo [备份失败] 无法从 config.json 读取数据库口令。
  echo   请检查：%~dp0config.json 是否存在、db.password 是否已填写。
  echo   手动验证： "%NODEEXE%" "%~dp0tools\get-db-password.js"
  echo.
  exit /b 1
)

"%PGBIN%\pg_dump.exe" -U postgres -h 127.0.0.1 -p 5432 -d hazard_ledger -f "%DIR%\hazard_%STAMP%.sql" >> "%LOG%" 2>&1
set "RC=%errorlevel%"
set "PGPASSWORD="

if not "%RC%"=="0" (
  echo [%TS%] ERROR: pg_dump rc=%RC% file=hazard_%STAMP%.sql >> "%LOG%"
  echo [备份失败] pg_dump 退出码 %RC%，详见 %LOG%
  exit /b %RC%
)
echo [%TS%] rc=0 file=hazard_%STAMP%.sql >> "%LOG%"

REM keep newest 14, delete the rest
for /f "skip=14 delims=" %%f in ('dir /b /o-d "%DIR%\hazard_*.sql" 2^>nul') do del /q "%DIR%\%%f"

endlocal
