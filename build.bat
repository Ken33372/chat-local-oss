@echo off
cd /d "%~dp0web"
call npm install
if errorlevel 1 goto fail
call npm run build
if errorlevel 1 goto fail
echo Build finished: web\dist
pause
exit /b 0
:fail
echo Build failed
pause
exit /b 1
