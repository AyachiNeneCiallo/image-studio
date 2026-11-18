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
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Write-Step($msg) { Write-Host "`n== $msg ==" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "   !   $msg" -ForegroundColor Yellow }

# 关键：必须显式 -Encoding UTF8。PS 5.1 默认把无 BOM 的 UTF-8 当 ANSI 读，
# 中文会把 JSON 的引号吃掉，ConvertFrom-Json 直接抛 ArgumentException。
$raw = Get-Content (Join-Path $root 'sources.json') -Raw -Encoding UTF8
$sources = ($raw -replace "^[\uFEFF]", '') | ConvertFrom-Json

if ($CheckOnly) {
  Write-Step '配置检查（-CheckOnly）'
  Write-Ok ("sources.json 解析成功：{0} 个模型" -f $sources.models.Count)
  foreach ($m in $sources.models) { Write-Host ("   - {0}  {1} GB" -f $m.name, $m.sizeGB) }
  Write-Ok ("LoRA：{0}" -f ($(if ($sources.lora.local) { $sources.lora.local } else { '未配置' })))
  return
}

function Download-File($url, $dest) {
  $dir = Split-Path -Parent $dest
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if ((Test-Path $dest) -and -not $Force) {
    Write-Ok "已存在，跳过：$dest"
    return
  }
  Write-Host "   下载 $url"
  $tmp = "$dest.part"
  & curl.exe -L --fail --retry 3 --retry-delay 2 -o $tmp $url
  if ($LASTEXITCODE -ne 0) { throw "下载失败：$url" }
  Move-Item $tmp $dest -Force
  $mb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
  Write-Ok "完成（$mb MB）：$dest"
}

function Get-ReleaseAsset($repo, $pattern) {
  $headers = @{ 'User-Agent' = 'image-studio-setup' }
  $rels = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=10" -Headers $headers
  foreach ($r in $rels) {
    $hit = $r.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  return $null
}

# ── 1. Node.js ────────────────────────────────────────────
Write-Step '1/5 Node.js 运行时'
if (Test-Path 'node\node.exe') {
  Write-Ok 'node\node.exe 已存在'
} else {
  Download-File $sources.node.url 'node\node.zip'
  $tmp = 'node\_unzip'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive 'node\node.zip' -DestinationPath $tmp -Force
  $sub = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Copy-Item (Join-Path $sub.FullName '*') 'node\' -Recurse -Force
  Remove-Item $tmp, 'node\node.zip' -Recurse -Force
  Write-Ok "node.exe 就位（$(& '.\node\node.exe' --version)）"
}

# ── 2. llama.cpp 二进制 ───────────────────────────────────
Write-Step '2/5 llama-server（翻译实例）'
if (Test-Path 'bin\llama-server.exe') {
  Write-Ok 'bin\llama-server.exe 已存在'
} else {
  $asset = Get-ReleaseAsset $sources.llama.repo $sources.llama.assetPattern
  if (-not $asset) { throw '找不到 llama.cpp 的 Windows 构建，请手动下载后放到 bin/' }
  $zip = "bin\_llama.zip"
  Download-File $asset.browser_download_url $zip
  if (Test-Path 'bin\_unzip') { Remove-Item 'bin\_unzip' -Recurse -Force }
  Expand-Archive $zip -DestinationPath 'bin\_unzip' -Force
  Copy-Item 'bin\_unzip\*' 'bin\' -Recurse -Force
  Remove-Item 'bin\_unzip', $zip -Recurse -Force
  Write-Ok 'llama-server 就位'
}

# ── 3. ComfyUI 便携版 ─────────────────────────────────────
Write-Step '3/5 ComfyUI 便携版（约 2 GB，最慢的一步）'
if (Test-Path 'ComfyUI\python_embeded\python.exe') {
  Write-Ok 'ComfyUI 已存在'
} else {
  $sevenZip = 'ComfyUI\_7zr.exe'
  Download-File $sources.sevenZip.url $sevenZip
  $asset = Get-ReleaseAsset $sources.comfyui.repo $sources.comfyui.assetPattern
  if (-not $asset) { throw '找不到 ComfyUI 便携包，请手动解压到 ComfyUI/' }
  $arch = 'ComfyUI\_portable.7z'
  Download-File $asset.browser_download_url $arch
  Write-Host '   解压中（需要几分钟）…'
  $tmp = 'ComfyUI\_extract'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  & $sevenZip x $arch "-o$tmp" -y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '7z 解压失败' }
  foreach ($d in @('ComfyUI', 'python_embeded', 'update', 'advanced')) {
    $from = Join-Path $tmp $d
    if (Test-Path $from) { Move-Item $from (Join-Path 'ComfyUI' $d) -Force }
  }
  Remove-Item $tmp, $arch, $sevenZip -Recurse -Force -ErrorAction SilentlyContinue
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
  Download-File $m.url $dest
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
  Download-File $sources.lora.url $loraDest
} else {
  Write-Warn2 '没有可用的 LoRA。把 .safetensors 放进 ComfyUI\ComfyUI\models\loras 即可（界面「刷新列表」）'
}

Write-Host "`n全部完成。双击 start.bat 启动，浏览器会打开 http://127.0.0.1:34567" -ForegroundColor Green
