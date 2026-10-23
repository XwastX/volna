@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0mobile"
rem Сборка Volna для Android (APK). Первый запуск ставит Node.js, Java 17 и Android SDK (~2-3 ГБ), потом всё быстро.

echo [1/6] Node.js...
where node >nul 2>nul
if errorlevel 1 (
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
where node >nul 2>nul
if errorlevel 1 goto :restart

echo [2/6] Java 17...
call :find_jdk
if not defined JAVA_HOME (
    winget install -e --id Microsoft.OpenJDK.17 --accept-source-agreements --accept-package-agreements
    call :find_jdk
)
if not defined JAVA_HOME (
    echo Не нашёл Java 17. Поставь Microsoft OpenJDK 17 и запусти скрипт снова.
    goto :fail
)
set "PATH=%JAVA_HOME%\bin;%PATH%"

echo [3/6] Android SDK...
if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "SDKM=%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat"
if not exist "%SDKM%" (
    echo     Скачиваю инструменты Android...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $z=Join-Path $env:TEMP 'volna-cmdtools.zip'; Invoke-WebRequest 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' -OutFile $z; $d=Join-Path $env:TEMP 'volna-cmdtools'; if (Test-Path $d) { Remove-Item $d -Recurse -Force }; Expand-Archive $z $d; $t=Join-Path $env:ANDROID_HOME 'cmdline-tools\latest'; New-Item -ItemType Directory -Force (Split-Path $t) | Out-Null; if (Test-Path $t) { Remove-Item $t -Recurse -Force }; Move-Item (Join-Path $d 'cmdline-tools') $t"
)
if not exist "%SDKM%" (
    echo Не удалось скачать Android SDK. Проверь интернет.
    goto :fail
)
if not exist "%ANDROID_HOME%\platforms\android-34" (
    echo     Принимаю лицензии и ставлю платформу Android 14...
    (for /l %%i in (1,1,30) do @echo y) | "%SDKM%" --licenses >nul 2>nul
    call "%SDKM%" "platform-tools" "platforms;android-34" "build-tools;34.0.0"
    if errorlevel 1 goto :fail
)

echo [4/6] Библиотеки приложения...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto :fail

echo [5/6] Проект Android...
call node scripts\prepare.mjs
if errorlevel 1 goto :fail
if not exist "android" (
    call npx cap add android
    if errorlevel 1 goto :fail
)
call npx cap sync android
if errorlevel 1 goto :fail
call node scripts\patch-android.mjs
if errorlevel 1 goto :fail
> android\local.properties echo sdk.dir=%ANDROID_HOME:\=\\%

echo [6/6] Собираю APK, первый раз 5-10 минут...
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VER=%%v"
pushd android
call gradlew.bat assembleDebug --console=plain -q
if errorlevel 1 (
    popd
    goto :fail
)
popd
copy /y "android\app\build\outputs\apk\debug\app-debug.apk" "..\Volna-%VER%.apk" >nul
echo.
echo Готово: Volna-%VER%.apk лежит в папке проекта.
echo Скинь файл на телефон (Telegram «Избранное», кабель или облако) и открой его.
echo Android спросит разрешение ставить приложения из этого источника — разреши.
if "%1"=="nopause" exit /b 0
explorer /select,"%~dp0Volna-%VER%.apk"
pause
exit /b 0

:find_jdk
set "JAVA_HOME="
for /d %%D in ("%ProgramFiles%\Microsoft\jdk-17*") do set "JAVA_HOME=%%D"
if not defined JAVA_HOME for /d %%D in ("%ProgramFiles%\Eclipse Adoptium\jdk-17*") do set "JAVA_HOME=%%D"
if not defined JAVA_HOME for /d %%D in ("%ProgramFiles%\Java\jdk-17*") do set "JAVA_HOME=%%D"
exit /b 0

:restart
echo Node.js установлен. Закрой это окно и запусти build_android.bat ещё раз.
if "%1"=="nopause" exit /b 1
pause
exit /b 1

:fail
echo.
echo Сборка не удалась. Пришли скриншот этого окна (прокрути вверх до первой ошибки).
if "%1"=="nopause" exit /b 1
pause
exit /b 1
