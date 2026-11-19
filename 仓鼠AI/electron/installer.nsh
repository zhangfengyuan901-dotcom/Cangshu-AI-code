!macro customCheckAppRunning
  ; The custom UI asks the user to close the app. Silent install/uninstall must
  ; never inherit electron-builder's automatic close/force-kill fallback.
  Push $0
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
  ${If} $0 == 0
    ${nsProcess::Unload}
    Pop $0
    SetErrorLevel 20
    Quit
  ${ElseIf} $0 != 603
    ; A failed process query is not evidence that the app is stopped.
    ${nsProcess::Unload}
    Pop $0
    SetErrorLevel 21
    Quit
  ${EndIf}
  ${nsProcess::Unload}
  Pop $0
!macroend

!macro customInstall
  ; Reserve extra disk space for the expanded runtime (742 MiB of file data,
  ; plus allocation overhead). NSIS already counts the packaged application.
  AddSize 1048576
  SetDetailsPrint both
  DetailPrint "正在准备工作台环境，首次安装可能需要几分钟，请勿关闭安装程序…"
  ClearErrors
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hamster-prepare-installed-runtime' $0
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
  ${If} $0 != 0
    SetErrorLevel 1
    MessageBox MB_OK|MB_ICONSTOP "工作台环境安装未完成。请检查磁盘空间与安全软件后重新运行安装包。安装日志位于安装目录 resources\runtime-install.log。个人配置与作品不会被清除。" /SD IDOK
    Abort
  ${EndIf}
  DetailPrint "工作台环境已准备完成。"
!macroend

!macro customUnInstall
  ; NSIS's legacy file traversal cannot reliably remove deeply nested packages.
  ; Let the bundled Node runtime remove only our generated dependency directory.
  ClearErrors
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hamster-remove-installed-runtime' $0
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
  ${If} $0 != 0
    SetErrorLevel 1
    MessageBox MB_OK|MB_ICONSTOP "工作台环境仍在使用中或无法移除，请关闭仓鼠AI后重试。个人配置与作品不会被清除。" /SD IDOK
    Abort
  ${EndIf}
!macroend
