; Stop only Yep Anywhere process trees before install/uninstall. The bundled
; Bun child is terminated through its owned app tree; never kill ambient
; bun.exe processes that may belong to unrelated development work.

!macro _KillYepProcesses
  nsExec::ExecToLog 'taskkill.exe /F /T /IM "yep-anywhere-desktop.exe"'
  Pop $R0
  ; Retain the historical image name for upgrades from early preview builds.
  nsExec::ExecToLog 'taskkill.exe /F /T /IM "Yep Anywhere.exe"'
  Pop $R0

  Sleep 1000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _KillYepProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _KillYepProcesses
!macroend
