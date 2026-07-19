param(
  [Parameter(Mandatory = $true)]
  [string]$MuguaApiKey,
  [string]$OutputDirectory = '',
  [string]$Version = '20260718'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $projectRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $repoRoot 'dist' }
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$stageRoot = Join-Path $outputRoot (".doubao-l1-vm-worker-{0}-{1}" -f $Version, [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $stageRoot 'doubao-l1-vm-worker'
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

try {
  Copy-Item -LiteralPath (Join-Path $projectRoot 'src') -Destination (Join-Path $packageRoot 'src') -Recurse
  Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules') -Destination (Join-Path $packageRoot 'node_modules') -Recurse
  Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $packageRoot
  Copy-Item -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Destination $packageRoot
  Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination $packageRoot
  Copy-Item -Path (Join-Path $projectRoot 'vm\*') -Destination $packageRoot -Recurse
  Get-ChildItem -LiteralPath $packageRoot -Filter '*.ps1' -File | ForEach-Object {
    $scriptText = Get-Content -LiteralPath $_.FullName -Raw -Encoding utf8
    Set-Content -LiteralPath $_.FullName -Value $scriptText -Encoding utf8
  }
  $jobsRoot = Join-Path $packageRoot 'jobs'
  New-Item -ItemType Directory -Path $jobsRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot 'examples\openai-policy.example.json') -Destination (Join-Path $jobsRoot 'job.example.json')
  New-Item -ItemType Directory -Path (Join-Path $packageRoot 'results') -Force | Out-Null
  $runtimeRoot = Join-Path $packageRoot 'runtime'
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $nodePath = (Get-Command node -ErrorAction Stop).Source
  Copy-Item -LiteralPath $nodePath -Destination (Join-Path $runtimeRoot 'node.exe')
  $secrets = [ordered]@{
    muguaApiKey = $MuguaApiKey
    muguaBaseUrl = 'https://api.mugua.link/v1'
    muguaModel = 'gemini-3.1-pro-preview'
  }
  $secrets | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot 'runtime-secrets.json') -Encoding utf8

  $zipPath = Join-Path $outputRoot ("doubao-l1-vm-worker-{0}.zip" -f $Version)
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $hashPath = "$zipPath.sha256.txt"
  "$hash  $([System.IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath $hashPath -Encoding ascii
  [pscustomobject]@{
    ZipPath = $zipPath
    Sha256 = $hash
    Sha256Path = $hashPath
    SizeBytes = (Get-Item -LiteralPath $zipPath).Length
  } | ConvertTo-Json
} finally {
  $resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
  if ($resolvedStage.StartsWith($outputRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}
