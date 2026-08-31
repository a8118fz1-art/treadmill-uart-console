@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  履帶跑步機 UART 工程上控台
echo  http://localhost:8080
echo  (Ctrl+C 結束)
echo.
start "" http://localhost:8080
python -m http.server 8080
