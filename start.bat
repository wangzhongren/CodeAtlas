@echo off
title CodeAtlas

set BACKEND_DIR=%~dp0backend
set FRONTEND_DIR=%~dp0frontend
set PORT=19850

echo ============================================
echo   CodeAtlas Electron App
echo ============================================
echo.

echo Starting backend on port %PORT%...

:: Kill old process on port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING" 2^>nul') do (
    taskkill //F //PID %%a 2>nul
)
timeout /t 1 /nobreak >nul

start "CodeAtlas-Backend" cmd /k "cd /d %BACKEND_DIR% && python -m uvicorn main:app --port %PORT%"

timeout /t 3 /nobreak >nul

echo Starting Electron app...
cd /d %FRONTEND_DIR%
npm run electron:dev
