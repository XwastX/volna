; Установщик Volna (Inno Setup 6). Собирается через build_installer.bat.
#ifndef AppVersion
  #define AppVersion "0.5.0"
#endif

[Setup]
AppId={{6B1C9E7A-3F1D-4C61-9E0B-5A0D2C7F4E11}
AppName=Volna
AppVersion={#AppVersion}
AppVerName=Volna {#AppVersion}
AppPublisher=Volna
DefaultDirName={localappdata}\Programs\Volna
DefaultGroupName=Volna
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=Volna-Setup-{#AppVersion}
SetupIconFile=volna\assets\icon.ico
UninstallDisplayIcon={app}\Volna.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "Ярлык на рабочем столе"; GroupDescription: "Дополнительно:"

[Files]
Source: "dist\Volna\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Volna"; Filename: "{app}\Volna.exe"
Name: "{group}\Удалить Volna"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Volna"; Filename: "{app}\Volna.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Volna.exe"; Description: "Запустить Volna"; Flags: nowait postinstall skipifsilent
; после тихого автообновления Volna запускается сама
Filename: "{app}\Volna.exe"; Flags: nowait; Check: WizardSilent
