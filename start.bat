@echo off
cd /d "%~dp0"
echo ============================================
echo  chat-local - local chat
echo  Web: http://127.0.0.1:17865
echo ============================================
start "chat-local server" "%~dp0run_server.bat"
timeout /t 2 >nul
start "" http://127.0.0.1:17865/
