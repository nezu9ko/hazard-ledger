@echo off
chcp 65001 >nul
title 推送代码到 GitHub
setlocal
cd /d "%~dp0"

echo ============================================================
echo            推送「隐患治理台账系统」到 GitHub
echo ============================================================
echo.
echo  使用前请先在 GitHub 网页上创建一个【空仓库】：
echo    - 不要勾选 "Add a README file"
echo    - 不要勾选 .gitignore / license
echo  创建后复制它的地址（形如 https://github.com/你的用户名/hazard-ledger.git）
echo.
echo  ------------------------------------------------------------
echo.

set "REPO_URL="
set /p REPO_URL=请粘贴仓库地址后回车: 
if "%REPO_URL%"=="" (
  echo.
  echo [已取消] 未输入地址。
  pause
  exit /b 1
)

REM 校验地址格式
echo %REPO_URL% | findstr /i "^https://github.com/" >nul
if errorlevel 1 (
  echo.
  echo [错误] 地址必须以 https://github.com/ 开头，请重新运行本脚本。
  pause
  exit /b 1
)

echo.
echo [1/3] 设置远端仓库...
git remote remove origin >nul 2>&1
git remote add origin "%REPO_URL%"
if errorlevel 1 ( echo [失败] 设置远端出错。 & pause & exit /b 1 )
echo       已设置为: %REPO_URL%

echo.
echo [2/3] 确认本地提交...
git log --oneline -3

echo.
echo [3/3] 开始推送...
echo.
echo   ★ 首次推送会弹出浏览器，要求登录 GitHub 并授权，请点「Authorize」。
echo     授权后 Git 会记住凭据，以后不用再登录。
echo.
git push -u origin main
if errorlevel 1 (
  echo.
  echo ============================================================
  echo  [推送失败] 常见原因：
  echo    1) 仓库地址写错（注意结尾的 .git）
  echo    2) GitHub 上已有同名文件（请确认建的是空仓库）
  echo    3) 系统代理未开启 —— GitHub 需要代理才能访问
  echo    4) 浏览器授权窗口被关闭/拒绝
  echo  把上面的英文错误信息截图发给维护人员即可。
  echo ============================================================
) else (
  echo.
  echo ============================================================
  echo  ✅ 推送成功！现在可以在 GitHub 网页上看到全部代码了。
  echo     以后每次改完代码，运行本脚本即可同步（或直接 git push）。
  echo ============================================================
)
echo.
pause
endlocal
