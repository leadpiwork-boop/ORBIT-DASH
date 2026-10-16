@echo off
title ORBIT Refresh
echo.
echo  ================================================
echo   PROJECT ORBIT -- One-Click Refresh
echo  ================================================
echo.
echo  Step 0: Backup ORBIT.html / orbit-app.js / orbit.css
echo  Step 1: Refresh Excel data model
echo  Step 2: Export DATA_EXTRACT to CSVs
echo  Step 3: Rebuild orbit-data.js  (data ONLY - app files never touched)
echo  Step 4: Verify deployment folder + integrity check
echo  Step 5: Reload ORBIT dashboard
echo.
echo  Starting... (Excel will open briefly, then close)
echo.

powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0Refresh_ORBIT.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [ERROR] Refresh failed. Check the output above.
    pause
) else (
    echo.
    echo  Refresh complete. This window will close in 5 seconds.
    timeout /t 5 /nobreak >nul
)
