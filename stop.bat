@echo off
chcp 65001 >nul
echo [image-studio] stopping backend (port 34567)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 34567 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
echo [image-studio] stopping translation server (llama-server)...
taskkill /F /IM llama-server.exe >nul 2>&1
echo [image-studio] stopping ComfyUI (python main.py)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*main.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo [image-studio] stopped.
ping -n 3 127.0.0.1 >nul
