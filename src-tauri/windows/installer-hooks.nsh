; NSIS hooks for the Windows installer (bundle.windows.nsis.installerHooks).
;
; WebView2: tauri.conf.json sets webviewInstallMode to "skip". Tauri's
; "downloadBootstrapper" mode would fetch Microsoft's bootstrapper over plain
; HTTP (the NSISdl plugin has no TLS) and start it without checking its
; signature. Instead this hook checks for the WebView2 runtime the way Tauri's
; template does. If it is missing, the installer says what to do, opens
; Microsoft's download page in the default browser (over HTTPS, so the browser
; handles TLS) and stops before anything is installed.
;
; The hook runs at the start of Section Install, after the template's own
; WebView2 step. It only uses $0 and $1 and restores both.

!define TONUINO_WEBVIEW2_CLIENT "Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define TONUINO_WEBVIEW2_URL "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1

  ; Same keys as the template: per machine (32-bit view on 64-bit Windows),
  ; then per user. No value, an empty one or 0.0.0.0 means not installed.
  ${If} ${RunningX64}
    ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\${TONUINO_WEBVIEW2_CLIENT}" "pv"
  ${Else}
    ReadRegStr $0 HKLM "SOFTWARE\${TONUINO_WEBVIEW2_CLIENT}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ReadRegStr $0 HKCU "SOFTWARE\${TONUINO_WEBVIEW2_CLIENT}" "pv"
  ${EndIf}

  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ${If} $LANGUAGE == ${LANG_GERMAN}
      StrCpy $1 "Für TonUINO Studio fehlt noch ein kostenloser Baustein von Microsoft (WebView2).$\r$\n$\r$\nWir öffnen jetzt die Microsoft-Seite: Lade die Datei dort herunter, installiere sie und starte dieses Setup danach noch einmal."
    ${Else}
      StrCpy $1 "TonUINO Studio still needs a free component from Microsoft (WebView2).$\r$\n$\r$\nWe will now open the Microsoft page: download the file there, install it and then run this setup again."
    ${EndIf}
    ; /SD IDOK: a silent install (/S) skips the box instead of waiting for a click.
    MessageBox MB_OK|MB_ICONINFORMATION "$1" /SD IDOK
    ; Nobody would see the page during a silent install.
    ${IfNot} ${Silent}
      ExecShell "open" "${TONUINO_WEBVIEW2_URL}"
    ${EndIf}

    ${If} $LANGUAGE == ${LANG_GERMAN}
      DetailPrint "WebView2 fehlt, die Installation wurde abgebrochen."
    ${Else}
      DetailPrint "WebView2 is missing, the installation was cancelled."
    ${EndIf}
    ; Section Install has already created $INSTDIR. Leave it and remove it
    ; again if it is empty (RMDir without /r keeps anything with files in it).
    SetOutPath "$TEMP"
    RMDir "$INSTDIR"
    Pop $1
    Pop $0
    ; Ends the installation; the installer exits with code 2.
    Abort
  ${EndIf}

  Pop $1
  Pop $0
!macroend
