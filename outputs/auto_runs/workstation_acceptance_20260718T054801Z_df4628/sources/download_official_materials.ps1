$ErrorActionPreference = 'Stop'

$runRoot = Split-Path -Parent $PSScriptRoot
$attachmentRoot = Join-Path $runRoot 'attachments\01'
New-Item -ItemType Directory -Force -Path $attachmentRoot | Out-Null

$sources = @(
    [ordered]@{
        name = '01_ccgp_award_result.html'
        url = 'https://www.ccgp.gov.cn/cggg/zygg/zbgg/202606/t20260604_26685746.htm'
        sourcePageUrl = 'https://www.ccgp.gov.cn/cggg/zygg/zbgg/202606/t20260604_26685746.htm'
    },
    [ordered]@{
        name = '02_ccgp_tender_document.pdf'
        url = 'https://download.ccgp.gov.cn/oss/download?uuid=B5D63E6DFCF7514E1B5784173A2375'
        sourcePageUrl = 'https://www.ccgp.gov.cn/cggg/zygg/zbgg/202606/t20260604_26685746.htm'
    },
    [ordered]@{
        name = '03_lenovo_thinkstation_p3_tiny_gen2_user_guide.pdf'
        url = 'https://chinakb.lenovo.com.cn/chinakb/prod-api/file/downloadFile?key=uniko/FILE/b6fc317ace0ccc48ede32aa2e4f97956-1772157485340.pdf&name=ThinkStation%20P3%20Tiny%20Gen%202%20%E7%94%A8%E6%88%B7%E6%8C%87%E5%8D%97-20260227.pdf'
        sourcePageUrl = 'https://iknow.lenovo.com.cn/detail/429100'
    },
    [ordered]@{
        name = '04_lenovo_thinkstation_p368_c4_user_guide.pdf'
        url = 'https://chinakb.lenovo.com.cn/chinakb/prod-api/file/downloadFile?key=uniko/FILE/c243bfe5ae9f4755c5d06a7e33982f61-1757922846732.pdf&name=ThinkStation%20P368-C4%20%E7%94%A8%E6%88%B7%E6%8C%87%E5%8D%97-20250915.pdf'
        sourcePageUrl = 'https://iknow.lenovo.com.cn/detail/428338'
    },
    [ordered]@{
        name = '05_lenovo_thinkstation_p2_tower_user_guide.pdf'
        url = 'https://chinakb.lenovo.com.cn/chinakb/prod-api/file/downloadFile?key=uniko/FILE/eef1841e3330662d70e6a000027631cb-1760063572795.pdf&name=ThinkStation%20P2%20Tower%20%E7%94%A8%E6%88%B7%E6%8C%87%E5%8D%97-20251009.pdf'
        sourcePageUrl = 'https://iknow.lenovo.com.cn/detail/420269'
    }
)

$items = foreach ($source in $sources) {
    $target = Join-Path $attachmentRoot $source.name
    $headers = @{
        Referer = $source.sourcePageUrl
        'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36'
    }
    if (Test-Path -LiteralPath $target) {
        $response = Invoke-WebRequest -Uri $source.url -UseBasicParsing -MaximumRedirection 10 -Headers $headers -Method Head
    } else {
        $response = Invoke-WebRequest -Uri $source.url -UseBasicParsing -MaximumRedirection 10 -Headers $headers -OutFile $target -PassThru
    }
    $file = Get-Item -LiteralPath $target
    $contentType = [string]$response.Headers['Content-Type']
    if ([string]::IsNullOrWhiteSpace($contentType) -and $file.Length -ge 5) {
        $stream = [IO.File]::OpenRead($file.FullName)
        try {
            $header = New-Object byte[] 5
            [void]$stream.Read($header, 0, 5)
            if ([Text.Encoding]::ASCII.GetString($header) -eq '%PDF-') {
                $contentType = 'application/pdf'
            }
        } finally {
            $stream.Dispose()
        }
    }
    $finalUrl = [string]$response.BaseResponse.ResponseUri.AbsoluteUri
    if ([string]::IsNullOrWhiteSpace($finalUrl)) {
        $finalUrl = $source.url
    }
    $item = [ordered]@{
        name = $source.name
        url = $source.url
        sourcePageUrl = $source.sourcePageUrl
        path = $file.FullName
        size = $file.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
        contentType = $contentType
        finalUrl = $finalUrl
        downloadedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-Host ("VERIFIED {0} {1} bytes" -f $item.name, $item.size)
    $item
}

$manifest = [ordered]@{
    schemaVersion = 1
    kind = 'official-material-download-manifest'
    runId = 'workstation_acceptance_20260718T054801Z_df4628'
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    items = @($items)
}

$manifestPath = Join-Path $PSScriptRoot 'download_manifest.json'
$manifestJson = $manifest | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($manifestPath, $manifestJson + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
$manifest | ConvertTo-Json -Depth 8
