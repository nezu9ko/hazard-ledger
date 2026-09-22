@echo off
chcp 65001 >nul
title 环境体检 — 隐患治理台账系统
cd /d "%~dp0"

set "NODE_EXE=D:\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" "%~dp0tools\check-env.js"

echo.
echo 按任意键关闭本窗口...
pause >nul
