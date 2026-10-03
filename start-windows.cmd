@echo off
rem Dvojklik = instalace a spusteni BELETA AI SALES na Windows
if not exist "%~dp0scripts\setup-windows.ps1" (
  echo.
  echo CHYBA: nenalezena slozka "scripts". Pravdepodobne jste soubor spustil primo z ZIPu.
  echo Reseni: ZIP nejdriv ROZBALTE - pravym tlacitkem na ZIP, "Extrahovat vse...",
  echo pak otevrete rozbalenou slozku a spustte start-windows.cmd odtud.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1"
pause
