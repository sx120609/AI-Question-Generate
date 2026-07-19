$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-PackageNode {
  $portable = Join-Path $PSScriptRoot 'runtime\node.exe'
  if (Test-Path -LiteralPath $portable) { return $portable }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) { throw '未找到 Node.js。请使用完整 VM 压缩包，或先安装 Node.js。' }
  return $node.Source
}

function Get-LocalCodex {
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_CLI_PATH) -and (Test-Path -LiteralPath $env:CODEX_CLI_PATH)) {
    return $env:CODEX_CLI_PATH
  }
  $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  $candidate = Get-ChildItem -LiteralPath $binRoot -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -ne $candidate) { return $candidate.FullName }
  $command = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($null -ne $command) { return $command.Source }
  throw '未找到本机 Codex CLI。请先安装并登录 Codex Desktop。'
}

function Import-PackageSecrets {
  $secretPath = Join-Path $PSScriptRoot 'runtime-secrets.json'
  if (Test-Path -LiteralPath $secretPath) {
    $secret = Get-Content -LiteralPath $secretPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$secret.muguaApiKey)) { throw 'runtime-secrets.json 中的去 AI 密钥为空。' }
    $env:DE_AI_REWRITE_API_KEY = [string]$secret.muguaApiKey
    if (-not [string]::IsNullOrWhiteSpace([string]$secret.muguaBaseUrl)) {
      $env:DE_AI_REWRITE_BASE_URL = [string]$secret.muguaBaseUrl
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$secret.muguaModel)) {
      $env:DE_AI_REWRITE_MODEL = [string]$secret.muguaModel
    }
    return $secretPath
  }
  if ([string]::IsNullOrWhiteSpace($env:DE_AI_REWRITE_API_KEY)) {
    throw '未配置去 AI 接口。开发版不携带 API 配置，请在本机设置 DE_AI_REWRITE_API_KEY、DE_AI_REWRITE_BASE_URL 和 DE_AI_REWRITE_MODEL。'
  }
  if ([string]::IsNullOrWhiteSpace($env:DE_AI_REWRITE_BASE_URL)) {
    throw '缺少 DE_AI_REWRITE_BASE_URL。'
  }
  if ([string]::IsNullOrWhiteSpace($env:DE_AI_REWRITE_MODEL)) {
    throw '缺少 DE_AI_REWRITE_MODEL。'
  }
  return ''
}

function Initialize-PackageRuntime {
  $node = Get-PackageNode
  $codex = Get-LocalCodex
  $env:CODEX_CLI_PATH = $codex
  $secretPath = Import-PackageSecrets
  & $codex login status
  if ($LASTEXITCODE -ne 0) { throw 'Codex 尚未登录。请先在本机 Codex Desktop 完成登录。' }
  return [pscustomobject]@{ Node = $node; Codex = $codex; Secrets = $secretPath }
}

function Get-DoubaoExe {
  $exe = Join-Path $env:LOCALAPPDATA 'Doubao\Application\app\Doubao.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw "未找到豆包客户端：$exe" }
  return $exe
}
