@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Собирает Volna.exe и установщик dist\Volna-Setup-<версия>.exe для друзей.

call build_exe.bat nopause
if not exist "dist\Volna\Volna.exe" goto :fail

for /f "tokens=2 delims==" %%V in ('findstr /b "__version__" volna\__init__.py') do set VER=%%~V
set VER=%VER: =%
set VER=%VER:"=%

set ISCC="%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist %ISCC% set ISCC="%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist %ISCC% (
    echo Ставлю Inno Setup — программу для сборки установщиков...
    winget install -e --id JRSoftware.InnoSetup --scope user --accept-package-agreements --accept-source-agreements
)
if not exist %ISCC% set ISCC="%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist %ISCC% (
    echo Не нашёл Inno Setup. Поставь его с jrsoftware.org/isdl.php и запусти снова.
    pause
    exit /b 1
)

echo Собираю установщик Volna %VER%...
%ISCC% /Q /DAppVersion=%VER% installer.iss || goto :fail
echo.
echo Готово: dist\Volna-Setup-%VER%.exe
echo Отправь этот файл друзьям. Чтобы обновления приходили сами — выложи его в релиз на GitHub
echo (инструкция в README, раздел «Обновления»).
explorer dist
pause
exit /b 0

:fail
echo.
echo Не получилось собрать установщик — пришли скриншот этого окна.
pause
exit /b 1
