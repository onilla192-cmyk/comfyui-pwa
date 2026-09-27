param()
$ErrorActionPreference = 'Stop'

$ListenUrl = 'http://127.0.0.1:8191/'
$LauncherUrl = 'http://127.0.0.1:8190'
$LauncherScript = 'C:\Users\oneto\Downloads\comfyui-launcher\ComfyUILauncher.ps1'
$ComfyUrl = 'http://127.0.0.1:8188'

function Json($Context, [int]$Code, [hashtable]$Body) {
  $json = $Body | ConvertTo-Json -Compress -Depth 8
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $Context.Response.StatusCode = $Code
  $Context.Response.ContentType = 'application/json; charset=utf-8'
  $Context.Response.Headers['Access-Control-Allow-Origin'] = '*'
  $Context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
  $Context.Response.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes,0,$bytes.Length)
  $Context.Response.OutputStream.Close()
}

function PortOpen([int]$Port) {
  try { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1) } catch { return $false }
}

function ComfyRunning {
  try { return (Invoke-WebRequest -Uri "$ComfyUrl/system_stats" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop).StatusCode -eq 200 } catch { return $false }
}

function EnsureLauncher {
  if (PortOpen 8190) { return }
  if (-not (Test-Path -LiteralPath $LauncherScript)) { throw "Launcher script not found: $LauncherScript" }
  Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$LauncherScript) -WindowStyle Hidden
  for ($i=0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; if (PortOpen 8190) { return } }
  throw 'ComfyUI launcher control server did not start.'
}

function StartComfy {
  EnsureLauncher
  if (ComfyRunning) { return }
  Invoke-RestMethod -Uri "$LauncherUrl/start" -Method POST -TimeoutSec 10 | Out-Null
  for ($i=0; $i -lt 120; $i++) { Start-Sleep 1; if (ComfyRunning) { return } }
  throw 'ComfyUI did not become ready within 120 seconds.'
}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add($ListenUrl)
$listener.Start()
while ($listener.IsListening) {
  $context = $null
  try {
    $context = $listener.GetContext()
    $path = $context.Request.Url.AbsolutePath.TrimEnd('/')
    if ($context.Request.HttpMethod -eq 'OPTIONS') {
      $context.Response.StatusCode = 204
      $context.Response.Headers['Access-Control-Allow-Origin'] = '*'
      $context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
      $context.Response.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
      $context.Response.Close(); continue
    }
    if ($path -eq '/status' -and $context.Request.HttpMethod -eq 'GET') {
      Json $context 200 @{ ok=$true; listener='running'; launcher=if(PortOpen 8190){'running'}else{'stopped'}; comfyui=if(ComfyRunning){'running'}else{'stopped'} }; continue
    }
    if ($path -eq '/start' -and $context.Request.HttpMethod -eq 'POST') {
      StartComfy
      Json $context 200 @{ ok=$true; launcher='running'; comfyui='running' }; continue
    }
    Json $context 404 @{ ok=$false; error='Not found' }
  } catch {
    if ($context) { try { Json $context 500 @{ ok=$false; error=$_.Exception.Message } } catch {} }
  }
}