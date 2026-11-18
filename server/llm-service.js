// 独立的「翻译用」llama-server 生命周期管理。
//
// 为什么单独起一个实例而不是复用 DSH 的 8080：
//   · 翻译只需要 8k 上下文，显存占用比 40k 的聊天实例小得多
//   · 用完即停，不污染用户手动启动的聊天服务（也不去动它的进程）
//
// ⚠ 所有进程操作都按 PID，绝不 taskkill /IM llama-server —— 那会误杀 DSH 的实例。

import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const DEFAULTS = {
  exe: 'E:\\AI\\qwen3-heretic\\bin\\llama-server.exe',
  modelPath: 'E:\\AI\\qwen3-heretic\\models\\Qwen3-8B-heretic.Q5_K_M.gguf',
  cudaPath: 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.2',
  host: '127.0.0.1',
  port: 8081,
  ctxSize: 8192,
  gpuLayers: 99,
  apiKey: 'sk-local',
  startTimeoutMs: 90000,
  minFreeMiB: 7500
};

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
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

export function createLlmService({ cfg = {}, log = () => {} } = {}) {
  const c = { ...DEFAULTS, ...(cfg.llm ?? {}) };
  const baseUrl = `http://${c.host}:${c.port}`;

  /** 当前由本模块拉起的进程；复用别人的实例时为 null */
  let proc = null;
  let owned = false;

  async function isUp(timeoutMs = 2000) {
    try {
      const r = await httpGetJson(`${baseUrl}/health`, timeoutMs);
      return r?.status === 'ok';
    } catch {
      return false;
    }
  }

  /** 等端口释放，避免上一实例还没退干净、新实例绑定失败就退出。 */
  async function waitPortFree(ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!(await isUp(700))) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  function stopProc() {
    if (!proc) return;
    const pid = proc.pid;
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, stdio: 'ignore' }); } catch {}
    try { proc.kill(); } catch {}
    proc = null;
    owned = false;
    log(`[llm] 翻译实例已停止 (pid=${pid})`);
  }

  /** 确保翻译实例在线。返回 { reused:boolean }。 */
  async function start() {
    if (await isUp()) {
      log('[llm] 8081 已在监听，复用现有实例');
      return { reused: true };
    }
    const free = freeVramMiB();
    if (free != null && free < c.minFreeMiB) {
      throw new Error(`显存不足：当前空闲 ${free} MiB，翻译实例需要约 ${c.minFreeMiB} MiB。请先停止手动启动的模型服务`);
    }
    if (!path.isAbsolute(c.exe)) throw new Error(`llm.exe 必须是绝对路径：${c.exe}`);
    if (!(await waitPortFree(1500))) throw new Error(`端口 ${c.port} 仍被占用，无法启动翻译实例`);

    const args = [
      '--model', c.modelPath,
      '--ctx-size', String(c.ctxSize),
      '--n-gpu-layers', String(c.gpuLayers),
      '--flash-attn', 'on',
      '--cache-type-k', 'q8_0',
      '--cache-type-v', 'q8_0',
      '--host', c.host,
      '--port', String(c.port),
      '--parallel', '1',
      '--threads', '8',
      '--alias', 'qwen3-8b-heretic',
      '--api-key', c.apiKey,
      '--no-webui'
    ];

    const env = { ...process.env };
    if (c.cudaPath) {
      env.PATH = `${path.join(c.cudaPath, 'bin', 'x64')};${path.join(c.cudaPath, 'bin')};${env.PATH ?? ''}`;
    }

    log(`[llm] 正在拉起翻译实例 :${c.port}（ctx=${c.ctxSize}）…`);
    proc = spawn(c.exe, args, {
      cwd: path.dirname(c.exe),
      windowsHide: true,
      stdio: 'ignore',
      env
    });
    owned = true;
    proc.on('exit', (code) => {
      if (owned) log(`[llm] 翻译实例退出 (code=${code})`);
      proc = null;
      owned = false;
    });
    proc.on('error', (error) => {
      log(`[llm] 翻译实例启动失败: ${error?.message ?? error}`);
    });

    const deadline = Date.now() + c.startTimeoutMs;
    while (Date.now() < deadline) {
      if (await isUp(1500)) {
        log('[llm] 翻译实例就绪');
        return { reused: false };
      }
      if (!proc) throw new Error('翻译实例启动后立即退出，多半是显存不足或模型路径不对');
      await new Promise((r) => setTimeout(r, 700));
    }
    stopProc();
    throw new Error(`翻译实例 ${Math.round(c.startTimeoutMs / 1000)} 秒内未就绪`);
  }

  /** 只停自己拉起的实例；复用别人的实例时保持不动。 */
  async function stop() {
    if (!owned) return;
    stopProc();
    await waitPortFree(8000);
  }

  return { start, stop, isUp, stopProc, get port() { return c.port; }, get baseUrl() { return baseUrl; } };
}