# Image Studio · 本地生图工作室

把「中文描述 → Danbooru 标签 → ComfyUI 出图」这条链路做成一个**脱离 QQ / 聊天机器人、带网页界面、解压即用**的本地工具。

- 中文描述自动翻译成 Danbooru 标签（本地 Qwen3-8B **Heretic 去审查版**，离线；翻译成人向标签不会被拒）
- ComfyUI 出图，支持高清修复、LoRA、多底模（WAI / NoobAI）
- 右侧角色提示词面板：给 LoRA 绑定角色提示词 TXT，切 LoRA 自动显示
- 仓库内附带 1 个**测试 LoRA**（Kohana_1_nai-000026，作者自训练，96.8 MB）和它的**示例角色提示词**，开箱即可在右侧面板看到
- 右下角小助手：8 个功能帮助按钮
- 点击生成结果可放大预览
- 服务器端生成图**自动清理**，不会把磁盘塞满

> 下载慢或断线：先设置代理再运行 —— ='http://127.0.0.1:7890'；中断后重跑会**断点续传**。
> 官方便携包自带的 ComfyUI_windows_portable\ 根目录、或手动解压多一层，setup.ps1 都会自动识别并搬到标准位置。

> 本仓库**只包含代码**，不会分发任何模型权重或运行时。首次运行 `start.bat` 会调用 `setup.ps1`，
> 从官方 / HuggingFace 镜像下载 ComfyUI、llama.cpp、底模与翻译模型（约 18 GB）。

## 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 x64 |
| 显卡 | NVIDIA，显存 ≥ 8 GB（< 10 GB 会自动进入低显存模式） |
| 磁盘 | 约 25 GB 可用空间 |
| 网络 | 首次运行需联网下载（支持重复运行续传，已下载的会跳过） |

## 快速开始

1. 在 [Releases](../../releases) 下载 `image-studio-lite.zip` 并解压
2. 双击 **`start.bat`**
   - 首次会自动运行 `setup.ps1`：下载 Node、llama.cpp、ComfyUI、两个底模、Qwen3-8B
   - 下载完成后浏览器自动打开 `http://127.0.0.1:34567`
3. 需要停止时双击 **`stop.bat`**（会关后端、翻译实例、ComfyUI）

### 手动分步下载

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

下载源都在 `sources.json` 里，可自行替换（例如换成自己的网盘直链）。

## 目录结构

```
image-studio/
├─ start.bat / stop.bat      # 一键启动 / 停止
├─ setup.ps1                 # 首次运行下载脚本
├─ sources.json              # 下载源配置
├─ server/                   # 后端（零 npm 依赖，Node 内置 http）
│  ├─ index.js               # 路由与业务
│  ├─ gal-image-core.js      # ComfyUI 客户端
│  ├─ tag-translate.js       # 中文→Danbooru
│  ├─ llm-service.js         # llama-server 生命周期
│  ├─ config.json            # 配置
│  └─ tag-dictionary/        # 中英词典
├─ web/                      # 单页前端（零构建）
├─ node/                     # setup 下载的便携 Node
├─ bin/                      # setup 下载的 llama-server
├─ ComfyUI/                  # setup 下载的 ComfyUI 便携版
├─ loras/                    # 随仓库附带的测试 LoRA
├─ models/llm/               # 翻译模型 gguf
└─ state/                    # 运行期：缓存、角色提示词、日志
```

## 配置

主要改 `server/config.json`：

| 键 | 说明 |
|---|---|
| `image.defaultWidth/Height` | 默认出图尺寸（1360×768） |
| `image.models[]` | 底模列表（`wai` / `noobai`），各自带 sampler/steps/cfg/negative |
| `image.outputCleanup` | 输出图清理：`afterDownload` / `maxAgeDays` / `maxFiles` |
| `image.translate.useCache` | 翻译缓存开关（排查时可关） |
| `image.llm.gpuLayers` | 翻译模型 GPU 层数（低显存自动降） |

## 常见问题

**Q：第一次启动很久？**
下载约 18 GB，取决于网速；中断后重新双击 `start.bat` 会跳过已完成的文件。

**Q：显存 8 GB 能用吗？**
能，但翻译会慢（30~60 秒/句），且翻译与生图不能同时驻留显存（程序自动互斥）。

**Q：能加自己的 LoRA 吗？**
可以，界面「LoRA 管理」直接上传 `.safetensors`，或放进 `ComfyUI/ComfyUI/models/loras`。

**Q：能加第三个底模吗？**
不支持，只认 `config.json` 里登记的两个（WAI / NoobAI）。

**Q：出图慢 / 卡住？**
高清 1080p + LoRA 单张 65~80 秒属正常；按钮上有计时。报「任务丢失 / 执行失败」重试或降分辨率。

## 版权与许可

- 本仓库代码：MIT
- ComfyUI：GPL-3.0（由 setup 从官方发布页下载）
- llama.cpp：MIT
- Node.js：MIT / 二进制内含 OpenSSL 等许可
- WAI Illustrious / NoobAI / Qwen3-8B-Heretic：各自模型许可，**由 setup 从 HuggingFace 镜像获取，本仓库不再分发**
- 测试 LoRA（Kohana_1_nai-000026）：作者自训练并随本仓库提供；其它 LoRA 请自行确认作者许可

本仓库只提供下载脚本与代码，模型文件的许可与使用限制请遵守各自发布页。仅供个人学习与测试使用。

## 致谢

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [Qwen](https://huggingface.co/Qwen)
- WAI / NoobAI 的模型作者
