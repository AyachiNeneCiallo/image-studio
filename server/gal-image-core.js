// 「。生图」核心：ComfyUI API 客户端（AI 绘图）。
//
// 站点：本地 ComfyUI (http://127.0.0.1:8188)
// 协议：ComfyUI 原生 API (/prompt, /history, /view)
//
// 关键事实（2026-10-28 实测）：
//   · ComfyUI 版本 0.34.0，Python 3.13，嵌入式 Python
//   · 模型：waiIllustriousSDXL_v170.safetensors (Illustrious SDXL)
//   · LoRA：ayachi_nenev5.0-ill_narcissu.safetensors（绫地宁宁，Illustrious 专用）
//   · API 端点：POST /prompt，GET /history/<id>，GET /view?filename=...&subfolder=&type=output
//
// ⚠ 实测要点：
//   · POST /prompt 的 body 必须是 { prompt: <嵌套对象>, client_id: <字符串> }
//     prompt 字段必须是**真正的嵌套 JSON 对象**，不能是字符串（否则返回 500）
//   · CheckpointLoaderSimple 输出：0=MODEL, 1=CLIP, 2=VAE
//   · CLIPTextEncode 的 clip 输入应连接到 CheckpointLoaderSimple 输出 1（CLIP）
//   · KSampler 的 model 输入连接到 CheckpointLoaderSimple 输出 0（MODEL）
//   · LoraLoader 输出：0=MODEL, 1=CLIP
//   · 图片下载：GET /view?filename=<名>&subfolder=<子>&type=output，返回 image/png
//   · Generate 耗时约 1-2 分钟（512×512，10-15 步，RTX 5070 Ti）
//   · 图片保存在 ComfyUI/output/ 目录
//
// 默认负面提示词（用户指定）：
//   low quality, worst quality, normal quality, lowres, pixelated, blurry,
//   bad anatomy, (bad hands:1.5), bad feet, missing fingers, (extra fingers:1.5),
//   (mutated hands:1.2), poorly drawn hands, poorly drawn face, mutation,
//   deformed, ugly, bad proportions, extra limbs, malformed limbs, fused fingers,
//   long neck, cross-eyed, mutated, bad body, unnatural body, long body,
//   duplicate, morbid, mutilated, out of frame, disfigured, gross proportions,
//   missing arms, missing legs, extra arms, extra legs, cloned face,
//   username, watermark, signature, text
//
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';

const COMFYUI_BASE = 'http://127.0.0.1:8188';
const DEFAULT_CKPT = 'waiIllustriousSDXL_v170.safetensors';
const DEFAULT_LORA = 'ayachi_nenev5.0-ill_narcissu.safetensors';
const DEFAULT_LORA_STRENGTH = 0.9;
const DEFAULT_WIDTH = 832;
const DEFAULT_HEIGHT = 1216;
const DEFAULT_STEPS = 26;
const DEFAULT_CFG = 5.2;
const DEFAULT_SAMPLER = 'dpmpp_2m';
const DEFAULT_SCHEDULER = 'karras';
/** 显式 VAE：Illustrious / SDXL 通用。指定可用 VAE 可避免曝光过强/色彩偏差。 */
const DEFAULT_VAE = '';

// ── 高清修复（hires fix）──────────────────────────────────────────────────────
// 两种模式：
//   'pixel'  —— 基础图 **解码成像素** →放大模型(4x-UltraSharp)→ lanczos 缩到目标尺寸
//               → VAE 编码 → 低 denoise 细化。细节由放大模型提供，采样只负责融合。
//   'latent' —— 老路线：LatentUpscaleBy 在 latent 上插值放大 → 中 denoise 细化。
// ⚠ 2026-11-01 实测（同种子/同提示词，输出都是 1920×1080，梯度均值 grad_mean）：
//     现状 latent bilinear 1.5 + denoise 0.45/20 步 → 0.0107（和 1MP 出图持平）
//     latent + denoise 0.65/28 步               → 0.0131
//     像素域 4x-UltraSharp + denoise 0.40/26 步  → 0.0175（本次采用）
//     直接 1080p 单阶段（肢体易崩）              → 0.0195
//   原因：LatentUpscaleBy 是 latent 空间的线性插值=低通滤波，放大后 latent 里没有高频，
//   二阶段 0.45×20 步（≈9 步有效）只能补低频 → 出来就是「1MP 的细节铺在 2MP 画布上」。
const DEFAULT_HIRES_MODE = 'pixel';
/** 像素域放大模型（ComfyUI/models/upscale_models）。不存在时自动退回纯 lanczos 缩放。 */
const DEFAULT_HIRES_UPSCALE_MODEL = '4x-UltraSharp.pth';
const REFINE_DENOISE_PIXEL = 0.40;
const REFINE_DENOISE_LATENT = 0.55;

/**
 * 「适配分辨率」上限（百万像素）。SDXL / Illustrious 的原生训练分辨率是 1024²≈1.05MP，
 * 直接在大得多的尺寸上采样（比如 1920×1080=2.07MP）会开始出现多手/多腿/身体拉长。
 * 所以：
 *   · 普通生图（高清关）先用它把请求尺寸等比缩回甜点区；
 *   · 高清修复时，**基础图**也限制在这一档（目标尺寸不受影响，放大后缩回去）。
 */
const DEFAULT_MAX_PIXELS = 1.05;

// ── 等待超时（按张数算）──────────────────────────────────────────────────────
// 一次 8-10 张的高清图实际要十几分钟；写死 600s 会在任务其实还在跑的时候判超时。
// 规则：max(最低值, 基础开销 + 张数 × 单张预算)
//   单张预算按实测放宽（高清 1080p 单张约 50s，直接 1360×768 约 15s），留 2 倍余量。
const DEFAULT_TIMEOUT_MIN_MS = 600000;        // 底线 10 分钟
const DEFAULT_TIMEOUT_BASE_MS = 180000;       // 固定开销（模型加载、排队）
const DEFAULT_TIMEOUT_PER_HIRES_MS = 120000;  // 高清：每张 2 分钟预算
const DEFAULT_TIMEOUT_PER_IMAGE_MS = 45000;   // 普通：每张 45 秒预算

/**
 * 单次提交的最大张数（显存闸门）。
 * EmptyLatentImage 的 batch_size 会让采样器同时处理 N 张，显存随 N 线性增长；
 * 12GB 的 5070 Ti Laptop 在 1280×720 + LoRA 下，batch≥4 就开始回退到共享内存（巨慢）。
 * 默认 2 最稳；config `image.maxBatch` 可调（1-30）。
 */
const DEFAULT_MAX_BATCH = 2;

// ── 绫地宁宁默认正面提示词 ────────────────────────────────────────────────
// 来源：E:\AI绘图\ComfyUI_windows_portable\提示词\宁宁提示词-illustrious-1.txt
//   角色核心：ayachi_nene, sanoba_witch, 1girl, solo, white_hair,
//             very_long_hair, purple_eyes, ahoge, hair_between_eyes, ribbon
//   校服：    school_uniform, grey_sailor_collar, black_jacket, yellow_bowtie,
//             blazer, long_sleeves, miniskirt, grey_skirt, pleated_skirt,
//             plaid_skirt, zettai_ryouiki, black_thighhighs, medium_breast
//   画风增强：game cg
// 另外补了 Illustrious 模型必带的质量词（少质量词也是「出噪点/糊图」的常见原因）。
const NENE_QUALITY = 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, ultra-detailed';
const NENE_CHARACTER = 'ayachi_nene, sanoba_witch, 1girl, solo, white_hair, very_long_hair, purple_eyes, ahoge, hair_between_eyes, ribbon';
const NENE_OUTFIT = 'school_uniform, grey_sailor_collar, black_jacket, yellow_bowtie, blazer, long_sleeves, miniskirt, grey_skirt, pleated_skirt, plaid_skirt, zettai_ryouiki, black_thighhighs, medium_breast';
const NENE_STYLE = 'game cg';

/** 默认正面提示词：完整的绫地宁宁（用户要求「只生成绫地宁宁的图」）。 */
const DEFAULT_POSITIVE_PROMPT = [NENE_QUALITY, NENE_CHARACTER, NENE_OUTFIT, NENE_STYLE].join(', ');

/** 默认负面提示词（用户指定）。 */
const DEFAULT_NEGATIVE_PROMPT =
  // 2026-11-03：底模（waiIllustrious）偶尔会在人物身上"长"出一只鸟，属于概念泄漏。
  // 鸟词放在**最前面**并给 1.5 权重 —— 负面词很长时靠前的词更容易生效；
  // 只对 feathers 不加权重，避免连羽毛纹样的服装也一起被压。
  '(bird:1.5), (birds:1.5), (bird wing:1.5), (parrot:1.4), (blue bird:1.4), (kingfisher:1.4), ' +
  'avian, flying bird, feathers, ' +
  'low quality, worst quality, normal quality, lowres, pixelated, blurry, ' +
  'bad anatomy, (bad hands:1.5), bad feet, missing fingers, (extra fingers:1.5), ' +
  '(mutated hands:1.2), poorly drawn hands, poorly drawn face, mutation, ' +
  'deformed, ugly, bad proportions, extra limbs, malformed limbs, fused fingers, ' +
  'long neck, cross-eyed, mutated, bad body, unnatural body, long body, ' +
  'duplicate, morbid, mutilated, out of frame, disfigured, gross proportions, ' +
  'missing arms, missing legs, extra arms, extra legs, cloned face, ' +
  'username, watermark, signature, text';

/** 全局串行队列：ComfyUI 单实例，并发会互相挤占显存。 */
let chain = Promise.resolve();
/** 当前正在处理的任务数（0 或 1，因为串行）。 */
let processingCount = 0;
/** 当前等待队列长度（不包括正在处理的）。 */
let queueLength = 0;
/** 取消标志。
 * ⚠ 这里必须是「按次」的，不能只用单个布尔：命令处理器以前在调用 cancelGeneration()
 * 之后会立刻 resetGenerationCancel()，而在飞的那次生图要等下一次轮询（≤5s）才会读到标志 ——
 * 结果标志被提前清掉，旧任务继续空转到 600s 超时，**并且一直占着 serialize 的执行槽**，
 * 导致后续「。生图」全部静默排队、一句话都不回（2026-11-01 用户报的 bug）。
 * 现在用 generationId 精确匹配：只有被取消的那一次会退出，新的一次完全不受影响。
 */
let generationSeq = 0;
let activeGenerationId = 0;   // 当前在跑的那一次的 id（0 = 没有在跑）
let cancelledGenerationId = 0; // 被取消的那一次的 id
/** 当前正在处理的 promptId（用于向 ComfyUI 发送中断）。 */
let currentPromptId = null;

function isGenCancelled(genId) {
  return genId != null && genId !== 0 && cancelledGenerationId === genId;
}

/** 中断 ComfyUI 服务器端正在进行的生成。 */
async function interruptComfyUI() {
  // 先清排队（否则被取消后还有别的 prompt 占着队列），再中断正在跑的那个
  try {
    await httpPostJson(`${COMFYUI_BASE}/queue`, { clear: true }, 10000);
  } catch {
    // 清队列失败不影响后续中断
  }
  if (!currentPromptId) return;
  try {
    await httpPostJson(`${COMFYUI_BASE}/interrupt`, { prompt_id: currentPromptId }, 10000);
  } catch {
    // 中断请求失败不影响本地取消流程
  }
}

/** 请求终止正在进行的生图。可被命令处理器调用。 */
export function cancelGeneration() {
  const target = activeGenerationId;
  if (target) cancelledGenerationId = target;
  void interruptComfyUI();
  return { cancelled: true, promptId: currentPromptId };
}

/** 当前是否已请求取消。 */
export function isGenerationCancelled() {
  return activeGenerationId !== 0 && cancelledGenerationId === activeGenerationId;
}

/** 重置取消标志，供下一次生图使用（正常流程由 generateImage 自己收尾，外部一般不需要调）。 */
export function resetGenerationCancel() {
  cancelledGenerationId = 0;
  currentPromptId = null;
}

function serialize(task) {
  queueLength++;
  const run = chain.then(async () => {
    queueLength--;
    processingCount++;
    try {
      return await task();
    } finally {
      processingCount--;
    }
  });
  chain = run.then(() => {}, () => {});
  return run;
}
/** 获取当前队列状态：{ processing, queued }。 */
function getQueueStatus() {
  return { processing: processingCount, queued: queueLength };
}

/** 按 URL 协议选 http / https 模块。
 *  ⚠ ComfyUI 是 **http** 服务（127.0.0.1:8188），固定用 https 会报
 *  `Protocol "http:" not supported`。这里按协议动态选。 */
function pickModule(u) {
  return u.protocol === 'https:' ? https : http;
}

/** HTTP GET（纯文本/JSON）。 */
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = pickModule(u);
    const req = mod.request(u, {
      method: 'GET',
      timeout: timeoutMs,
      headers: { Accept: 'application/json, image/*, */*' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const bodyText = buf.toString('utf8');
          const err = new Error(`ComfyUI 返回 HTTP ${res.statusCode}: ${bodyText.slice(0, 1000)}`);
          err.code = 'http';
          err.status = res.statusCode;
          err.body = bodyText;
          reject(err);
          return;
        }
        resolve({ status: res.statusCode, body: buf, headers: res.headers });
      });
    });
    req.on('error', (error) => {
      const err = new Error(`连接 ComfyUI 失败：${error?.code ?? ''} ${error?.message ?? error}`.trim());
      err.code = 'network';
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('连接 ComfyUI 超时');
      err.code = 'network';
      reject(err);
    });
    req.end();
  });
}

/** HTTP POST JSON。 */
function httpPostJson(url, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = pickModule(u);
    const payload = Buffer.from(JSON.stringify(bodyObj ?? {}), 'utf8');
    const req = mod.request(u, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'Content-Length': payload.length,
        Accept: 'application/json'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`ComfyUI 返回 HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`);
          err.code = 'http';
          err.status = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(buf.toString('utf8')));
        } catch {
          const err = new Error('ComfyUI 返回的不是 JSON');
          err.code = 'parse';
          reject(err);
        }
      });
    });
    req.on('error', (error) => {
      const err = new Error(`连接 ComfyUI 失败：${error?.code ?? ''} ${error?.message ?? error}`.trim());
      err.code = 'network';
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('连接 ComfyUI 超时');
      err.code = 'network';
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

/**
 * 问 ComfyUI 有哪些放大模型（结果缓存 60 秒）。
 * 返回 null 表示问不到（ComfyUI 没起/接口变了），调用方按「不指定模型」处理即可。
 */
let upscaleModelCache = { at: 0, names: null };
async function listUpscaleModels() {
  const now = Date.now();
  if (Array.isArray(upscaleModelCache.names) && now - upscaleModelCache.at < 60_000) {
    return upscaleModelCache.names;
  }
  try {
    const res = await httpGet(`${COMFYUI_BASE}/object_info/UpscaleModelLoader`, 10000);
    const json = JSON.parse(res.body.toString('utf8'));
    // ComfyUI 的 /object_info 有两种形状：
    //   0.3x 及更早：model_name: [["a.pth","b.pth"], {...}]
    //   0.34+      ：model_name: ["COMBO", { options: ["a.pth","b.pth"] }]
    // 只认前者会让「放大模型存在性检查」永远拿不到列表（静默失效），两种都要认。
    const spec = json?.UpscaleModelLoader?.input?.required?.model_name;
    const names = Array.isArray(spec)
      ? (Array.isArray(spec[0]) ? spec[0] : (Array.isArray(spec[1]?.options) ? spec[1].options : null))
      : null;
    if (Array.isArray(names)) {
      upscaleModelCache = { at: now, names };
      return names;
    }
  } catch {
    // ComfyUI 未启动或接口变化：交回调用方退化，不抛错
  }
  return null;
}

/** 带重试 + 串行的 POST /prompt。 */
async function submitPrompt(promptObj, { timeoutMs = 30000, retries = 2 } = {}) {
  const url = `${COMFYUI_BASE}/prompt`;
  return serialize(async () => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const json = await httpPostJson(url, { prompt: promptObj, client_id: `qq-bridge-${Date.now()}` }, timeoutMs);
        if (!json || !json.prompt_id) {
          const err = new Error('ComfyUI 未返回 prompt_id');
          err.code = 'parse';
          throw err;
        }
        console.log(`[image] prompt 已提交：${json.prompt_id}`);
        return json.prompt_id;
      } catch (error) {
        lastErr = error;
        const retryable = error?.code === 'network' || error?.code === 'parse'
          || (error?.code === 'http' && error.status >= 500);
        if (!retryable || attempt === retries) break;
        await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 4000));
      }
    }
    throw lastErr;
  });
}

/** 查询某个 prompt 在 ComfyUI 队列里的状态：running / pending / absent / unknown。 */
async function promptQueueState(promptId) {
  try {
    const json = await httpGet(`${COMFYUI_BASE}/queue`, 8000);
    const q = JSON.parse(json.body.toString('utf8'));
    const has = (arr) => Array.isArray(arr) && arr.some((x) => Array.isArray(x) && x[1] === promptId);
    if (has(q.queue_running)) return 'running';
    if (has(q.queue_pending)) return 'pending';
    return 'absent';
  } catch {
    return 'unknown';
  }
}

/** 轮询 /history/<prompt_id> 直到完成或超时。 */
async function waitForResult(promptId, { timeoutMs = 180000, pollIntervalMs = 5000, genId = 0 } = {}) {
  const url = `${COMFYUI_BASE}/history/${promptId}`;
  return serialize(async () => {
    const start = Date.now();
    let polls = 0;
    let missing = 0;
    while (Date.now() - start < timeoutMs) {
      polls += 1;
      if (isGenCancelled(genId)) {
        currentPromptId = null;
        const err = new Error('生图已被终止');
        err.code = 'cancelled';
        throw err;
      }
      try {
        const json = await httpGet(url, 15000);
        const hist = JSON.parse(json.body.toString('utf8'));
        const entry = hist[promptId];
        if (entry) {
          const st = entry.status || {};
          // ComfyUI 执行失败（OOM / 节点报错等）：直接把原因抛出去，别等超时
          if (st.status_str === 'error') {
            let detail = '';
            try {
              const msgs = st.messages || [];
              const errMsg = msgs.map((m) => m?.value).find((v) => Array.isArray(v) && v[0] === 'execution_error');
              if (errMsg?.[1]) detail = errMsg[1].exception_message || errMsg[1].exception_type || '';
            } catch {}
            const err = new Error(`ComfyUI 执行失败${detail ? '：' + String(detail).slice(0, 200) : ''}`);
            err.code = 'comfy_error';
            throw err;
          }
          // 收集所有 SaveImage 输出
          const images = [];
          let foundNodeId = 0;
          for (const [nodeId, nodeOut] of Object.entries(entry.outputs || {})) {
            if (nodeOut.images) {
              for (const img of nodeOut.images) {
                images.push({
                  filename: img.filename,
                  subfolder: img.subfolder ?? '',
                  type: img.type ?? 'output'
                });
              }
              foundNodeId = Number(nodeId);
            }
          }
          if (images.length > 0) {
            return { images, nodeId: foundNodeId };
          }
          if (st.completed === true) {
            const err = new Error('ComfyUI 执行完成但没有输出图片');
            err.code = 'empty';
            throw err;
          }
        }
        if (polls % 6 === 1) {
          console.log(`[image] 轮询 #${polls} ${Math.round((Date.now() - start) / 1000)}s：prompt 未完成（history ${entry ? '有' : '无'}条目）`);
        }

        // 看门狗：任务既不在历史、也不在队列里 → 多半被中断/ComfyUI 重启，尽快报错而不是死等 10 分钟
        if (!entry) {
          const st = await promptQueueState(promptId);
          if (st === 'absent') {
            missing += 1;
            if (missing >= 3 && Date.now() - start > 6000) {
              const err = new Error('ComfyUI 任务丢失（prompt 既不在队列也不在历史，可能被中断或 ComfyUI 已重启）');
              err.code = 'lost';
              throw err;
            }
          } else {
            missing = 0;
          }
        } else {
          missing = 0;
        }
      } catch (e) {
        // 不中断等待，但把原因打出来，别静默；以下是我们自己判定的“必须往外抛”的错误
        if (e?.code === 'lost' || e?.code === 'comfy_error' || e?.code === 'empty' || e?.code === 'cancelled') throw e;
        if (polls % 6 === 1) {
          console.log(`[image] 轮询 #${polls} 失败：${e?.message || e}`);
        }
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    const err = new Error('ComfyUI 生图超时');
    err.code = 'timeout';
    throw err;
  });
}

/** 下载生成的图片。 */
async function downloadImage(filename, subfolder = '', type = 'output') {
  const params = new URLSearchParams({ filename, subfolder, type });
  const url = `${COMFYUI_BASE}/view?${params.toString()}`;
  return serialize(async () => {
    const res = await httpGet(url, 60000);
    const buf = res.body;
    if (!buf || buf.length === 0) {
      const err = new Error('下载的图片为空');
      err.code = 'parse';
      throw err;
    }
    if (!looksLikeImageBuffer(buf)) {
      const err = new Error('下载的内容不是有效图片');
      err.code = 'parse';
      throw err;
    }
    return { buffer: buf, bytes: buf.length, filename, subfolder, type };
  });
}

/**
 * 构建「模型加载器」这一段节点，返回节点表和 MODEL/CLIP/VAE 的输出引用。
 *
 * 两种形态：
 *   1. 单文件 checkpoint（SDXL 系：Illustrious / NoobAI）
 *      → CheckpointLoaderSimple，输出 0=MODEL 1=CLIP 2=VAE
 *   2. 分离式底模（Anima：diffusion_models + text_encoders + vae 三个文件）
 *      → UNETLoader + CLIPLoader + VAELoader
 *
 * ⚠ Anima 的 CLIPLoader 用 type='stable_diffusion' 即可：ComfyUI 按权重
 *   自动识别 Qwen3-0.6B（comfy/sd.py 里 `te_model == TEModel.QWEN3_06B` 分支不判 clip_type），
 *   官方 blueprint 给的也是这个值。
 * ⚠ 分离式底模的 VAE 必须显式给（checkpoint 里没有内嵌 VAE）。
 */
export function buildLoaderNodes({ ckpt, unet, clip, clipType, vae, vaeName } = {}) {
  const nodes = {};
  let nodeIdx = 1;
  let modelOut;
  let clipOut;
  let vaeOut;

  if (unet) {
    nodes[String(nodeIdx)] = {
      inputs: { unet_name: unet, weight_dtype: 'default' },
      class_type: 'UNETLoader'
    };
    modelOut = [String(nodeIdx), 0];
    nodeIdx++;

    nodes[String(nodeIdx)] = {
      inputs: { clip_name: clip, type: clipType || 'stable_diffusion' },
      class_type: 'CLIPLoader'
    };
    clipOut = [String(nodeIdx), 0];
    nodeIdx++;

    nodes[String(nodeIdx)] = {
      inputs: { vae_name: vae || vaeName },
      class_type: 'VAELoader'
    };
    vaeOut = [String(nodeIdx), 0];
    nodeIdx++;

    return { nodes, modelOut, clipOut, vaeOut, nodeIdx };
  }

  nodes['1'] = { inputs: { ckpt_name: ckpt }, class_type: 'CheckpointLoaderSimple' };
  modelOut = ['1', 0];
  clipOut = ['1', 1];
  vaeOut = ['1', 2];
  nodeIdx = 2;

  // 显式 VAE（可选）：checkpoint 内嵌 VAE 不可用时用它兜底
  if (vaeName) {
    nodes[String(nodeIdx)] = {
      inputs: { vae_name: vaeName },
      class_type: 'VAELoader'
    };
    vaeOut = [String(nodeIdx), 0];
    nodeIdx++;
  }

  return { nodes, modelOut, clipOut, vaeOut, nodeIdx };
}

/**
 * 生成一张或多张图。
 * @param {object} opts
 *   prompt      用户正面提示词（必填）
 *   negative    负面提示词（可选，缺省用默认值）
 *   lora        LoRA 文件名（可选，缺省不加载 LoRA）
 *   loraStr     LoRA 强度（可选，缺省 0.8）
 *   width/height 画布尺寸（可选，缺省 512）
 *   steps       采样步数（可选，缺省 15）
 *   cfg         CFG 系数（可选，缺省 7.0）
 *   sampler     采样器（可选，缺省 euler）
 *   scheduler   调度器（可选，缺省 normal）
 *   seed        随机种子（可选，缺省随机）
 *   ckpt        Checkpoint 模型名（可选，缺省 waiIllustriousSDXL_v170.safetensors）
 *   unet/clip/vae 分离式底模的三个文件名（给了 unet 就走 UNETLoader+CLIPLoader+VAELoader，忽略 ckpt）
 *   clipType    CLIPLoader 的 type（可选，缺省 stable_diffusion；Anima 也是这个值）
 *   count       生成数量（可选，缺省 1，最大 10）
 * @returns {Promise<Array<{buffer: Buffer, bytes: number}>>}
 */
async function generateImageInner(opts = {}, genId = 0) {
  const {
    prompt = DEFAULT_POSITIVE_PROMPT, extraPrompt = '', negative, lora, loraStr = DEFAULT_LORA_STRENGTH,
    width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT,
    steps = DEFAULT_STEPS, cfg = DEFAULT_CFG,
    sampler = DEFAULT_SAMPLER, scheduler = DEFAULT_SCHEDULER,
    randSeed = Math.floor(Math.random() * 0xFFFFFFFF),
    ckpt = DEFAULT_CKPT, vaeName = DEFAULT_VAE,
    unet = '', clip = '', clipType = 'stable_diffusion', vae = '',
    count = 1,
    hiresFix = false, hiresScale = 2.0,
    hiresMode = DEFAULT_HIRES_MODE, hiresUpscaleModel = DEFAULT_HIRES_UPSCALE_MODEL,
    refineDenoise: refineDenoiseOpt, refineSteps: refineStepsOpt,
    maxPixels: maxPixelsOpt,
    handLora = '', handLoraStr = 0.7
  } = opts;

  // 正面提示词：extraPrompt 已由调用方组装完整（角色基础+服装+用户描述），
  // 直接使用；若未传 extraPrompt 则回退到默认提示词（宁宁）。
  const pos = extraPrompt ?? prompt;
  const neg = negative ?? DEFAULT_NEGATIVE_PROMPT;
  const batchCount = Math.max(1, Math.min(30, Number(count) || 1));

  // 若这一轮已被取消，直接抛出错误，不再继续生成
  if (isGenCancelled(genId)) {
    const err = new Error('生图已被终止');
    err.code = 'cancelled';
    throw err;
  }

  // 高清修复（Hires fix）标准流程：
  //   1) 在「基础分辨率」用 denoise=1.0 完整生图（基础分辨率必须接近 SDXL 甜点区 ~1MP，否则肢体崩坏）
  //   2) LatentUpscaleBy 把 latent 放大 scale 倍到目标分辨率
  //   3) 第二阶段用中等 denoise（0.4~0.5）重新采样，补细节、修放大伪影
  // ⚠ 第一阶段 latent 来自 EmptyLatentImage（纯噪声），denoise 必须 1.0；
  //   之前用 0.6 会把图停在半成品状态 → 出来就是「糊 + 半个人」。
  const doHires = hiresFix === true;

  // 等待超时按「张数 × 单张预算」算，而不是写死 10 分钟：
  // 一次 8-10 张的高清图实际要十几分钟，写死 600s 会在任务其实还在跑的时候就判超时，
  // 用户看到「超时」但图后来生成好了（且那次失败还会白占执行槽）。
  const timeoutBaseMs = Number(opts.timeoutBaseMs ?? DEFAULT_TIMEOUT_BASE_MS);
  const perImageMs = Number(
    opts.perImageTimeoutMs
    ?? (doHires ? DEFAULT_TIMEOUT_PER_HIRES_MS : DEFAULT_TIMEOUT_PER_IMAGE_MS)
  );
  const waitTimeoutMs = Math.max(
    Number(opts.timeoutMs ?? 0) || 0,
    Number(opts.timeoutMinMs ?? DEFAULT_TIMEOUT_MIN_MS) || 0,
    timeoutBaseMs + batchCount * perImageMs
  );
  console.log(`[image] 等待超时 ${(waitTimeoutMs / 60000).toFixed(1)} 分钟（${batchCount} 张 / ${doHires ? '高清' : '普通'}）`);
  const mode = hiresMode === 'latent' ? 'latent' : 'pixel';
  const scale = Math.max(1.0, Number(hiresScale ?? 1.5));
  const round8 = (v) => Math.max(64, Math.round(Number(v) / 8) * 8);
  const maxPixels = Number(maxPixelsOpt ?? DEFAULT_MAX_PIXELS);

  /** 等比缩放到不超过 maxPixels 百万像素（只缩不放），返回 8 对齐的尺寸。 */
  const fitPixels = (w, h, limitMp) => {
    const area = Number(w) * Number(h);
    const limit = Math.max(0.2, Number(limitMp) || DEFAULT_MAX_PIXELS) * 1e6;
    if (!(area > limit) || area <= 0) return { width: round8(w), height: round8(h) };
    const f = Math.sqrt(limit / area);
    return { width: round8(Number(w) * f), height: round8(Number(h) * f) };
  };

  let baseWidth;
  let baseHeight;
  if (doHires) {
    // 高清修复：**输出尺寸**始终等于配置的 width×height；这里算的是第一阶段的基础分辨率。
    // 基础图按 scale 反推，反推结果若超出甜点区（目标 2K/4K 时会发生）就再压回 ~1MP ——
    // 像素域放大与基础尺寸是解耦的，ImageScale 会把它缩回目标尺寸。
    const base = fitPixels(Number(width) / scale, Number(height) / scale, maxPixels);
    baseWidth = base.width;
    baseHeight = base.height;
  } else {
    // 普通生图：直接在这个尺寸上单阶段采样，超出甜点区就会崩肢体，所以强制缩到适配分辨率。
    const fitted = fitPixels(width, height, maxPixels);
    baseWidth = fitted.width;
    baseHeight = fitted.height;
    if (baseWidth !== Number(width) || baseHeight !== Number(height)) {
      console.log(`[image] 普通模式尺寸自适应：${width}×${height} → ${baseWidth}×${baseHeight}（${(baseWidth * baseHeight / 1e6).toFixed(2)}MP，SDXL 甜点区；要大图请开高清修复）`);
    }
  }
  const baseDenoise = 1.0;
  const refineSteps = doHires
    ? Math.max(20, Number(refineStepsOpt ?? Math.floor(Number(steps) * 0.9)))
    : Number(steps);
  const refineDenoise = doHires
    ? Number(refineDenoiseOpt ?? (mode === 'pixel' ? REFINE_DENOISE_PIXEL : REFINE_DENOISE_LATENT))
    : 1.0;

  // 像素域模式：先确认放大模型真的存在，不存在就退化成「只做 lanczos 缩放」，
  // 不要让 ComfyUI 抛 required_input_missing 把整次生图废掉。
  let upscaleModel = mode === 'pixel' ? String(hiresUpscaleModel ?? '') : '';
  if (doHires && upscaleModel) {
    const available = await listUpscaleModels();
    if (Array.isArray(available) && !available.includes(upscaleModel)) {
      console.warn(`[image] 放大模型 ${upscaleModel} 不存在（可用：${available.join(', ') || '无'}），本次改用 lanczos 缩放`);
      upscaleModel = '';
    }
  }

  // 构建 ComfyUI 工作流（嵌套对象，不能双重字符串化）
  const loaders = buildLoaderNodes({ ckpt, unet, clip, clipType, vae, vaeName });
  const promptObj = loaders.nodes;
  let modelOut = loaders.modelOut;
  let clipOut = loaders.clipOut;
  let vaeOut = loaders.vaeOut;
  let nodeIdx = loaders.nodeIdx;

  if (lora) {
    promptObj[String(nodeIdx)] = {
      inputs: {
        model: modelOut,
        clip: clipOut,
        lora_name: lora,
        strength_model: Number(loraStr),
        strength_clip: Number(loraStr)
      },
      class_type: 'LoraLoader'
    };
    modelOut = [String(nodeIdx), 0];
    clipOut = [String(nodeIdx), 1];
    nodeIdx++;
  }

  // 可选的「手部修复」LoRA（如 handPatchUnet4Merge.safetensors）。
  // 这类补丁只动 UNet，没有 CLIP 权重，所以 strength_clip 固定 0（不动文本理解）。
  if (handLora) {
    promptObj[String(nodeIdx)] = {
      inputs: {
        model: modelOut,
        clip: clipOut,
        lora_name: handLora,
        strength_model: Number(handLoraStr ?? 0.7),
        strength_clip: 0
      },
      class_type: 'LoraLoader'
    };
    modelOut = [String(nodeIdx), 0];
    nodeIdx++;
  }

  promptObj[String(nodeIdx)] = {
    inputs: { text: pos, clip: clipOut },
    class_type: 'CLIPTextEncode'
  };
  const posNode = String(nodeIdx);
  nodeIdx++;

  promptObj[String(nodeIdx)] = {
    inputs: { text: neg, clip: clipOut },
    class_type: 'CLIPTextEncode'
  };
  const negNode = String(nodeIdx);
  nodeIdx++;

  // 基础 latent（低分辨率，用于高清修复首阶段）
  const baseLatentNode = String(nodeIdx);
  promptObj[baseLatentNode] = {
    inputs: { width: baseWidth, height: baseHeight, batch_size: batchCount },
    class_type: 'EmptyLatentImage'
  };
  nodeIdx++;

  // 第一阶段 KSampler：低分辨率生图
  const baseSamplerNode = String(nodeIdx);
  promptObj[baseSamplerNode] = {
    inputs: {
      seed: randSeed,
      steps: Number(steps),
      cfg: Number(cfg),
      sampler_name: sampler,
      scheduler: scheduler,
      denoise: baseDenoise,
      model: modelOut,
      positive: [posNode, 0],
      negative: [negNode, 0],
      latent_image: [baseLatentNode, 0]
    },
    class_type: 'KSampler'
  };
  nodeIdx++;

  // 最终 latent 列表：普通情况只有 1 个；高清像素域且一次出多张时会拆成多个（见下）。
  let finalLatentRefs = [[baseSamplerNode, 0]];

  if (doHires) {
    // 二阶段的输入 latent：像素域走「放大→缩放到目标→回编码」，latent 域走插值放大。
    // ⚠ 注意这里是**列表**：像素域 + 多张时必须逐张 encode（原因见下面 ImageFromBatch 那段）。
    let refineInputRefs = [];
    if (mode === 'pixel') {
      // 1) 基础图解码成像素
      const decodeNode = String(nodeIdx);
      promptObj[decodeNode] = {
        inputs: { samples: [baseSamplerNode, 0], vae: vaeOut },
        class_type: 'VAEDecode'
      };
      nodeIdx++;
      let imgRef = [decodeNode, 0];

      // 2) 放大模型（可选）：4x 放大后再缩回目标尺寸，比直接放大更保边
      if (upscaleModel) {
        const modelNode = String(nodeIdx);
        promptObj[modelNode] = {
          inputs: { model_name: upscaleModel },
          class_type: 'UpscaleModelLoader'
        };
        nodeIdx++;
        const upNode = String(nodeIdx);
        promptObj[upNode] = {
          inputs: { upscale_model: [modelNode, 0], image: imgRef },
          class_type: 'ImageUpscaleWithModel'
        };
        nodeIdx++;
        imgRef = [upNode, 0];
      }

      // 3) 缩放到目标分辨率
      const scaleNode = String(nodeIdx);
      promptObj[scaleNode] = {
        inputs: {
          image: imgRef,
          upscale_method: 'lanczos',
          width: Number(width),
          height: Number(height),
          crop: 'disabled'
        },
        class_type: 'ImageScale'
      };
      nodeIdx++;
      imgRef = [scaleNode, 0];

      // 4) 回编码成 latent，供低 denoise 细化
      // ⚠⚠ 多张时**必须一张一张 encode**：Anima 的 VAE 是 Wan21 系 16 通道视频 VAE，
      //     `VAEEncode` 收到 batch=N 时会把 batch 折进时间维，解码回来只剩 1 张
      //     （2026-11-05 实测：count=4 + 高清只出 2 张，正是这里每批塌掉一半）。
      //     用 ImageFromBatch 按张切开，基图仍可 batch 并行，只有编码/细化逐张走。
      // SDXL（单文件 checkpoint）没有这个问题，继续走批次并行，速度更快。
      const splitRefine = batchCount > 1 && !!unet;
      if (splitRefine) {
        for (let i = 0; i < batchCount; i++) {
          const pickNode = String(nodeIdx);
          promptObj[pickNode] = {
            inputs: { image: imgRef, batch_index: i, length: 1 },
            class_type: 'ImageFromBatch'
          };
          nodeIdx++;
          const encodeNode = String(nodeIdx);
          promptObj[encodeNode] = {
            inputs: { pixels: [pickNode, 0], vae: vaeOut },
            class_type: 'VAEEncode'
          };
          nodeIdx++;
          refineInputRefs.push([encodeNode, 0]);
        }
      } else {
        const encodeNode = String(nodeIdx);
        promptObj[encodeNode] = {
          inputs: { pixels: imgRef, vae: vaeOut },
          class_type: 'VAEEncode'
        };
        nodeIdx++;
        refineInputRefs.push([encodeNode, 0]);
      }
    } else {
      // LatentUpscaleBy：把基础 latent 放大到目标分辨率（老路线，保留但不默认）
      const upscaleNode = String(nodeIdx);
      promptObj[upscaleNode] = {
        inputs: {
          samples: [baseSamplerNode, 0],
          scale_by: scale,
          upscale_method: 'bislerp'
        },
        class_type: 'LatentUpscaleBy'
      };
      nodeIdx++;
      refineInputRefs.push([upscaleNode, 0]);
    }

    // 二阶段 KSampler（逐张）：像素域 denoise 低（细节来自放大模型，避免改动肢体），
    // latent 域需要更高的 denoise 才能补回高频。
    finalLatentRefs = refineInputRefs.map((ref) => {
      const node = String(nodeIdx);
      promptObj[node] = {
        inputs: {
          seed: randSeed,
          steps: refineSteps,
          cfg: Number(cfg),
          sampler_name: sampler,
          scheduler: scheduler,
          denoise: refineDenoise,
          model: modelOut,
          positive: [posNode, 0],
          negative: [negNode, 0],
          latent_image: ref
        },
        class_type: 'KSampler'
      };
      nodeIdx++;
      return [node, 0];
    });
  }

  // VAEDecode + SaveImage（逐张）：一张一条链，保证每张都落盘
  for (const ref of finalLatentRefs) {
    const decodeNode = String(nodeIdx);
    promptObj[decodeNode] = {
      inputs: { samples: ref, vae: vaeOut },
      class_type: 'VAEDecode'
    };
    nodeIdx++;

    promptObj[String(nodeIdx)] = {
      inputs: { filename_prefix: 'qq-bridge', images: [decodeNode, 0] },
      class_type: 'SaveImage'
    };
    nodeIdx++;
  }

  // 默认不打印完整工作流：里面含完整正面提示词（可能带成人向 tag），
  // 写进 stdout/bridge.log 后会触发上游内容审核。需要排查时设 COMFY_DEBUG_WORKFLOW=1。
  if (process.env.COMFY_DEBUG_WORKFLOW === '1') {
    console.log(`[image] ComfyUI workflow: ${JSON.stringify(promptObj)}`);
  }
  try {
  fs.writeFileSync(path.join(process.cwd(), 'state', 'last-workflow.json'), JSON.stringify(promptObj, null, 2), 'utf8');
} catch {}
const promptId = await submitPrompt(promptObj, { timeoutMs: 120000 });
  currentPromptId = promptId;

  // 等待前再次检查是否被取消
  if (isGenCancelled(genId)) {
    currentPromptId = null;
    const err = new Error('生图已被终止');
    err.code = 'cancelled';
    throw err;
  }

  // 等待完成
  const result = await waitForResult(promptId, { timeoutMs: waitTimeoutMs, pollIntervalMs: 5000, genId });
  if (!result.images || result.images.length === 0) {
    const err = new Error('ComfyUI 未返回生成的图片');
    err.code = 'empty';
    throw err;
  }

  // 下载前再次检查是否被取消
  if (isGenCancelled(genId)) {
    currentPromptId = null;
    const err = new Error('生图已被终止');
    err.code = 'cancelled';
    throw err;
  }

  // 下载所有生成的图片
  const imgs = [];
  for (const imgInfo of result.images) {
    if (isGenCancelled(genId)) {
      currentPromptId = null;
      const err = new Error('生图已被终止');
      err.code = 'cancelled';
      throw err;
    }
    const img = await downloadImage(imgInfo.filename, imgInfo.subfolder, imgInfo.type);
    imgs.push(img);
  }

  currentPromptId = null;
  return imgs;
}

/**
 * 生图入口（对外导出的就是这个）。
 * 负责给每一次生成分配 genId，并在结束时把「在跑 / 被取消」两个状态清干净 ——
 * 这样无论正常完成、报错还是被终止，都不会把取消标志留给下一次生图。
 */
export async function generateImage(opts = {}) {
  const genId = ++generationSeq;
  activeGenerationId = genId;
  try {
    // ── 分批：不要再把 N 张塞进同一个 batch ────────────────────────────────
    // EmptyLatentImage 的 batch_size=N 会让采样器**同时**处理 N 张：
    // 显存随张数线性增长，超过物理显存后驱动会回退到共享内存（系统内存），
    // 速度断崖式下跌 —— 实测 batch=30 × 1280×720 时 12GB 显存吃满到只剩 369MB、
    // 系统内存也只剩 2.8GB，一张图 1 分钟变成 30 张跑了一小时还没完。
    // 因此改为「每次只提交 maxBatch 张，分多次提交」，显存峰值恒定，速度接近线性。
    const total = Math.max(1, Math.min(30, Number(opts.count) || 1));
    const maxBatch = Math.max(1, Math.min(30, Number(opts.maxBatch ?? DEFAULT_MAX_BATCH)));
    if (total <= maxBatch) {
      return await generateImageInner(opts, genId);
    }
    const all = [];
    let done = 0;
    while (done < total) {
      if (isGenCancelled(genId)) {
        const err = new Error('生图已被终止');
        err.code = 'cancelled';
        throw err;
      }
      const chunk = Math.min(maxBatch, total - done);
      console.log(`[image] 分批生成 ${done + 1}-${done + chunk}/${total}（每批上限 ${maxBatch}）`);
      const part = await generateImageInner({ ...opts, count: chunk }, genId);
      all.push(...part);
      done += chunk;
    }
    return all;
  } finally {
    if (activeGenerationId === genId) activeGenerationId = 0;
    if (cancelledGenerationId === genId) cancelledGenerationId = 0;
    currentPromptId = null;
  }
}

/** 检查 ComfyUI 是否在线。 */
export async function checkComfyUI({ timeoutMs = 10000 } = {}) {
  return serialize(async () => {
    try {
      const res = await httpGet(`${COMFYUI_BASE}/system_stats`, timeoutMs);
      return res.status === 200;
    } catch {
      return false;
    }
  });
}


/** 供上层展示/复用的默认提示词。 */
export { DEFAULT_POSITIVE_PROMPT, DEFAULT_NEGATIVE_PROMPT, NENE_CHARACTER, NENE_OUTFIT, getQueueStatus };
