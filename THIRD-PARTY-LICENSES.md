# 第三方组件与许可

本仓库**不包含**下列组件的二进制或模型权重，`setup.ps1` 会从各自的官方发布页下载。
列出仅为合规说明。

| 组件 | 版本 / 来源 | 许可 | 说明 |
|---|---|---|---|
| Node.js | v24.22.0 / nodejs.org | MIT + 第三方（OpenSSL 等） | 便携运行时 |
| ComfyUI | comfyanonymous/ComfyUI 最新 release 便携包 | GPL-3.0 | 分发时需提供对应源码；本仓库只给下载脚本，用户自行获取 |
| llama.cpp | ggml-org/llama.cpp（Windows CUDA 构建） | MIT | 保留版权声明 |
| 7-Zip (7zr.exe) | 7-zip.org | LGPL / 商业许可混合 | 仅用于解压 |
| WAI Illustrious SDXL v170 | LyliaEngine/waiIllustriousSDXL_v170 (HF) | 继承 SDXL 系许可（OpenRAIL++ / Stability 社区许可） | 模型许可由作者定义 |
| NoobAI XL v-pred 1.0 | Laxhar/noobai-XL-Vpred-1.0 (HF) | 同上，另有作者附加条款 | 模型许可由作者定义 |
| Qwen3-8B-Heretic Q5_K_M | mradermacher/Qwen3-8B-heretic-GGUF (HF) | 继承 Qwen3（Apache-2.0）+ 社区微调条款 | **去审查微调**，由用户自行判断使用场景 |
| Kohana_1_nai-000026.safetensors | 本仓库 loras/ | 作者自训练，随仓库提供 | 仅作测试用途 |
| Danbooru 中英词典 | 社区整理 `hf_general.csv` | 见原始数据集许可 | 仅用于术语提示 |

## 说明

- 本仓库代码（`server/`、`web/`、脚本）为 MIT。
- 模型权重的版权归各自作者所有；本仓库不托管、不再分发这些文件。
- 如需再分发 ComfyUI 二进制，请自行满足 GPL-3.0 的源码提供义务。
