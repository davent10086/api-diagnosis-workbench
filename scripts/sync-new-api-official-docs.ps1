$ErrorActionPreference = 'Stop'

$line = Get-Content '.env.local' -Encoding utf8 |
  Where-Object { $_ -like 'KNOWLEDGE_BASE_PATH=*' } |
  Select-Object -First 1
if (-not $line) { throw 'KNOWLEDGE_BASE_PATH is not configured in .env.local' }
$root = $line.Substring('KNOWLEDGE_BASE_PATH='.Length).Trim().Trim('"')
$target = Join-Path $root 'new-api'
$headers = @{ 'User-Agent' = 'new-api-knowledge-sync' }
$pages = @(
  @{ Name = 'faq'; Repo = 'new-api-docs-v1'; Path = 'content/docs/zh/support/faq.mdx' },
  @{ Name = 'channel-parameter-overrides'; Repo = 'new-api-docs-v1'; Path = 'content/docs/zh/guide/console/channel-management.mdx' },
  @{ Name = 'channel-guide'; Repo = 'new-api-docs-v1'; Path = 'content/docs/zh/guide/feature-guide/admin/channel.mdx' },
  @{ Name = 'environment-variables'; Repo = 'new-api-docs-v1'; Path = 'content/docs/zh/installation/config-maintenance/environment-variables.mdx' },
  @{ Name = 'rate-limit-settings'; Repo = 'new-api-docs-v1'; Path = 'content/docs/zh/guide/console/settings/rate-limit-settings.mdx' },
  @{ Name = 'rate-settings'; Repo = 'new-api-docs-v1'; Path = 'content/docs/zh/guide/console/settings/rate-settings.mdx' },
  @{ Name = 'channel-test-api'; Repo = 'new-api-docs'; Path = 'docs/api/fei-channel-management.md' },
  @{ Name = 'logs-api'; Repo = 'new-api-docs'; Path = 'docs/api/fei-log.md' },
  @{ Name = 'plugin-faq'; Repo = 'new-api-docs-v1'; Path = 'content/docs/zh/plugins/faq.mdx' },
  @{ Name = 'channel-extra-settings'; Repo = 'new-api'; Path = 'docs/channel/other_setting.md' }
)
$commits = @{}
foreach ($repo in ($pages.Repo | Select-Object -Unique)) {
  $commit = Invoke-RestMethod -Uri "https://api.github.com/repos/QuantumNous/$repo/commits/main" -Headers $headers -TimeoutSec 30
  $commits[$repo] = $commit.sha
}

# Download and validate every selected page before writing the local snapshot.
$documents = @()
$date = Get-Date -Format yyyy-MM-dd
foreach ($page in $pages) {
  $sha = $commits[$page.Repo]
  $source = "https://github.com/QuantumNous/$($page.Repo)/blob/$sha/$($page.Path)"
  $rawUrl = "https://raw.githubusercontent.com/QuantumNous/$($page.Repo)/$sha/$($page.Path)"
  $response = Invoke-WebRequest -Uri $rawUrl -Headers $headers -UseBasicParsing -TimeoutSec 30
  $body = $response.Content.TrimStart([char]0xfeff).Replace("`r`n", "`n")
  if ($response.StatusCode -ne 200 -or $body.Length -lt 80 -or $body -match '^<!DOCTYPE') {
    throw "Invalid official document: $rawUrl"
  }
  $front = [regex]::Match($body, '\A---\s*\n([\s\S]*?)\n---\s*\n')
  $title = ''
  if ($front.Success) {
    $title = [regex]::Match($front.Groups[1].Value, '(?m)^title:\s*(.+)$').Groups[1].Value.Trim().Trim('"').Trim("'")
    $body = $body.Substring($front.Length)
  }
  $body = [regex]::Replace($body, '(?m)^import\s+.+;?\s*$', '')
  $body = [regex]::Replace($body, '(?m)^\s*</?Callout\b[^>]*>\s*$', '')
  if ($body -match '<APIPage\b') { throw "Page requires OpenAPI rendering; select a document with actual parameter and response text: $source" }
  if ($title) { $body = "# new-api $title`n`n" + $body.Trim() }
  $metadata = "---`nsource: $source`noriginal_markdown: $rawUrl`nauthor: QuantumNous`nfetched_at: $date`ncontent_kind: official-documentation`ngithub_commit: $sha`nsource_repository: QuantumNous/$($page.Repo)`nlicense_url: https://github.com/QuantumNous/$($page.Repo)/blob/$sha/LICENSE`n---`n"
  $documents += [pscustomobject]@{ Name = $page.Name; Source = $source; Commit = $sha; Content = $metadata + $body.Trim() + "`n" }
}

New-Item -ItemType Directory -Path $target -Force | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($document in $documents) {
  [System.IO.File]::WriteAllText((Join-Path $target "$($document.Name).md"), $document.Content, $utf8)
  Write-Host "Saved new-api official document: $($document.Name)"
}
$manifest = [pscustomobject]@{
  fetchedAt = $date
  documents = @($documents | Select-Object Name,Source,Commit)
  note = 'Official documentation snapshot; check compatibility with the deployed New API version. MDX imports and Callout wrappers are removed; examples and warning text are retained.'
}
[System.IO.File]::WriteAllText((Join-Path $target 'SOURCE-MANIFEST.json'), ($manifest | ConvertTo-Json -Depth 5), $utf8)
Write-Host "Saved $($documents.Count) documents to $target"
