$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $env:USERPROFILE 'ComfyUIRemoteControl'
$ServiceScript = Join-Path $InstallDir 'ComfyUIRemoteControl.ps1'
$TaskName = 'ComfyUI Phone Remote Control'
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$url = 'https://raw.githubusercontent.com/onilla192-cmyk/comfyui-pwa/main/tools/ComfyUIRemoteControl.ps1'
Invoke-WebRequest -Uri $url -OutFile $ServiceScript -UseBasicParsing
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File '$ServiceScript'"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Tiny Tailscale-only control listener for starting ComfyUI from the phone.' -Force | Out-Null
$tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (-not $tailscale) { $tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe' }
if (-not (Test-Path $tailscale)) { $tailscale = Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe' }
if (-not (Test-Path $tailscale)) { throw 'Tailscale was not found.' }
& $tailscale serve --https=443 --set-path=/remote --bg http://127.0.0.1:8191 | Out-Host
Start-ScheduledTask -TaskName $TaskName
Start-Sleep 2
try {
  $test = Invoke-WebRequest -Uri 'https://comfyui.tail84bda1.ts.net/remote/status' -UseBasicParsing -TimeoutSec 10
  Write-Host 'ComfyUI phone control is installed and reachable.' -ForegroundColor Green
  Write-Host $test.Content
} catch { Write-Host 'Installed; Tailscale path may need a few seconds to become reachable.' -ForegroundColor Yellow }
Write-Host 'ComfyUI and Vite were NOT started automatically.' -ForegroundColor Cyan
Write-Host 'Only the tiny phone-control listener starts at Windows logon.' -ForegroundColor Cyan