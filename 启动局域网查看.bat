@echo off
chcp 65001 >nul
REM 局域网只读模式：同一办公网内的手机/电脑可查看看板，不能修改数据
cd /d "%~dp0"
call "%~dp0启动工作台.bat" --lan
