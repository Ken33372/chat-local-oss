@echo off
echo Stopping chat-local server on port 17865...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":17865" ^| findstr "LISTENING"') do taskkill /PID %%p /F
echo Done.
pause
