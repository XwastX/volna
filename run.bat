@echo off
chcp 65001 >nul
cd /d "%~dp0"

call :findpy
if not defined PY (
    echo Python не найден. Ставлю Python 3.12 через winget, это пара минут...
    winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
    call :findpy
)
if not defined PY (
    echo.
    echo Не получилось поставить Python автоматически.
    echo Скачай Python 3.12 с https://www.python.org/downloads/ и при установке отметь "Add python.exe to PATH",
    echo потом снова запусти run.bat.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Первый запуск: создаю окружение и ставлю зависимости, это займёт пару минут...
    if exist ".venv" rmdir /s /q ".venv"
    %PY% -m venv .venv || goto :fail
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
)
rem список библиотек поменялся (вышло обновление) — доустанавливаем
fc /b requirements.txt ".venv\installed.req" >nul 2>nul
if errorlevel 1 (
    echo Ставлю библиотеки для новой версии Volna...
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt || goto :fail
    copy /y requirements.txt ".venv\installed.req" >nul
)

start "" ".venv\Scripts\pythonw.exe" main.py
exit /b 0

:fail
echo.
echo Что-то пошло не так при установке — пришли скриншот этого окна.
pause
exit /b 1

:findpy
set "PY="
rem заглушка из Microsoft Store на --version возвращает ошибку, поэтому проверяем запуском
py -3 --version >nul 2>nul && (set "PY=py -3" & exit /b 0)
python --version >nul 2>nul && (set "PY=python" & exit /b 0)
for %%V in (313 312 311 310) do (
    if exist "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe" (
        set PY="%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
        exit /b 0
    )
)
exit /b 0
