; Start menu: an "Uninstall Miss Minutes" shortcut next to the app's own.
!macro customInstall
  CreateShortCut "$SMPROGRAMS\Uninstall ${PRODUCT_FILENAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

; A hand-run uninstall asks what else to delete. Both answers default to No, so a quick Enter keeps
; everything. A silent uninstall (/S) and the old version's uninstaller during an update ask nothing and
; keep everything. The recordings folder is never touched.
!ifdef BUILD_UNINSTALLER ; the installer pass doesn't use them, and NSIS treats unused variables as errors
  Var /GLOBAL mmLibrary
  Var /GLOBAL mmDeleteLibrary
  Var /GLOBAL mmDeleteAppData
!endif

!macro customUnInit
  StrCpy $mmDeleteLibrary "0"
  StrCpy $mmDeleteAppData "0"
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    ; Written by the installed app on every start and settings change (recordUninstallInfo in src/main/settings.ts).
    ReadINIStr $mmLibrary "$APPDATA\${PRODUCT_FILENAME}\uninstall.ini" library path
    ReadINIStr $R0 "$APPDATA\${PRODUCT_FILENAME}\uninstall.ini" library engine
    ; Only a library the bundled engine uses: in developer mode it is the project folder's own library, which
    ; the command-line watcher shares. And only a real library (index.json), never Documents or the profile itself.
    StrLen $R1 $mmLibrary
    ${If} $R0 == "bundled"
    ${AndIf} $R1 > 3
    ${AndIf} $mmLibrary != "$DOCUMENTS"
    ${AndIf} $mmLibrary != "$PROFILE"
    ${AndIf} ${FileExists} "$mmLibrary\index.json"
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Also delete your Miss Minutes library?$\r$\n$\r$\n$mmLibrary$\r$\n$\r$\nIt holds all your meeting notes, the index and compressed videos. This cannot be undone.$\r$\n$\r$\nChoose No (recommended) to keep it where it is: installing Miss Minutes again picks it up. Your recordings folder is never touched." /SD IDNO IDYES`
        StrCpy $mmDeleteLibrary "1"
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$APPDATA\${PRODUCT_FILENAME}\*.*"
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your settings and Google sign-in?$\r$\n$\r$\n$APPDATA\${PRODUCT_FILENAME}$\r$\n(settings, the automation browser profile, logs, the downloaded search model)$\r$\n$\r$\nChoose Yes for a completely fresh start: the setup wizard and Google sign-in run again. Choose No to keep them." /SD IDNO IDYES`
        StrCpy $mmDeleteAppData "1"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; The app is closed by now; its engine and the engine's hidden Chrome (kill-on-close job) may still be
  ; ending. They hold files in the install folder and the browser profile.
  nsExec::Exec 'taskkill /F /T /IM mm-engine.exe'
  Pop $R0
  Sleep 1000

  ; The autostart entry written by app.setLoginItemSettings (name: LOGIN_ITEM_NAME in src/main/index.ts).
  ; Skipped on an update: the new version re-applies the setting on start anyway.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Miss Minutes"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Miss Minutes"
    Delete "$SMPROGRAMS\Uninstall ${PRODUCT_FILENAME}.lnk"
  ${endIf}

  ${If} $mmDeleteLibrary == "1"
    DetailPrint "Deleting the library $mmLibrary"
    RMDir /r "$mmLibrary"
  ${EndIf}
  ${If} $mmDeleteAppData == "1"
    DetailPrint "Deleting $APPDATA\${PRODUCT_FILENAME}"
    RMDir /r "$APPDATA\${PRODUCT_FILENAME}"
  ${EndIf}
!macroend
