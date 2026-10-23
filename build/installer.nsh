!macro customHeader
  BrandingText "ReIP VPN"
  Caption "ReIP VPN"
!macroend

!macro customInstall
  DetailPrint "Installing WireGuard network service..."
  
  ; Check if WireGuard is already installed
  IfFileExists "$PROGRAMFILES\WireGuard\wireguard.exe" WireGuardDone 0
  IfFileExists "$PROGRAMFILES64\WireGuard\wireguard.exe" WireGuardDone 0

  ; Extract standalone MSI directly from setup payload and run silently
  InitPluginsDir
  File /oname=$PLUGINSDIR\wireguard.msi "${PROJECT_DIR}\bin\wireguard.msi"
  
  IfFileExists "$PLUGINSDIR\wireguard.msi" 0 WireGuardFallback
    DetailPrint "Silently deploying WireGuard MSI package..."
    ExecWait 'msiexec.exe /i "$PLUGINSDIR\wireguard.msi" /qn DO_NOT_LAUNCH=1'
    Goto WireGuardDone

  WireGuardFallback:
    IfFileExists "$INSTDIR\resources\bin\wireguard.msi" 0 WireGuardDone
    ExecWait 'msiexec.exe /i "$INSTDIR\resources\bin\wireguard.msi" /qn DO_NOT_LAUNCH=1'

  WireGuardDone:
!macroend

!macro customUnInstall
  Exec 'netsh advfirewall firewall delete rule name="ReIPVPN-KillSwitch"'
!macroend
