@echo off
chcp 65001 >nul
REM =====================================================================
REM  查看「有哪些提交还没推送到 GitHub」
REM  本项目不自动推送：先本地提交 → 开代理 → 再手动推送
REM =====================================================================
setlocal
cd /d "%~dp0"

set "GIT=D:\Git\cmd\git.exe"
if not exist "%GIT%" set "GIT=git"

REM 清掉环境里的代理变量，避免沙箱/系统代理干扰判断
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="

echo ======================================================
echo   待推送检查
echo ======================================================
echo.

"%GIT%" fetch origin main >nul 2>&1
set "FETCH_OK=%errorlevel%"

if not "%FETCH_OK%"=="0" (
  echo   [注意] 连不上 GitHub，无法比对远端。
  echo          这不影响下面看「本地提交」清单。
  echo.
)

echo   ── 尚未推送的提交 ──
"%GIT%" log --oneline origin/main..HEAD 2>nul
if errorlevel 1 (
  echo   ^(无法读取远端分支，下面列出最近 10 次本地提交供参考^)
  "%GIT%" log --oneline -10
)

echo.
echo   ── 本地工作区状态 ──
"%GIT%" status --short
echo     ^(上面为空 = 改动都已提交^)

echo.
echo   ── 推送命令（先把代理打开，再执行）──
echo     "%GIT%" -c http.https://github.com.proxy= -c http.proxy= push origin main
echo.
echo ======================================================
pause
endlocal
