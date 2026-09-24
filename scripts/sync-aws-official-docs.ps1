$ErrorActionPreference = 'Stop'

$line = Get-Content '.env.local' -Encoding utf8 |
  Where-Object { $_ -like 'KNOWLEDGE_BASE_PATH=*' } |
  Select-Object -First 1
if (-not $line) { throw 'KNOWLEDGE_BASE_PATH is not configured in .env.local' }
$root = $line.Substring('KNOWLEDGE_BASE_PATH='.Length).Trim().Trim('"')
$target = Join-Path $root 'aws'
New-Item -ItemType Directory -Path $target -Force | Out-Null

$pages = @(
  @{ Name = 'errors'; Path = 'bedrock/latest/userguide/troubleshooting-api-error-codes' },
  @{ Name = 'endpoints'; Path = 'bedrock/latest/userguide/endpoints' },
  @{ Name = 'tool-use'; Path = 'bedrock/latest/userguide/tool-use' },
  @{ Name = 'claude-messages-request-response'; Path = 'bedrock/latest/userguide/model-parameters-anthropic-claude-messages-request-response' },
  @{ Name = 'claude-messages-tool-use'; Path = 'bedrock/latest/userguide/model-parameters-anthropic-claude-messages-tool-use' },
  @{ Name = 'converse-stream'; Path = 'bedrock/latest/APIReference/API_runtime_ConverseStream' },
  @{ Name = 'scaling-throughput'; Path = 'bedrock/latest/userguide/scaling-throughput-best-practices' },
  @{ Name = 'token-quotas'; Path = 'bedrock/latest/userguide/quotas-token-burndown' }
)
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($page in $pages) {
  $source = "https://docs.aws.amazon.com/$($page.Path).html"
  $markdown = "https://docs.aws.amazon.com/$($page.Path).md"
  $response = Invoke-WebRequest -Uri $markdown -UseBasicParsing -TimeoutSec 30
  if ($response.StatusCode -ne 200 -or -not $response.Content.Trim()) {
    throw "AWS returned an empty document: $markdown"
  }
  $frontmatter = "---`nsource: $source`noriginal_markdown: $markdown`nauthor: Amazon Web Services`nlicense: CC-BY-SA-4.0`nfetched_at: $(Get-Date -Format yyyy-MM-dd)`ncontent_kind: verbatim`n---`n"
  $file = Join-Path $target "$($page.Name).md"
  [System.IO.File]::WriteAllText($file, $frontmatter + $response.Content, $utf8)
  Write-Host "Saved official AWS Markdown: $file"
}
