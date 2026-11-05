@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PY="
if exist "%~dp0runtime\python\python.exe" set "PY=%~dp0runtime\python\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
if not defined PY (
  for %%P in (python.exe) do if not defined PY set "PY=%%~$PATH:P"
)
if not defined PY (
  echo.
  echo   未找到 Python 运行环境。
  echo   请先安装 Python 3.10 或更高版本（安装时勾选 Add Python to PATH），
  echo   然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

"%PY%" -c "import openpyxl" >nul 2>&1
if errorlevel 1 (
  echo.
  echo   正在安装依赖 openpyxl ...
  "%PY%" -m pip install openpyxl
  if errorlevel 1 (
    echo.
    echo   依赖安装失败，请检查网络或手动执行： pip install openpyxl
    pause
    exit /b 1
  )
)

REM ============================================================
REM  启动模式选择
REM  1 = 仅本机（默认，最安全）
REM  2 = 局域网只读（手机/其他电脑可查看，不能改）
REM  3 = 局域网可编辑
REM ============================================================
set "MODE=1"
if /i "%~1"=="--lan" set "MODE=2"
if /i "%~1"=="--lan-edit" set "MODE=3"

if "%MODE%"=="1" (
  title 安全管理数据工作台（仅本机）
  "%PY%" "%~dp0app\server.py"
  goto :done
)

set "ARGS=--lan"
if "%MODE%"=="3" set "ARGS=--lan --remote-edit"

REM 局域网模式：询问是否设置访问密码
echo.
echo   ============================================================
echo     局域网访问模式
echo   ============================================================
echo     启动后，同一办公网内的手机/电脑可输入地址访问。
echo     如设置密码，访问者需先输入密码才能查看。
echo.
set "PWD="
set /p "PWD=  设置访问密码（直接回车表示不设密码）："
if defined PWD (
  set "ARGS=!ARGS! --password !PWD!"
  title 安全管理数据工作台（局域网·密码保护）
) else (
  title 安全管理数据工作台（局域网）
)

"%PY%" "%~dp0app\server.py" %ARGS%

:done
if errorlevel 1 pause
endlocal
