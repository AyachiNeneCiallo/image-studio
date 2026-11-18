// image-studio 后端 API 服务
// 零 npm 依赖：仅使用 Node.js 内置模块 + 复用 qq-bridge-plus 核心模块
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const cfgPath = path.join(root, 'server', 'config.json');
const rawCfg = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
const cfg = JSON.parse(rawCfg);

/** 把配置里的相对路径按整合包根目录解析成绝对路径。 */
function abs(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}
if (cfg.image?.translate) {
  cfg.image.translate.dictionaryPath = abs(cfg.image.translate.dictionaryPath);
  cfg.image.translate.cacheFile = abs(cfg.image.translate.cacheFile);
}
if (cfg.image?.llm) {
  cfg.image.llm.exe = abs(cfg.image.llm.exe);
  cfg.image.llm.modelPath = abs(cfg.image.llm.modelPath);
}

// ── LoRA 目录（ComfyUI 的 models/loras）──
const loraDir = path.join(root, 'ComfyUI', 'ComfyUI', 'models', 'loras');
fs.mkdirSync(loraDir, { recursive: true });

// ── ComfyUI 输出目录：清理策略 ──
// 前端拿到的是 base64，服务端 output 里的文件对用户没有用途，默认“生成完即删”，
// 再按天数/数量做一次兜底，避免长期使用把磁盘撑爆。
const outputDir = path.join(root, 'ComfyUI', 'ComfyUI', 'output');

function deleteOutputFile(file) {
  if (!file || !file.filename) return false;
  const p = path.resolve(outputDir, String(file.subfolder || ''), String(file.filename));
  if (!p.startsWith(path.resolve(outputDir))) return false; // 防目录穿越
  try {
    if (fs.existsSync(p)) { fs.rmSync(p); return true; }
  } catch {}
  return false;
}

/** 兜底清理：超过保留天数、或超出最大文件数（保留最新）的旧图。 */
function sweepOutputDir({ maxAgeDays = 7, maxFiles = 200 } = {}) {
  let removed = 0;
  let freed = 0;
  const files = [];
  try {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(png|jpe?g|webp)$/i.test(e.name)) {
          const st = fs.statSync(full);
          files.push({ full, size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    if (fs.existsSync(outputDir)) walk(outputDir);
  } catch (e) {
    console.log('[cleanup] 扫描 output 失败：', e?.message || e);
    return { removed: 0, freed: 0 };
  }
  const now = Date.now();
  const maxAgeMs = Math.max(0, Number(maxAgeDays)) * 86400000;
  const limit = Math.max(0, Number(maxFiles));
  files.sort((a, b) => b.mtime - a.mtime);
  const keep = [];
  for (const f of files) {
    const tooOld = maxAgeMs > 0 && now - f.mtime > maxAgeMs;
    const tooMany = keep.length >= limit;
    if (tooOld || tooMany) {
      try { fs.rmSync(f.full); removed += 1; freed += f.size; } catch {}
    } else {
      keep.push(f);
    }
  }
  if (removed) console.log(`[cleanup] output 清理：删除 ${removed} 张，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`);
  return { removed, freed };
}

// ── 角色提示词库（LoRA 文件名 → 提示词）──
const charPromptFile = path.join(root, 'state', 'character-prompts.json');
function readCharPrompts() {
  try {
    return JSON.parse(fs.readFileSync(charPromptFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}
function writeCharPrompts(map) {
  fs.mkdirSync(path.dirname(charPromptFile), { recursive: true });
  fs.writeFileSync(charPromptFile, JSON.stringify(map, null, 2) + '\n', 'utf8');
}

function listLoras() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(loraDir); } catch { return out; }
  for (const f of entries) {
    if (!/\.(safetensors|pt|ckpt|bin)$/i.test(f)) continue;
    try {
      const st = fs.statSync(path.join(loraDir, f));
      if (st.isFile()) out.push({ name: f, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 只取文件名，强制 .safetensors 后缀，去掉 Windows 非法字符。 */
function sanitizeLoraName(raw) {
  let n = path.basename(String(raw || '').replace(/\\/g, '/')).trim();
  if (!n) return '';
  if (!/\.(safetensors|pt|ckpt|bin)$/i.test(n)) n += '.safetensors';
  n = n.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  if (n === '.safetensors' || n === '.part') return '';
  return n;
}

// ── 复用核心模块 ──
const { createTagTranslator } = await import('./tag-translate.js');
const { createLlmService } = await import('./llm-service.js');
const {
  generateImage,
  checkComfyUI,
  cancelGeneration,
  getQueueStatus,
  resetGenerationCancel,
  DEFAULT_POSITIVE_PROMPT,
  DEFAULT_NEGATIVE_PROMPT
} = await import('./gal-image-core.js');

// ── 全局状态 ──
let translator = null;
let llmService = null;
let comfyProc = null;
let serverStarted = false;

// ── 工具函数 ──
function jsonResponse(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
        resolve(JSON.parse(text || '{}'));
      } catch (e) {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

function freeVramMiB() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {
      encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore']
    });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    const n = Number(first);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function totalVramMiB() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], {
      encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore']
    });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    const n = Number(first);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 初始化翻译层 ──
async function initTranslator() {
  if (translator) return translator;
  translator = createTagTranslator({
    cfg: { translate: cfg.image.translate },
    log: (msg) => console.log(`[translate] ${msg}`)
  });
  return translator;
}

// ── 初始化 LLM 实例（按需启动） ──
async function ensureLlm() {
  if (llmService && await llmService.isUp()) return llmService;
  if (!llmService) {
    // 根据显存大小自动调整 gpuLayers：8 GB 以下降到 16 层（CPU 推理兜底，速度慢但能跑）
    const free = freeVramMiB();
    let gpuLayers = cfg.image.llm.gpuLayers ?? 99;
    let vramNote = '';
    if (free != null && free < 10240) {
      // 显存小于 10 GB，降低 gpuLayers，避免 OOM
      gpuLayers = 16;
      vramNote = `（低显存模式：gpuLayers 降至 16，翻译速度会变慢，约 30~60 秒/句）`;
    }
    const llmCfg = { ...cfg.image.llm, gpuLayers };
    llmService = createLlmService({
      cfg: { llm: llmCfg },
      log: (msg) => console.log(`[llm] ${msg}`)
    });
    console.log(`[llm] gpuLayers=${gpuLayers}${vramNote}`);
  }
  await llmService.start();
  return llmService;
}

async function stopLlm() {
  if (llmService) {
    await llmService.stop();
    llmService = null;
  }
}

/**
 * 翻译结束后立刻释放翻译实例（不等端口释放，后台做完即可）。
 * 目的：8~12 GB 显存卡上让 ComfyUI/其它程序马上拿到显存。
 */
function releaseLlm(reason = '') {
  if (!llmService) return;
  const svc = llmService;
  llmService = null;
  svc.stop()
    .then(() => console.log(`[llm] ${reason}，翻译实例已释放`))
    .catch((e) => console.log(`[llm] 释放翻译实例失败：${e?.message || e}`));
}

// ── 检测 ComfyUI 进程 ──
function findComfyUiProcess() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq pythonw.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.includes('pythonw.exe');
  } catch {
    return false;
  }
}

async function startComfyUi() {
  // 便携版布局：ComfyUI/python_embeded/python.exe 与 ComfyUI/ComfyUI/main.py
  const portableRoot = path.join(root, 'ComfyUI');
  const codeDir = path.join(portableRoot, 'ComfyUI');
  if (!fs.existsSync(portableRoot)) {
    throw new Error(`ComfyUI 目录不存在：${portableRoot}`);
  }
  if (await checkComfyUI({ timeoutMs: 1500 })) {
    console.log('[comfyui] 已在运行，复用现有实例');
    return { reused: true };
  }
  const pythonExe = path.join(portableRoot, 'python_embeded', 'python.exe');
  const mainPy = path.join(codeDir, 'main.py');
  if (!fs.existsSync(pythonExe) || !fs.existsSync(mainPy)) {
    throw new Error(`ComfyUI 启动文件缺失：${pythonExe} 或 ${mainPy}`);
  }
  comfyProc = spawn(pythonExe, [mainPy, '--listen', '127.0.0.1', '--port', '8188'], {
    cwd: codeDir,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env }
  });
  comfyProc.on('exit', (code) => {
    if (comfyProc) console.log(`[comfyui] 退出 code=${code}`);
    comfyProc = null;
  });
  console.log('[comfyui] 正在启动…');
  // 等待就绪（冷启动可能要几分钟）
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    if (await checkComfyUI({ timeoutMs: 2000 })) {
      console.log('[comfyui] 已就绪');
      return { reused: false };
    }
    if (!comfyProc) throw new Error('ComfyUI 启动后立即退出，请检查 python 环境');
  }
  throw new Error('ComfyUI 300 秒内未就绪');
}

async function stopComfyUi() {
  if (comfyProc) {
    try { comfyProc.kill(); } catch {}
    comfyProc = null;
  }
}

// ── API 路由 ──
async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  // CORS 预检
  if (method === 'OPTIONS') {
    jsonResponse(res, 204, {});
    return;
  }

  // 健康检查
  if (pathname === '/api/status' && method === 'GET') {
    const up = translator ? true : false;
    const llmUp = llmService ? await llmService.isUp() : false;
    const comfyUp = await checkComfyUI({ timeoutMs: 1000 });
    const free = freeVramMiB();
    jsonResponse(res, 200, {
      ok: true,
      translatorReady: !!translator,
      llmReady: llmUp,
      comfyUiReady: comfyUp,
      freeVramMiB: free,
      totalVramMiB: totalVramMiB(),
      serverStarted
    });
    return;
  }

  // 翻译接口
  if (pathname === '/api/translate' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { text, autoWeight = cfg.image.translate.autoWeight !== false } = body;
      if (!text || typeof text !== 'string') {
        jsonResponse(res, 400, { error: '缺少 text 参数' });
        return;
      }
      const tr = await initTranslator();
      // 翻译需要 8081 的 llama-server：词典/缓存命中时不需要，但预检查一遍更稳
      if (tr.needsLlm(text, { autoWeight })) {
        await ensureLlm();
      }
      const result = await tr.translate(text, { autoWeight });
      jsonResponse(res, 200, {
        ok: true,
        tags: result.tags,
        cached: result.cached,
        source: result.source,
        autoWeight: result.autoWeight
      });
      // 翻译完成立刻释放翻译实例，把显存让出来（异步，不拖慢本次响应）
      releaseLlm('翻译完成');
    } catch (e) {
      console.error('[translate] 失败:', e?.message || e);
      jsonResponse(res, 500, { error: e.message || '翻译失败' });
      releaseLlm('翻译失败后');
    }
    return;
  }

  // 清空翻译缓存（普通 + 加权两套）
  if (pathname === '/api/cache/clear' && method === 'POST') {
    try {
      const tr = await initTranslator();
      const r = tr.clearCache();
      console.log(`[translate] 缓存已清空：${r.removed} 条（删除文件=${r.deleted}）`);
      jsonResponse(res, 200, { ok: true, removed: r.removed, deleted: r.deleted });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message || '清空缓存失败' });
    }
    return;
  }

  // 清理 ComfyUI 输出目录（手动触发；body 可传 maxAgeDays / maxFiles 覆盖）
  if (pathname === '/api/output/clean' && method === 'POST') {
    try {
      const body = await readBody(req);
      const base = cfg.image.outputCleanup || {};
      const r = sweepOutputDir({
        maxAgeDays: body.maxAgeDays ?? base.maxAgeDays ?? 7,
        maxFiles: body.maxFiles ?? base.maxFiles ?? 200
      });
      jsonResponse(res, 200, { ok: true, removed: r.removed, freedMB: Number((r.freed / 1024 / 1024).toFixed(1)) });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message || '清理失败' });
    }
    return;
  }

  // 生图接口
  if (pathname === '/api/generate' && method === 'POST') {
    try {
      const body = await readBody(req);
      const {
        prompt,
        extraPrompt,
        negative,
        lora,
        loraStr,
        width,
        height,
        steps,
        cfg: cfgVal,
        sampler,
        scheduler,
        count,
        hiresFix,
        hiresScale,
        hiresMode,
        randSeed,
        maxBatch,
        model: modelKey
      } = body;

      // 底模只认 config 里登记的这两个（wai / noobai），body.ckpt 一律忽略
      const models = cfg.image.models || [];
      const wantKey = String(modelKey || '').toLowerCase();
      const model = models.find((m) => m.key === wantKey)
        || models.find((m) => m.key === cfg.image.defaultModel)
        || models[0];
      if (!model) {
        jsonResponse(res, 500, { error: 'config.image.models 为空' });
        return;
      }

      // 生图前先释放翻译实例占用的显存（8 GB 显存卡上两者不能同时驻留）
      await stopLlm();
      // 确保 ComfyUI 运行
      await startComfyUi();

      const opts = {};
      if (prompt !== undefined) opts.prompt = prompt;
      if (extraPrompt !== undefined) opts.extraPrompt = extraPrompt;
      if (negative !== undefined && String(negative).trim()) opts.negative = negative;
      else if (model.negative) opts.negative = model.negative;
      if (lora !== undefined) opts.lora = lora;
      if (loraStr !== undefined) opts.loraStr = Number(loraStr);
      if (width !== undefined) opts.width = Number(width);
      if (height !== undefined) opts.height = Number(height);
      if (steps !== undefined) opts.steps = Number(steps);
      else if (model.steps !== undefined) opts.steps = Number(model.steps);
      if (cfgVal !== undefined) opts.cfg = Number(cfgVal);
      else if (model.cfg !== undefined) opts.cfg = Number(model.cfg);
      if (sampler !== undefined) opts.sampler = sampler;
      else if (model.sampler) opts.sampler = model.sampler;
      if (scheduler !== undefined) opts.scheduler = scheduler;
      else if (model.scheduler) opts.scheduler = model.scheduler;
      if (count !== undefined) opts.count = Math.max(1, Math.min(30, Number(count)));
      if (hiresFix !== undefined) opts.hiresFix = hiresFix === true;
      if (hiresScale !== undefined) opts.hiresScale = Number(hiresScale);
      if (hiresMode !== undefined) opts.hiresMode = hiresMode;
      if (randSeed !== undefined) opts.randSeed = Number(randSeed);
      opts.ckpt = model.file;
      if (maxBatch !== undefined) opts.maxBatch = Math.max(1, Math.min(30, Number(maxBatch)));

      // 底模质量词：拼在正面提示词最前面（WAI 为空，NoobAI 有 masterpiece 前缀）
      if (model.qualityTags && opts.extraPrompt && !/masterpiece/i.test(opts.extraPrompt)) {
        opts.extraPrompt = `${model.qualityTags}, ${opts.extraPrompt}`;
      }

      // ── 高清修复相关参数：config 默认 + body 可覆盖 ──
      const hiresKeys = ['hiresUpscaleModel', 'refineDenoise', 'refineSteps', 'maxPixels', 'handLora', 'handLoraStr'];
      for (const k of hiresKeys) {
        if (body[k] !== undefined) opts[k] = body[k];
        else if (cfg.image[k] !== undefined && cfg.image[k] !== '') opts[k] = cfg.image[k];
      }
      if (opts.refineDenoise !== undefined) opts.refineDenoise = Number(opts.refineDenoise);
      if (opts.refineSteps !== undefined) opts.refineSteps = Number(opts.refineSteps);
      if (opts.maxPixels !== undefined) opts.maxPixels = Number(opts.maxPixels);
      if (opts.handLoraStr !== undefined) opts.handLoraStr = Number(opts.handLoraStr);
      console.log(`[generate] model=${model.key} file=${model.file} sampler=${opts.sampler ?? '-'}/${opts.scheduler ?? '-'} steps=${opts.steps ?? '-'} cfg=${opts.cfg ?? '-'} hires=${!!opts.hiresFix} scale=${opts.hiresScale ?? '-'} upscale=${opts.hiresUpscaleModel ?? '默认'} denoise=${opts.refineDenoise ?? '默认'} maxPixels=${opts.maxPixels ?? '默认'}`);

      const imgs = await generateImage(opts);

      // 生成完即删服务端文件（浏览器已拿到 base64，output 里的图对用户没用途）
      const cleanupCfg = cfg.image.outputCleanup || {};
      if (cleanupCfg.afterDownload !== false) {
        let killed = 0;
        for (const img of imgs) if (deleteOutputFile(img)) killed += 1;
        if (killed) console.log(`[cleanup] 已删除本次生成文件 ${killed} 个`);
      }

      jsonResponse(res, 200, {
        ok: true,
        count: imgs.length,
        images: imgs.map((img, i) => ({
          index: i,
          data: img.buffer.toString('base64'),
          bytes: img.bytes ?? img.buffer.length,
          mime: 'image/png'
        }))
      });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message || '生图失败', code: e.code });
    }
    return;
  }

  // 队列状态
  if (pathname === '/api/queue' && method === 'GET') {
    jsonResponse(res, 200, {
      ok: true,
      ...getQueueStatus()
    });
    return;
  }

  // 取消生图
  if (pathname === '/api/cancel' && method === 'POST') {
    cancelGeneration();
    jsonResponse(res, 200, { ok: true, cancelled: true });
    return;
  }

  // 底模列表
  if (pathname === '/api/models' && method === 'GET') {
    jsonResponse(res, 200, {
      ok: true,
      models: cfg.image.models || [],
      current: cfg.image.defaultModel || 'wai'
    });
    return;
  }

  // 默认参数（负面提示词等），供前端预填；?model=wai|noobai 取对应底模的默认值
  if (pathname === '/api/defaults' && method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const want = String(u.searchParams.get('model') || '').toLowerCase();
    const models = cfg.image.models || [];
    const model = models.find((m) => m.key === want)
      || models.find((m) => m.key === cfg.image.defaultModel)
      || models[0]
      || {};
    jsonResponse(res, 200, {
      ok: true,
      model: model.key || '',
      negative: model.negative || DEFAULT_NEGATIVE_PROMPT,
      qualityTags: model.qualityTags || '',
      prompt: DEFAULT_POSITIVE_PROMPT,
      sampler: model.sampler || '',
      scheduler: model.scheduler || '',
      steps: model.steps ?? cfg.image.defaultSteps ?? 26,
      cfg: model.cfg ?? cfg.image.defaultCfg ?? 5.2,
      width: cfg.image.defaultWidth ?? 1360,
      height: cfg.image.defaultHeight ?? 768
    });
    return;
  }

  // ── 角色提示词库 ──
  if (pathname === '/api/character-prompts' && method === 'GET') {
    jsonResponse(res, 200, { ok: true, prompts: readCharPrompts() });
    return;
  }

  if (pathname === '/api/character-prompts' && method === 'POST') {
    try {
      const body = await readBody(req);
      const lora = String(body.lora || '').trim();
      const text = String(body.text || '').trim();
      if (!lora) {
        jsonResponse(res, 400, { error: '缺少 lora' });
        return;
      }
      const map = readCharPrompts();
      if (!text) {
        delete map[lora];
      } else {
        map[lora] = { title: String(body.title || lora.replace(/\.safetensors$/i, '')), text, updatedAt: Date.now() };
      }
      writeCharPrompts(map);
      jsonResponse(res, 200, { ok: true, prompts: map });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message || '保存失败' });
    }
    return;
  }

  // ── LoRA 管理 ──
  if (pathname === '/api/loras' && method === 'GET') {
    jsonResponse(res, 200, { ok: true, dir: loraDir, loras: listLoras() });
    return;
  }

  if (pathname === '/api/loras/upload' && method === 'POST') {
    const u = new URL(req.url, 'http://localhost');
    const name = sanitizeLoraName(u.searchParams.get('name') || '');
    if (!name) {
      jsonResponse(res, 400, { error: '文件名不合法（需要 .safetensors）' });
      return;
    }
    const dest = path.join(loraDir, name);
    const tmp = `${dest}.part`;
    let bytes = 0;
    const ws = fs.createWriteStream(tmp);
    req.on('data', (c) => { bytes += c.length; });
    req.on('aborted', () => { try { ws.destroy(); fs.rmSync(tmp, { force: true }); } catch {} });
    req.pipe(ws);
    ws.on('finish', () => {
      try {
        fs.renameSync(tmp, dest);
        console.log(`[lora] 已安装 ${name}（${(bytes / 1024 / 1024).toFixed(1)} MB）`);
        jsonResponse(res, 200, { ok: true, name, bytes });
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        jsonResponse(res, 500, { error: e.message });
      }
    });
    ws.on('error', (e) => {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      jsonResponse(res, 500, { error: e.message });
    });
    return;
  }

  if (pathname === '/api/loras/delete' && method === 'POST') {
    try {
      const body = await readBody(req);
      const name = path.basename(String(body.name || ''));
      const p = path.join(loraDir, name);
      if (!name || !fs.existsSync(p)) {
        jsonResponse(res, 404, { error: '文件不存在' });
        return;
      }
      fs.rmSync(p, { force: true });
      console.log(`[lora] 已删除 ${name}`);
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  if (pathname === '/api/loras/open' && method === 'POST') {
    const attempts = [
      { cmd: 'cmd.exe', args: ['/c', 'start', '', loraDir] },
      { cmd: 'explorer.exe', args: [loraDir] }
    ];
    for (const { cmd, args } of attempts) {
      try {
        const child = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' });
        // 必须挂 error 监听：否则 spawn 失败会抛未捕获的 'error' 事件，直接把整个后端干掉
        child.on('error', (e) => console.log(`[lora] 打开文件夹失败（${cmd}）：${e.message}`));
        child.unref();
        break;
      } catch (e) {
        console.log(`[lora] 打开文件夹失败（${cmd}）：${e.message}`);
      }
    }
    jsonResponse(res, 200, { ok: true, dir: loraDir });
    return;
  }

  // 静态文件服务（前端）
  const webRoot = path.join(root, 'web');
  let filePath = path.join(webRoot, pathname === '/' ? 'index.html' : pathname.slice(1));
  // 防止目录遍历
  if (!filePath.startsWith(webRoot + path.sep) && filePath !== webRoot) {
    jsonResponse(res, 403, { error: 'forbidden' });
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    res.end(data);
    return;
  }

  // 404
  jsonResponse(res, 404, { error: 'not found' });
}

const server = http.createServer(handleRequest);

const port = Number(process.env.IMAGE_STUDIO_PORT || cfg.server?.port || 34567);
const host = cfg.server?.host ?? '127.0.0.1';

server.listen(port, host, () => {
  console.log(`[server] image-studio 后端运行于 http://${host}:${port}`);
  serverStarted = true;
  // 启动后清理一波旧的 ComfyUI 输出（兜底，避免历史堆积）
  setTimeout(() => {
    try { sweepOutputDir(cfg.image.outputCleanup || {}); } catch {}
  }, 3000);
});

// 端口被占用等监听错误：直接退出，别“假活着”
server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${port} 已被占用，请先运行 stop.bat 或关闭旧实例`);
  } else {
    console.error('[server] 监听失败：', e?.message || e);
  }
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('[server] 正在关闭…');
  await stopLlm();
  await stopComfyUi();
  server.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await stopLlm();
  await stopComfyUi();
  server.close();
  process.exit(0);
});

// 兜底：任何未捕获异常/未处理 Promise 只记日志，不让后端整体退出
process.on('uncaughtException', (e) => {
  console.error('[server] 未捕获异常：', e?.stack || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[server] 未处理 Promise 拒绝：', e?.stack || e);
});
