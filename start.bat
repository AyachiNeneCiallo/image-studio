@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "NODE_EXE=%ROOT%node\node.exe"
set "SERVER_JS=%ROOT%server\index.js"

if not exist "%NODE_EXE%" goto setup
if not exist "%ROOT%ComfyUI\python_embeded\python.exe" goto setup
if not exist "%ROOT%bin\llama-server.exe" goto setup
goto run

:setup
echo [image-studio] first run: downloading runtime and models...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%setup.ps1"
if errorlevel 1 (
  echo [ERROR] setup failed. Fix the error above and run start.bat again.
  pause
  exit /b 1
)

:run
cd /d "%ROOT%"

"%NODE_EXE%" -e "fetch('http://127.0.0.1:34567/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
if not errorlevel 1 (
  echo [image-studio] backend already running
  start "" "http://127.0.0.1:34567"
  goto tail
)

echo [image-studio] starting backend...
start /b "" "%NODE_EXE%" "%SERVER_JS%"

set /a TRY=0
:wait
"%NODE_EXE%" -e "fetch('http://127.0.0.1:34567/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
if not errorlevel 1 goto ready
set /a TRY+=1
if %TRY% GEQ 60 goto timeout
ping -n 2 127.0.0.1 >nul
goto wait

:ready
echo [image-studio] backend ready
start "" "http://127.0.0.1:34567"
goto tail

:timeout
echo [WARN] backend did not respond in time. Open http://127.0.0.1:34567 manually.

:tail
echo.
echo [image-studio] running. Keep this window open; closing it stops the service.
pause >nul
