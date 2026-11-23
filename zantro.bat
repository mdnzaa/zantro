@echo off
title Zantro Launcher
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERREUR] Node.js n'est pas installe. Telechargez-le sur https://nodejs.org/
    pause
    exit /b
)
if not exist "node_modules" (
    echo Installation automatique des dependances de Zantro...
    call npm install
)
echo Lancement de Zantro...
call npm start