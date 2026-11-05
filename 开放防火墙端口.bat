@echo off
chcp 65001 >nul
title 开放工作台端口（需要管理员权限）

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   请右键本文件，选择「以管理员身份运行」
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo     开放 8765 端口，让手机/其他电脑能访问工作台
echo   ============================================================
echo.

REM 删除可能存在的旧规则，避免重复
netsh advfirewall firewall delete rule name="安全管理数据工作台" >nul 2>&1

REM 为所有网络类型（专用/公用/域）放行 8765 端口
netsh advfirewall firewall add rule name="安全管理数据工作台" dir=in action=allow protocol=TCP localport=8765 profile=any

if errorlevel 1 (
  echo   添加失败。
  pause
  exit /b 1
)

echo.
echo   已添加规则：允许任何网络类型访问 TCP 8765 端口
echo.
echo   当前规则：
netsh advfirewall firewall show rule name="安全管理数据工作台"
echo.
echo   ============================================================
echo     下一步：
echo     1. 保持工作台服务窗口开着
echo     2. 手机连接同一个 Wi-Fi（GE_HiFi_5G）
echo     3. 手机浏览器输入：http://192.168.3.115:8765/
echo   ============================================================
echo.
pause
