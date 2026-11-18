@echo off
cd /d "%~dp0"
python -m uvicorn main:app --app-dir server --host 127.0.0.1 --port 17865
pause
