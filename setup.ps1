# Image Studio 首次运行下载脚本
# 作用：把运行时和模型下载到当前目录，之后双击 start.bat 即可使用。
# 用法：powershell -ExecutionPolicy Bypass -File setup.ps1
param(
  [switch]$Force,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
# 让 Windows PowerShell 5.1 正确输出/读取 UTF-8（否则中文会乱码，JSON 解析也会失败）
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [Text.Encoding]::UTF8
# GitHub API 要求 TLS 1.2+；PowerShell 5.1 默认可能还是 TLS 1.0/1.1
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Write-Step($msg) { Write-Host "`n== $msg ==" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "   !   $msg" -ForegroundColor Yellow }

# 关键：必须显式 -Encoding UTF8。PS 5.1 默认把无 BOM 的 UTF-8 当 ANSI 读，
# 中文会把 JSON 的引号吃掉，ConvertFrom-Json 直接抛 ArgumentException。
$raw = Get-Content (Join-Path $root 'sources.json') -Raw -Encoding UTF8
$sources = ($raw -replace "^[\uFEFF]", '') | ConvertFrom-Json

# 把目录搬到目标位置；目标已存在时合并，避免 Move-Item 把整个目录嵌套进去
function Move-Into($srcDir, $destDir) {
  if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $destDir) -Force | Out-Null
    Move-Item $srcDir $destDir -Force
    return
  }
  foreach ($item in Get-ChildItem $srcDir -Force) {
    $target = Join-Path $destDir $item.Name
    if (Test-Path $target) {
      if ($item.PSIsContainer) { Move-Into $item.FullName $target }
      else { Copy-Item $item.FullName $target -Force }
    } else {
      Move-Item $item.FullName $target -Force
    }
  }
  Remove-Item $srcDir -Recurse -Force -ErrorAction SilentlyContinue
}


# 把候选 URL 展开：github.com 链接优先走国内镜像，最后才是官方地址
function Get-UrlCandidates($urls) {
  $out = @()
  foreach ($u in @($urls)) {
    if (-not $u) { continue }
    if ($u -match '^https://github\.com/' -and $sources.githubMirrors) {
      foreach ($m in $sources.githubMirrors) { $out += "$m$u" }
    }
    $out += $u
  }
  return $out
}

function Download-File($urls, $dest) {
  $dir = Split-Path -Parent $dest
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if ((Test-Path $dest) -and -not $Force) {
    Write-Ok "已存在，跳过：$dest"
    return
  }
  $cands = @($urls) | Where-Object { $_ }
  if ($cands.Count -eq 0) { throw "没有可用的下载地址：$dest" }
  $tmp = "$dest.part"
  $proxy = $env:HTTPS_PROXY; if (-not $proxy) { $proxy = $env:HTTP_PROXY }
  $last = ''
  foreach ($u in $cands) {
    Write-Host "   下载 $u"
    # -C - 断点续传：2 GB 的 ComfyUI 在国内直连很慢，中断后重跑/换源都能接着下
    $curlArgs = @('-L', '--fail', '--retry', '3', '--retry-delay', '2', '-C', '-', '-o', $tmp, '--progress-bar', $u)
    if ($proxy) { $curlArgs = @('-x', $proxy) + $curlArgs }
    & curl.exe @curlArgs
    if ($LASTEXITCODE -eq 0) {
      Move-Item $tmp $dest -Force
      $mb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
      Write-Ok "完成（$mb MB）：$dest"
      return
    }
    $last = $u
    Write-Warn2 "该源失败（exit=$LASTEXITCODE），换下一个源"
  }
  throw "所有下载源都失败：$dest`n最后一个源：$last`n已下载部分保存在 $tmp，重跑会续传；若整片都慢请开代理后设置 `$env:HTTPS_PROXY"
}

function Get-ReleaseAsset($repo, $pattern) {
  $api = "https://api.github.com/repos/$repo/releases?per_page=10"
  $json = $null
  # 优先用 curl.exe 查 API：PS 5.1 默认 TLS 1.0/1.1 会被 GitHub 拒绝（"基础连接已经关闭"）
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $tmp = Join-Path $env:TEMP ("ghrel_" + [Guid]::NewGuid().ToString('N') + ".json")
    $curlArgs = @('-sL', '--fail', '--retry', '3', '--retry-delay', '2', '-H', 'User-Agent: image-studio-setup', '-o', $tmp, $api)
    $proxy = $env:HTTPS_PROXY; if (-not $proxy) { $proxy = $env:HTTP_PROXY }
    if ($proxy) { $curlArgs = @('-x', $proxy) + $curlArgs }
    & $curl.Source @curlArgs
    if ($LASTEXITCODE -eq 0 -and (Test-Path $tmp)) {
      $json = Get-Content $tmp -Raw -Encoding UTF8
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $json) {
    $headers = @{ 'User-Agent' = 'image-studio-setup' }
    try { $rels = Invoke-RestMethod $api -Headers $headers -TimeoutSec 30 }
    catch { throw "无法访问 GitHub API（$repo）：$($_.Exception.Message)。请检查网络/代理后重试" }
    $json = $rels | ConvertTo-Json -Depth 6
  }
  $rels = $json | ConvertFrom-Json
  foreach ($r in $rels) {
    $hit = $r.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  return $null
}

if ($CheckOnly) {
  Write-Step '配置检查（-CheckOnly）'
  Write-Ok ("sources.json 解析成功：{0} 个模型" -f $sources.models.Count)
  foreach ($m in $sources.models) { Write-Host ("   - {0}  {1} GB" -f $m.name, $m.sizeGB) }
  Write-Ok ("LoRA：{0}" -f ($(if ($sources.lora.local) { $sources.lora.local } else { '未配置' })))
  try {
    $a = Get-ReleaseAsset $sources.llama.repo $sources.llama.assetPattern
    Write-Ok ("llama.cpp 资产：{0}" -f ($(if ($a) { $a.name } else { '未找到' })))
  } catch { Write-Warn2 ("GitHub API 不可用：" + $_.Exception.Message) }
  try {
    $b = Get-ReleaseAsset $sources.comfyui.repo $sources.comfyui.assetPattern
    Write-Ok ("ComfyUI 资产：{0}" -f ($(if ($b) { $b.name } else { '未找到' })))
  } catch { Write-Warn2 ("GitHub API 不可用：" + $_.Exception.Message) }
  Write-Host "`n   下载源优先级："
  Write-Host ("   Node     : {0}" -f @(Get-UrlCandidates $sources.node.urls)[0])
  $lc = @(Get-UrlCandidates @($sources.llama.fallbackUrls))
  Write-Host ("   llama.cpp: {0}" -f $lc[0])
  $cc = @(Get-UrlCandidates @($sources.comfyui.fallbackUrls))
  Write-Host ("   ComfyUI  : {0}" -f $cc[0])
  Write-Host ("   7zr      : {0}" -f $(if (Test-Path $sources.sevenZip.local) { "仓库自带 $($sources.sevenZip.local)" } else { '需下载' }))
  return
}

# ── 1. Node.js ────────────────────────────────────────────
Write-Step '1/5 Node.js 运行时'
if (Test-Path 'node\node.exe') {
  Write-Ok 'node\node.exe 已存在，跳过'
} else {
  $zip = 'node\node.zip'
  if (Test-Path $zip) { Write-Ok "已有安装包，跳过下载：$zip" } else { Download-File (Get-UrlCandidates $sources.node.urls) $zip }
  $tmp = 'node\_unzip'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp -Force
  $sub = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if ($sub) { Copy-Item (Join-Path $sub.FullName '*') 'node\' -Recurse -Force } else { Copy-Item "$tmp\*" 'node\' -Recurse -Force }
  Remove-Item $tmp -Recurse -Force
  if (-not (Test-Path 'node\node.exe')) { throw 'node.exe 解压后仍不存在，请删除 node/ 后重试' }
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Write-Ok "node.exe 就位（$(& '.\node\node.exe' --version)）"
}

# ── 2. llama.cpp 二进制 ───────────────────────────────────
Write-Step '2/5 llama-server（翻译实例）'
if (Test-Path 'bin\llama-server.exe') {
  Write-Ok 'bin\llama-server.exe 已存在，跳过'
} else {
  $zip = 'bin\_llama.zip'
  if (-not (Test-Path $zip)) {
    $cands = @()
    try {
      $asset = Get-ReleaseAsset $sources.llama.repo $sources.llama.assetPattern
      if ($asset) { $cands += $asset.browser_download_url }
    } catch { Write-Warn2 "GitHub API 不可用，直接用固定地址：$($_.Exception.Message)" }
    $cands += @($sources.llama.fallbackUrls)
    Download-File (Get-UrlCandidates $cands) $zip
  } else { Write-Ok "已有安装包，跳过下载：$zip" }
  if (Test-Path 'bin\_unzip') { Remove-Item 'bin\_unzip' -Recurse -Force }
  Expand-Archive $zip -DestinationPath 'bin\_unzip' -Force
  Copy-Item 'bin\_unzip\*' 'bin\' -Recurse -Force
  Remove-Item 'bin\_unzip' -Recurse -Force
  if (-not (Test-Path 'bin\llama-server.exe')) { throw 'llama-server.exe 解压后仍不存在，请检查 bin\_llama.zip 内容' }
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Write-Ok 'llama-server 就位'
}

# ── 3. ComfyUI 便携版 ─────────────────────────────────────
Write-Step '3/5 ComfyUI 便携版（约 2 GB，最慢的一步）'
# 递归查找：兼容用户手动解压后多一层目录的情况（如 ComfyUI\ComfyUI_windows_portable\ComfyUI\main.py）
$mainFile = Get-ChildItem 'ComfyUI' -Recurse -Depth 3 -Filter 'main.py' -ErrorAction SilentlyContinue |
  Where-Object { $_.Directory.Name -eq 'ComfyUI' } | Select-Object -First 1
$pyFile = Get-ChildItem 'ComfyUI' -Recurse -Depth 3 -Filter 'python.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.Directory.Name -eq 'python_embeded' } | Select-Object -First 1

# 位置不标准就搬到约定的 ComfyUI\ComfyUI 与 ComfyUI\python_embeded
if ($mainFile -and $mainFile.Directory.FullName -ne (Join-Path $root 'ComfyUI\ComfyUI') -and $mainFile.Directory.FullName -ne (Join-Path $root 'ComfyUI')) {
  Write-Warn2 "ComfyUI 代码在 $($mainFile.Directory.FullName)，搬运到标准位置"
  Move-Into $mainFile.Directory.FullName (Join-Path $root 'ComfyUI\ComfyUI')
  $mainFile = Get-Item 'ComfyUI\ComfyUI\main.py' -ErrorAction SilentlyContinue
}
if ($pyFile -and $pyFile.Directory.FullName -ne (Join-Path $root 'ComfyUI\python_embeded') -and $pyFile.Directory.FullName -ne (Join-Path $root 'ComfyUI')) {
  Write-Warn2 "python_embeded 在 $($pyFile.Directory.FullName)，搬运到标准位置"
  Move-Into $pyFile.Directory.FullName (Join-Path $root 'ComfyUI\python_embeded')
  $pyFile = Get-Item 'ComfyUI\python_embeded\python.exe' -ErrorAction SilentlyContinue
}

$mainOk = [bool]$mainFile
$pyOk = [bool]$pyFile
if ($mainOk -and $pyOk) {
  Write-Ok 'ComfyUI 已存在，跳过'
} else {
  if ($mainOk -and -not $pyOk) { Write-Warn2 'ComfyUI 代码在，但缺 python_embeded，继续安装' }
  if ($pyOk -and -not $mainOk) { Write-Warn2 'python_embeded 在，但缺 ComfyUI\main.py，继续安装' }
  $sevenZip = 'ComfyUI\_7zr.exe'
  if (Test-Path $sources.sevenZip.local) {
    Copy-Item $sources.sevenZip.local $sevenZip -Force
    Write-Ok '使用仓库自带的 7zr.exe'
  } elseif (Test-Path $sevenZip) {
    Write-Ok '已有 7zr.exe，跳过下载'
  } else {
    Download-File (Get-UrlCandidates $sources.sevenZip.urls) $sevenZip
  }
  $arch = 'ComfyUI\_portable.7z'
  if (-not (Test-Path $arch)) {
    $cands = @()
    try {
      $asset = Get-ReleaseAsset $sources.comfyui.repo $sources.comfyui.assetPattern
      if ($asset) { $cands += $asset.browser_download_url }
    } catch { Write-Warn2 "GitHub API 不可用，直接用固定地址：$($_.Exception.Message)" }
    $cands += @($sources.comfyui.fallbackUrls)
    Download-File (Get-UrlCandidates $cands) $arch
  } else { Write-Ok "已有安装包，跳过下载（约 2 GB）：$arch" }
  Write-Host '   解压中（需要几分钟）…'
  $tmp = 'ComfyUI\_extract'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  & $sevenZip x $arch "-o$tmp" -y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '7z 解压失败（安装包可能损坏，删掉 ComfyUI\_portable.7z 重试）' }

  # 官方便携包可能多一层根目录（ComfyUI_windows_portable\），自动定位真正包含
  # ComfyUI\main.py + python_embeded\python.exe 的那一层；找不到就按解压根目录处理
  $portableRoot = $null
  $found = Get-ChildItem $tmp -Directory -Recurse -ErrorAction SilentlyContinue | Where-Object {
    (Test-Path (Join-Path $_.FullName 'ComfyUI\main.py')) -and
    (Test-Path (Join-Path $_.FullName 'python_embeded\python.exe'))
  } | Sort-Object { $_.FullName.Length } | Select-Object -First 1
  if ($found) {
    $portableRoot = $found.FullName
    if ($portableRoot -ne $tmp) { Write-Ok "识别到便携包根目录：$portableRoot" }
  } else {
    $portableRoot = $tmp
  }

  foreach ($d in @('ComfyUI', 'python_embeded', 'update', 'advanced')) {
    $from = Join-Path $portableRoot $d
    if (Test-Path $from) { Move-Into $from (Join-Path $root "ComfyUI\$d") }
  }

  $mainOk2 = (Test-Path 'ComfyUI\ComfyUI\main.py') -or (Test-Path 'ComfyUI\main.py')
  $pyOk2 = (Test-Path 'ComfyUI\python_embeded\python.exe') -or (Test-Path 'ComfyUI\ComfyUI\python_embeded\python.exe')
  if (-not ($mainOk2 -and $pyOk2)) {
    $top = (Get-ChildItem $tmp -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ', '
    $cui = (Get-ChildItem 'ComfyUI' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ', '
    throw "ComfyUI 解压后仍不完整（保留下载包与解压目录，方便排查）。`n解压根内容：$top`nComfyUI 目录：$cui`n请把以上内容发给作者，或删除 ComfyUI\_extract 后重跑"
  }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $arch, $sevenZip -Recurse -Force -ErrorAction SilentlyContinue
  Write-Ok 'ComfyUI 就位'
}

# ── 4. 模型 ───────────────────────────────────────────────
Write-Step '4/5 下载模型（约 18 GB，可断点续传：重跑本脚本会跳过已完成的）'
foreach ($m in $sources.models) {
  $dest = $m.dest -replace '/', '\'
  if (Test-Path $dest) {
    Write-Ok "已存在，跳过：$($m.name)"
    continue
  }
  Write-Host "   -> $($m.name)（约 $($m.sizeGB) GB）"
  Download-File (Get-UrlCandidates @($m.url)) $dest
}

# ── 5. LoRA（随仓库自带测试 LoRA）────────────────────────
Write-Step '5/5 LoRA'
$loraDest = $sources.lora.dest -replace '/', '\'
$loraLocal = $sources.lora.local -replace '/', '\'
if ($loraDest -and (Test-Path $loraDest)) {
  Write-Ok 'LoRA 已存在'
} elseif ($loraLocal -and (Test-Path $loraLocal)) {
  $loraDir2 = Split-Path -Parent $loraDest
  if ($loraDir2 -and -not (Test-Path $loraDir2)) { New-Item -ItemType Directory -Path $loraDir2 -Force | Out-Null }
  Copy-Item $loraLocal $loraDest -Force
  Write-Ok "已复制测试 LoRA：$loraDest"
} elseif ($sources.lora.url) {
  Download-File (Get-UrlCandidates @($sources.lora.url)) $loraDest
} else {
  Write-Warn2 '没有可用的 LoRA。把 .safetensors 放进 ComfyUI\ComfyUI\models\loras 即可（界面「刷新列表」）'
}

Write-Host "`n全部完成。双击 start.bat 启动，浏览器会打开 http://127.0.0.1:34567" -ForegroundColor Green
