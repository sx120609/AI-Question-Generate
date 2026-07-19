param(
  [string]$OutputDirectory = '',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $repoRoot 'dist'
}
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = Get-Date -Format 'yyyyMMdd-HHmm'
}
if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$') {
  throw 'Version must contain 3-32 filename-safe characters.'
}

$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$packageName = "AI-Question-Generate-dev-$Version"
$stageRoot = Join-Path $outputRoot (".devpkg-{0}" -f [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $stageRoot $packageName
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

function Get-SafeRelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Path
  )
  $rootPrefix = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the expected root: $fullPath"
  }
  return $fullPath.Substring($rootPrefix.Length)
}

function Test-ExcludedRelativePath {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $normalized = $RelativePath.Replace('\', '/').ToLowerInvariant()
  $segments = $normalized.Split('/', [System.StringSplitOptions]::RemoveEmptyEntries)
  foreach ($segment in $segments) {
    if ($segment -in @('.git', '.codex', '.agents', 'node_modules', '__pycache__', 'outputs', 'dist')) {
      return $true
    }
  }
  $name = [System.IO.Path]::GetFileName($normalized)
  if ($name -eq '.env' -or $name.StartsWith('.env.') -or $name -eq '.npmrc' -or $name -eq 'runtime-secrets.json') {
    return $true
  }
  if ($name.EndsWith('.local') -or $name.EndsWith('.pyc')) { return $true }
  $extension = [System.IO.Path]::GetExtension($name)
  if ($extension -in @('.json', '.txt', '.yaml', '.yml', '.ini', '.config')) {
    if ($name -match '(?:secret|credential|token-cache|auth-state|cookie)') { return $true }
  }
  return $false
}

function Copy-AllowedTree {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  $sourceRoot = (Resolve-Path -LiteralPath $Source).Path
  Get-ChildItem -LiteralPath $sourceRoot -File -Recurse | ForEach-Object {
    if (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return }
    $relative = Get-SafeRelativePath -Root $sourceRoot -Path $_.FullName
    if (Test-ExcludedRelativePath -RelativePath $relative) { return }
    $target = Join-Path $Destination $relative
    New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target
  }
}

function Copy-RootFile {
  param([Parameter(Mandatory = $true)][string]$Name)
  $source = Join-Path $repoRoot $Name
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $packageRoot $Name)
  }
}

function Assert-NoCredentialMaterial {
  param([Parameter(Mandatory = $true)][string]$Root)
  $textExtensions = @('.md', '.mjs', '.js', '.json', '.txt', '.ps1', '.py', '.gitignore', '.gitattributes')
  $findings = [System.Collections.Generic.List[string]]::new()
  Get-ChildItem -LiteralPath $Root -File -Recurse | ForEach-Object {
    $relative = (Get-SafeRelativePath -Root $Root -Path $_.FullName).Replace('\', '/')
    if (Test-ExcludedRelativePath -RelativePath $relative) {
      $findings.Add("forbidden-path:$relative")
      return
    }
    if ([System.IO.Path]::GetExtension($_.Name).ToLowerInvariant() -notin $textExtensions -and $_.Name -notin @('.gitignore', '.gitattributes')) {
      return
    }
    $text = Get-Content -LiteralPath $_.FullName -Raw -Encoding utf8
    if ($text -match '(?i)\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b') {
      $findings.Add("api-key-pattern:$relative")
    }
    if ($text -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----') {
      $findings.Add("private-key:$relative")
    }
    if ($text -match '(?i)\$env:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)\s*=\s*["''][^<][^"'']{11,}["'']') {
      $findings.Add("literal-env-secret:$relative")
    }
    if ($text -match '(?i)"(?:apiKey|accessToken|refreshToken|clientSecret)"\s*:\s*"(?!<|\$\{|process\.env|[A-Z0-9_]+\b)[^"\r\n]{12,}"') {
      $findings.Add("literal-json-secret:$relative")
    }
  }
  if ($findings.Count -gt 0) {
    throw "Development package credential scan failed: $($findings -join ', ')"
  }
}

try {
  foreach ($file in @('.gitattributes', '.gitignore', 'README.md')) { Copy-RootFile -Name $file }
  foreach ($relativeRoot in @(
    'build\automation',
    'build\formal_production',
    'build\manual_review',
    'build\migrations',
    'config',
    'docs',
    'doubao-automation',
    'inputs'
  )) {
    $source = Join-Path $repoRoot $relativeRoot
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $destination = Join-Path $packageRoot $relativeRoot
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-AllowedTree -Source $source -Destination $destination
  }

  $fileCount = (Get-ChildItem -LiteralPath $packageRoot -File -Recurse).Count
  $packageMetadata = [ordered]@{
    schemaVersion = 1
    kind = 'ai-question-generate-development-package'
    version = $Version
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    apiConfigurationIncluded = $false
    credentialsIncluded = $false
    runtimeIncluded = $false
    nodeModulesIncluded = $false
    outputsIncluded = $false
    fileCountBeforeMetadata = $fileCount
    install = @('node --test build/automation/*.test.mjs', 'cd doubao-automation', 'npm install', 'npm test')
  }
  $packageMetadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $packageRoot 'DEVELOPMENT_PACKAGE.json') -Encoding utf8
  Assert-NoCredentialMaterial -Root $packageRoot

  $zipPath = Join-Path $outputRoot "$packageName.zip"
  $hashPath = "$zipPath.sha256.txt"
  $manifestPath = Join-Path $outputRoot "$packageName.manifest.json"
  foreach ($target in @($zipPath, $hashPath, $manifestPath)) {
    $resolvedTarget = [System.IO.Path]::GetFullPath($target)
    if (-not $resolvedTarget.StartsWith($outputRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to replace a package artifact outside the output directory: $resolvedTarget"
    }
    if (Test-Path -LiteralPath $resolvedTarget) { Remove-Item -LiteralPath $resolvedTarget -Force }
  }

  Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $([System.IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath $hashPath -Encoding ascii
  $manifest = [ordered]@{
    schemaVersion = 1
    kind = 'ai-question-generate-development-package-manifest'
    version = $Version
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    zipPath = $zipPath
    sha256 = $hash
    sha256Path = $hashPath
    sizeBytes = (Get-Item -LiteralPath $zipPath).Length
    fileCount = (Get-ChildItem -LiteralPath $packageRoot -File -Recurse).Count
    apiConfigurationIncluded = $false
    credentialsIncluded = $false
    excludedRoots = @('.git', '.codex', '.agents', 'outputs', 'dist', 'build/tmp', 'node_modules')
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  $manifest | ConvertTo-Json -Depth 5
} finally {
  $resolvedStage = [System.IO.Path]::GetFullPath($stageRoot)
  if ($resolvedStage.StartsWith($outputRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}
