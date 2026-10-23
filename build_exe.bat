@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Сборка Volna.exe, чтобы отдать друзьям (им Python не нужен).

if not exist ".venv\installed.req" (
    echo Сначала запусти run.bat один раз — он поставит всё нужное.
    if "%1"=="nopause" exit /b 1
    pause
    exit /b 1
)
set PYTHONWARNINGS=ignore
set PIP_NO_CACHE_DIR=1
set PIP_DISABLE_PIP_VERSION_CHECK=1

echo [1/3] Ставлю сборщик PyInstaller...
".venv\Scripts\python.exe" -m pip install --quiet --no-cache-dir pyinstaller 2>nul
if errorlevel 1 goto :fail

echo [2/3] Собираю Volna, это 1-3 минуты...
if exist "build" rmdir /s /q "build"
if exist "dist\Volna" rmdir /s /q "dist\Volna"
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean --log-level ERROR --windowed ^
    --name Volna --icon "volna\assets\icon.ico" ^
    --add-data "volna\web;volna\web" --add-data "volna\assets;volna\assets" ^
    --collect-submodules winrt --hidden-import pypresence --collect-submodules qrcode ^
    --hidden-import sounddevice --collect-all _sounddevice_data --collect-all av ^
    main.py
if errorlevel 1 goto :fail
if not exist "dist\Volna\Volna.exe" goto :fail

echo [3/3] Делаю ярлык на рабочем столе...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Volna.lnk')); $s.TargetPath='%CD%\dist\Volna\Volna.exe'; $s.WorkingDirectory='%CD%\dist\Volna'; $s.IconLocation='%CD%\dist\Volna\Volna.exe,0'; $s.Save()" >nul 2>&1

echo.
echo Готово! На рабочем столе появился ярлык Volna.
echo Программа лежит в папке dist\Volna. Сам Volna.exe никуда не переноси:
echo без папки _internal рядом он не запустится — пользуйся ярлыком.
echo Чтобы отдать другу, лучше собери установщик: build_installer.bat
if "%1"=="nopause" exit /b 0
explorer "dist\Volna"
pause
exit /b 0

:fail
echo.
echo Сборка не удалась. Пришли скриншот этого окна (прокрути вверх до первой ошибки).
if "%1"=="nopause" exit /b 1
pause
exit /b 1
