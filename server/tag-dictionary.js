// 中英对照词典：从 danbooru-tags-data-zh 的 CSV 里建中文 → 英文 tag 的索引。
//
// 用途有两个：
//   1. 精确命中：用户只发一个词（"猫耳"）时直接给出 tag，不启动 LLM
//   2. 术语提示：整句翻译前，先把句子里认识的词提出来喂给模型当参考
//
// 数据来源：https://huggingface.co/datasets/ame-la/danbooru-tags-data-zh （MIT）
// 字段：tag,category,aliases,zh,count,notes

import fs from 'node:fs';

const CJK_RE = /[\u3400-\u9fff]/;
// 颜色词（含「深红/浅蓝/粉红」这类修饰）：术语提示里优先占位，避免被长名词挤出前 8 条
const COLOR_HINT_RE = /^(?:深|浅|淡|亮|暗|墨|酒|天)?(?:红|蓝|白|黑|黄|绿|紫|粉|棕|褐|灰|橙|青|金|银)/;

/** 英文 tag 转成 ComfyUI 习惯的空格写法：white_thighhighs → white thighhighs */
function toTagString(tag) {
  return String(tag ?? '').replace(/_/g, ' ').trim().toLowerCase();
}

function normalizeKey(text) {
  return String(text ?? '')
    .trim()
    .replace(/[\s，,。.！!？?、；;：:"'“”‘’（）()\[\]【】~～]/g, '')
    .toLowerCase();
}

/** 人工覆盖：中文 → 英文 tag。优先级高于 CSV，用来修表的错漏。 */
const DEFAULT_TAG_OVERRIDES = {
  翻白眼: 'rolling eyes'
};

export function createTagDictionary({ cfg = {}, log = () => {} } = {}) {
  const c = cfg.translate ?? {};
  const enabled = c.useDictionary !== false;
  const file = String(c.dictionaryPath ?? 'E:\\AI\\qwen3-heretic\\tag-tables\\hf_general.csv');
  const maxHints = Math.max(0, Number(c.maxTermHints ?? 8));
  const overrides = { ...DEFAULT_TAG_OVERRIDES, ...(c.tagOverrides && typeof c.tagOverrides === 'object' ? c.tagOverrides : {}) };
  const minHintCount = Math.max(0, Number(c.minHintCount ?? 300));
  // 这些中文词在表里能查到英文，但含义跟画面描述对不上（画面→screen），当提示只会带偏模型
  const hintBlacklist = new Set(Array.isArray(c.hintBlacklist) ? c.hintBlacklist : ['画面', '感觉', '效果', '程度', '内容', '露出', '抬头', '低着']);

  /** 归一化中文 → 英文 tag */
  const exact = new Map();
  const counts = new Map();
  /** 原样中文词（用于句子里的子串匹配），按长度降序 */
  let terms = [];
  let loaded = 0;

  function addEntry(zh, tag, count = 0) {
    const key = normalizeKey(zh);
    if (!key || !CJK_RE.test(key)) return;
    if (!exact.has(key)) {
      exact.set(key, tag);
      counts.set(key, count);
    }
  }

  /** 重建子串匹配词表：长词优先，避免「过膝袜」抢在「白色过膝袜」前面。 */
  function rebuildTerms() {
    terms = [...exact.keys()].filter((k) => k.length >= 2).sort((a, b) => b.length - a.length);
  }

  function load() {
    if (!enabled) {
      log('[image] 词典未启用');
      return;
    }
    try {
      if (!fs.existsSync(file)) {
        log(`[image] 词典文件不存在，跳过：${file}`);
        return;
      }
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const lines = raw.split(/\r?\n/);
      const header = lines.shift() ?? '';
      const cols = header.split(',').map((h) => h.trim().toLowerCase());
      const iTag = cols.indexOf('tag');
      const iZh = cols.indexOf('zh');
      const iAliases = cols.indexOf('aliases');
      if (iTag < 0 || iZh < 0) {
        log('[image] 词典表头不认识，跳过加载');
        return;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        // 简单 CSV 解析：字段里可能有引号包住的逗号
        const parts = [];
        let cur = '';
        let quoted = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
          } else if (ch === ',' && !quoted) {
            parts.push(cur); cur = '';
          } else {
            cur += ch;
          }
        }
        parts.push(cur);
        const tag = toTagString(parts[iTag]);
        if (!tag) continue;
        const count = Number(parts[cols.indexOf('count')] ?? 0) || 0;
        const zh = parts[iZh] ?? '';
        if (zh) {
          addEntry(zh, tag, count);
          // 「翻白眼（眼珠上翻）」这种带括号注释的，再去掉括号建一条，
          // 否则用户只打「翻白眼」永远匹配不上
          const bare = String(zh).replace(/[（(][^）)]*[）)]/g, '').trim();
          if (bare && bare !== zh) addEntry(bare, tag, count);
        }
        const aliases = (parts[iAliases] ?? '').split('|');
        for (const a of aliases) if (a && CJK_RE.test(a)) addEntry(a, tag, count);
        loaded += 1;
      }

      rebuildTerms();
      log(`[image] 词典已加载 ${exact.size} 个中文词（${loaded} 行，${file}）`);
    } catch (error) {
      log(`[image] 词典加载失败: ${error?.message ?? error}`);
    }
  }

  load();

  // 应用人工覆盖（覆盖后重建词表，保证"翻白眼"优先于"白眼"被匹配）
  let overrideCount = 0;
  for (const [zh, tag] of Object.entries(overrides)) {
    const key = normalizeKey(zh);
    if (!key || !CJK_RE.test(key)) continue;
    const t = toTagString(tag);
    if (!t) continue;
    exact.set(key, t);
    counts.set(key, 1000000);
    overrideCount += 1;
  }
  if (overrideCount > 0) {
    rebuildTerms();
    log(`[image] 词典人工覆盖 ${overrideCount} 条`);
  }

  /** 整句都只是这一个词时，直接给出 tag；否则返回 null。 */
  function lookupExact(text) {
    const key = normalizeKey(text);
    if (!key) return null;
    return exact.get(key) ?? null;
  }

  /**
   * 输入由多个词组成、且**每个词都能查到**时，直接拼成 tag 串（不启 LLM）。
   * 例：「猫耳，双马尾，微笑」→ "cat ears, twintails, smile"
   * 只要有一段查不到就返回 null，交给 LLM。
   */
  function lookupAllTerms(text) {
    const parts = String(text ?? '')
      .split(/[\s，,。.、；;：:！!？?~～|\/]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length < 2) return null;
    const tags = [];
    for (const part of parts) {
      const t = exact.get(normalizeKey(part));
      if (!t) return null;
      tags.push(t);
    }
    const unique = [...new Set(tags)];
    return unique.length >= 2 ? { tags: unique.join(', '), words: unique.length } : null;
  }

  /** 从句子里挑出认识的词，长词优先；返回 [{ zh, tag }]，最多 maxHints 条。 */
  function findTerms(text) {
    if (!maxHints || terms.length === 0) return [];
    let rest = String(text ?? '');
    if (!CJK_RE.test(rest)) return [];
    const found = [];
    const push = (term) => {
      found.push({ zh: term, tag: exact.get(term) });
      rest = rest.split(term).join(' ');
    };
    // 2026-11-10：颜色词优先占位（最多 4 个）。8B 模型经常漏颜色，
    // 而颜色词只有 2 个字，按「长词优先」会被「白色过膝袜」这类长词挤出前 8 条提示。
    let colorCount = 0;
    for (const term of terms) {
      if (colorCount >= 4 || found.length >= maxHints) break;
      if (!COLOR_HINT_RE.test(term)) continue;
      if ((counts.get(term) ?? 0) < minHintCount) continue;
      if (!rest.includes(term)) continue;
      push(term);
      colorCount += 1;
    }
    for (const term of terms) {
      if (found.length >= maxHints) break;
      if (hintBlacklist.has(term)) continue;
      if ((counts.get(term) ?? 0) < minHintCount) continue;
      if (!rest.includes(term)) continue;
      push(term);
    }
    return found;
  }

  return { lookupExact, lookupAllTerms, findTerms, get size() { return exact.size; } };
}