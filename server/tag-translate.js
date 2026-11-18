// 中文 → Danbooru 标签翻译器。
//
// 只做一件事：把用户写的中文画面描述，转成 ComfyUI 能吃的英文 tag 串。
// 直译、不扩写、不解释；输出不合格就抛错（由调用方决定怎么回消息）。
//
// 缓存落盘：追加式 JSONL（一行一条 {"k":中文,"v":标签,"at":时间戳}），
// 默认放在 ComfyUI 目录下，重启桥接后仍然有效。文件可以直接删，删了就当没缓存。

import fs from 'node:fs';
import path from 'node:path';
import { createTagDictionary } from './tag-dictionary.js';

const BASE_RULES = `你是 Danbooru 标签转换器。用户会给你一句中文（或中英混排）的画面描述，你要把它转换成 Danbooru 风格的英文 tag 列表。

输出规则：
1. 每行只输出一个 tag，不要编号、不要逗号，例如：
silver hair
sitting
window
smile
2. 每个 tag 全小写，单词之间用空格，不要下划线
3. 使用 Danbooru 上最常见的规范写法：双马尾→twintails，比耶→v sign，过膝袜→thighhighs，回头看→looking back，猫耳→cat ears，绝对领域→zettai ryouiki
4. 不要添加用户没提到的内容：不加 solo / masterpiece / best quality / upper_body 这类构图与画质 tag
5. 人名、角色名、作品名尽量用英文常见写法；不确定的就直接不要输出
6. 不要输出解释、前言、引号、Markdown、编号、中文，不要写 "Here are the tags" 或 "以下是标签" 这类对话性文字，只输出 tag 列表本身
7. 输入里已经是英文 tag 的部分原样保留
8. 无法对应到 tag 的描述直接省略，不要编造
9. 按「外观 → 动作表情 → 服装 → 场景 → 光线」排序；**不要为了凑数重复或编造**，
   用户写了多少细节就保留多少，不要主动删减
10. 动作、天气、时间、方向这类关键信息不要漏（例如「在雨里跑」要同时给出 rain 和 running）

【重要】前面成对的 user/assistant 消息只是**输出格式示例**，不是要翻译的内容。
你只能翻译最后一条 user 消息；**禁止把示例里的 tag（如 1girl / blue eyes / school uniform / huge eyes 等）搬进结果**，
用户没写的特征一律不要出现。

颜色补充：原文里出现的颜色（发色、瞳色、衣服、物体、背景）**必须保留**。
颜色可以合并进名词（red dress、blue eyes），但**不能只写名词把颜色丢掉**；
原文有几种颜色就至少保留几种，颜色和场景细节冲突时优先保颜色。`;

// 加权规则单独成段：`。生图 加权 关` 时整段不发给模型。
const WEIGHT_RULES = `
11. 强调词加权重：用户用「非常 / 特别 / 超级 / 超 / 极其 / 极 / 强烈 / 极度 / 夸张 / 巨大 / 巨 /
    很 / 好 / 太 / 最 / 十分 / 相当 / 格外 / 异常 / 贼 / 老 / 挺」等**任何程度词**修饰某个外观或表情时，
    给对应 tag 加权重，格式 (tag:1.2) —— 例：非常长的头发 → (very long hair:1.2)，
    好大的眼睛 → (huge eyes:1.2)，很长的头发 → (very long hair:1.2)
    权重只能取 1.1~1.4（一般 1.2，特别夸张才 1.3 / 1.4）；**一个提示词最多 2 个加权 tag**；
    没有程度词就一律不加权重，不要靠加权重来"提升画质"
    注意：程度词即使能被 tag 本身表达（超级大 → huge、好大 → huge），也必须写成带权重的形式
    (huge eyes:1.2)，不能只写 huge eyes 就完事 —— 这是最常见的漏权重原因
12. 权重优先给「外观 / 表情」；如果程度词修饰的是画面里的**物体、液体、服装上的痕迹**
    （例如 yogurt、cream、paint、cum、foam），也要给对应 tag 加权重 —— 这类"数量多"的强调同样重要。
    只有纯动作、场景、天气、光线不要加权重（「拼命跑」是 running，不是 (running:1.3)；
    「最后」的「最」不是程度词）`;

// 兼容旧引用：BASE_RULES 就是「不加权重」那套提示词
const SYSTEM_PROMPT = BASE_RULES;

const FEW_SHOT_BASE = [
  ['银发少女坐在窗边，午后阳光，微笑', ['silver hair', 'girl', 'sitting', 'window', 'afternoon', 'sunlight', 'smile']],
  ['双马尾猫耳，白色过膝袜，比耶', ['twintails', 'cat ears', 'white thighhighs', 'v sign']],
  ['红裙子，回头看，雨中的街道', ['red dress', 'looking back', 'rain', 'street']],
  ['白发红眼，黑色连衣裙，蓝色背景', ['white hair', 'red eyes', 'black dress', 'blue background']],
  ['她翻白眼，红色连衣裙', ['rolling eyes', 'red dress']],
  ['1girl, 蓝眼睛, school uniform', ['1girl', 'blue eyes', 'school uniform']]
];

// 加权模式才追加的示例（示例比规则管用：只写规则时「超级大」那条就是不加权重）
const FEW_SHOT_WEIGHT = [
  ['非常长的银发，红裙子，微笑', ['(very long hair:1.2)', 'silver hair', 'red dress', 'smile']],
  ['超级大的眼睛，猫耳，站着', ['(huge eyes:1.2)', 'cat ears', 'standing']],
  ['好大的眼睛，猫耳', ['(huge eyes:1.2)', 'cat ears']],
  ['很长的头发，白色连衣裙', ['(very long hair:1.2)', 'white dress']]
];

// 出现这些词就说明有强调语义：加权模式下别再用词典直出（词典只会给裸 tag，会丢掉强调）。
// 单字程度词必须跟形容词搭配才算（避免「太阳」「好像」「最后」「老人」被误判）。
const EMPHASIS_RE = /非常|特别|超级|极其|极度|十分|相当|格外|异常|强烈|夸张|巨大|超大|(?:很|好|太|最|超|极|贼|老|挺)(?:大|小|长|短|亮|暗|高|低|粗|细|圆|厚|薄|宽|窄|多|少|快|慢|重|轻|浓|淡|深|浅|艳|可爱|漂亮|美|帅|好|看|棒)/;

/** 这句话里有没有程度词（供测试和外部判断使用）。 */
export function hasEmphasis(text) {
  return EMPHASIS_RE.test(String(text ?? ''));
}

// 只有程度词、没有任何被强调对象时（如单独一句「超级多」），没有 tag 可加权，
// 强行翻会得到 "superior amount" 这种无意义结果 —— 直接报错让用户补对象。
const DEGREE_ONLY_STRIP_RE = /超级|非常|特别|极其|极度|十分|相当|格外|异常|强烈|夸张|巨大|超大|很|好|太|最|超|极|贼|老|挺|多|少|的|了|啊|呀|吧|呢|嘛|哦|[\s，。！？、,.!?~～]/g;

/** 去掉程度词/语气词/标点后是否什么都不剩。 */
export function isDegreeOnly(text) {
  return String(text ?? '').replace(DEGREE_ONLY_STRIP_RE, '').trim() === '';
}

const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
// 冒号留给 (tag:1.2) 的权重写法，首字符允许左括号，其它符号照旧
const TAG_RE = /^[a-z0-9(][a-z0-9 '\-().:]*$/;
// (tag:1.2) —— 只认最外层一对括号 + 一个数字权重
const WEIGHTED_RE = /^\(\s*([^()]+?)\s*:\s*([0-9]*\.?[0-9]+)\s*\)$/;
const WEIGHT_MIN = 1.1;
const WEIGHT_MAX = 1.4;
const WEIGHT_MAX_COUNT = 2;

/**
 * 规范化权重写法：括号/冒号转半角、权重夹到 1.1~1.4、超过 2 个的降级成普通 tag。
 * 模型偶尔会写 (hair:1.5) 或全角（hair：1.2），这里统一收口，不让它把画面压坏。
 */
function normalizeWeights(tags) {
  const out = [];
  let weightedCount = 0;
  for (const tag of tags) {
    const m = tag.match(WEIGHTED_RE);
    if (!m) {
      // 括号里带冒号但不是合法权重（如 (hair:abc)）：拆掉括号只留标签本体，别把脏写法送进 prompt
      const broken = tag.match(/^\(([^()]+)\)$/);
      if (broken && broken[1].includes(':')) {
        const inner = broken[1].split(':')[0].replace(/\s+/g, ' ').trim();
        if (inner) out.push(inner);
        continue;
      }
      out.push(tag);
      continue;
    }
    const inner = m[1].replace(/\s+/g, ' ').trim();
    if (!inner) continue;
    let w = Number(m[2]);
    if (!Number.isFinite(w)) w = 1.2;
    w = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, Math.round(w * 100) / 100));
    // 超额的加权 tag 直接保留裸 tag，别丢内容
    if (weightedCount >= WEIGHT_MAX_COUNT) {
      out.push(inner);
      continue;
    }
    weightedCount += 1;
    out.push(`(${inner}:${w})`);
  }
  return out;
}

/** 把模型输出洗成规范 tag 串；不合格直接抛错。 */
export function sanitizeTags(raw) {
  let text = String(raw ?? '').trim();
  if (!text) throw new Error('模型返回空内容');
  text = text.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '');

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(?:输出|翻译|tags?|结果)\s*[:：]\s*/i, ''));

  const tags = lines
    .join(',')
    .split(/[,，、;；]/)
    .map((t) => t.trim())
    .filter(Boolean)
    // 全角括号 / 冒号统一成半角，否则 (发色:1.2) 这类写法会被 TAG_RE 丢掉
    .map((t) => t.replace(/（/g, '(').replace(/）/g, ')').replace(/：/g, ':'))
    .map((t) => t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((t) => TAG_RE.test(t));

  const weighted = normalizeWeights(tags);
  // 2026-11-10：不再限制 tag 数量。原来的 slice(0,20) 会把长描述里的加权 tag
  // （通常排在外观段之后）直接切掉，表现为「用了『超级』但没加权」。
  const result = weighted;

  if (result.length === 0) throw new Error('模型输出不是有效标签');
  return result.join(', ');
}

/** 判断文本里有没有中文（决定要不要调用模型）。 */
export function hasChinese(text) {
  return CJK_RE.test(String(text ?? ''));
}

// ── 颜色词兜底（2026-11-10）────────────────────────────────────────────
// 8B 翻译模型经常把颜色省略（只给 dress / hair），或者并进名词后又丢掉。
// 这里在翻译结果之后，按中文原文里实际出现的颜色补回缺失的 tag —— 纯规则，不依赖模型。
const COLOR_WORDS = [
  ['深红', 'dark red'], ['酒红', 'wine red'], ['浅蓝', 'light blue'], ['天蓝', 'sky blue'],
  ['深蓝', 'dark blue'], ['深绿', 'dark green'], ['墨绿', 'dark green'], ['浅绿', 'light green'],
  ['浅粉', 'light pink'], ['粉红', 'pink'], ['米色', 'beige'], ['金色', 'golden'], ['银色', 'silver'],
  ['红色', 'red'], ['蓝色', 'blue'], ['白色', 'white'], ['黑色', 'black'], ['黄色', 'yellow'],
  ['绿色', 'green'], ['紫色', 'purple'], ['粉色', 'pink'], ['棕色', 'brown'], ['褐色', 'brown'],
  ['灰色', 'grey'], ['橙色', 'orange'], ['青色', 'cyan']
];
// 单字颜色只在后面跟「被修饰物」时才算颜色，避免「白天 / 黑历史」这类误判
const COLOR_CHAR = {
  红: 'red', 蓝: 'blue', 白: 'white', 黑: 'black', 黄: 'yellow', 绿: 'green',
  紫: 'purple', 粉: 'pink', 棕: 'brown', 褐: 'brown', 灰: 'grey', 橙: 'orange',
  青: 'cyan', 金: 'golden', 银: 'silver'
};
const COLOR_NOUN_RE = /(红|蓝|白|黑|黄|绿|紫|粉|棕|褐|灰|橙|青|金|银)(发|头发|长发|短发|瞳|眼|眼睛|眼眸|眸|裙|长裙|短裙|连衣裙|衣|上衣|外套|衬衫|袜|丝袜|过膝袜|鞋|靴|帽子|围巾|手套|披风|斗篷|背景|天空|花|玫瑰|光|窗帘|沙发|墙壁|地毯)/g;
// 颜色修饰：淡/浅 → light，深/暗 → dark，亮 → bright。只给基础色（yellow）是不准确的。
const COLOR_MODIFIER_RE = /(淡|浅|深|暗|亮)(红|蓝|白|黑|黄|绿|紫|粉|棕|褐|灰|橙|青|金|银)色?/g;
const COLOR_MODIFIER_MAP = { 淡: 'light', 浅: 'light', 深: 'dark', 暗: 'dark', 亮: 'bright' };
// 固定搭配里的「白/黑」不是颜色（翻白眼是 rolling eyes，不是 white eyes；白眼睛才算白色）
const COLOR_IDIOM_RE = /翻白眼|白眼(?!睛)|白目|黑眼圈|白天|黑历史|红人|红利|黑马|蓝领|白领/g;
const ROLLING_EYES_RE = /翻白眼|白眼(?!睛)/;

/** 从中文原文里提取「应该出现」的英文颜色 tag。 */
export function detectColorTags(text) {
  // 先把固定搭配挖掉，避免「翻白眼」被拆成「白眼」再补 white
  const zh = String(text ?? '').replace(COLOR_IDIOM_RE, ' ');
  if (!zh) return [];
  const found = new Set();
  for (const [word, tag] of COLOR_WORDS) {
    if (zh.includes(word)) found.add(tag);
  }
  for (const m of zh.matchAll(COLOR_NOUN_RE)) {
    const color = m[1];
    const noun = m[2];
    // 金发 = blonde，不是 golden hair
    if (color === '金' && /^发|头发/.test(noun)) found.add('blonde');
    else found.add(COLOR_CHAR[color]);
  }
  return [...found];
}

/** tag 串里是否已经有某个颜色（red 能匹配 red dress / dark red / (red hair:1.2)）。 */
function hasColorTag(tags, color) {
  // 逗号也算边界：tag 串是 "red dress, blue eyes" 这种格式
  const re = new RegExp(`(^|[ (，,])${color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([ )，,]|$)`, 'i');
  return re.test(tags);
}

/**
 * 颜色兜底：模型漏掉的颜色按原文补在末尾。已有同名/复合色（red dress、dark red）就不重复加。
 * 只补颜色本身，不改模型给出的名词和构图，所以不会把画面带偏。
 */
export function enforceColorTags(text, tags) {
  const out = String(tags ?? '').trim();
  if (!out) return out;
  const missing = detectColorTags(text).filter((c) => !hasColorTag(out, c));
  if (missing.length === 0) return out;
  return `${out}, ${missing.join(', ')}`;
}

/** 提取带修饰的颜色（淡黄 → light yellow / 深蓝 → dark blue）。 */
export function detectModifiedColors(text) {
  const zh = String(text ?? '').replace(COLOR_IDIOM_RE, ' ');
  const out = [];
  const seen = new Set();
  for (const m of zh.matchAll(COLOR_MODIFIER_RE)) {
    const base = COLOR_CHAR[m[2]];
    if (!base) continue;
    const tag = `${COLOR_MODIFIER_MAP[m[1]]} ${base}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push({ base, tag });
  }
  return out;
}

/**
 * 修正修饰色：模型只给 yellow 时改成 light yellow（而不是再补一个裸 yellow）。
 * 同一句里通常只有这一种黄色，把输出里的 yellow 整体替换是安全的。
 */
export function applyColorModifiers(text, tags) {
  let out = String(tags ?? '').trim();
  if (!out) return out;
  for (const { base, tag } of detectModifiedColors(text)) {
    if (hasColorTag(out, tag)) continue;
    if (hasColorTag(out, base)) {
      const re = new RegExp(`(^|[ (，,])${base}([ )，,]|$)`, 'gi');
      out = out.replace(re, (m, a, b) => `${a}${tag}${b}`);
    } else {
      out = `${out}, ${tag}`;
    }
  }
  return out;
}

/**
 * 修固定搭配的误译：原文有「翻白眼/白眼」时，模型给 white eyes 一律改回 rolling eyes。
 * （8B 模型会把「翻白眼」直译成 white eyes；词典提示也压不住。）
 */
export function fixIdiomTranslations(text, tags) {
  const out = String(tags ?? '').trim();
  if (!out || !ROLLING_EYES_RE.test(String(text ?? ''))) return out;
  const parts = out.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  let changed = false;
  const mapped = parts.map((t) => {
    // 把 white eyes / (white eyes:1.2) 统一改成 rolling eyes，并保留权重
    const wm = t.match(/^\(\s*white\s+eyes?\s*:\s*([0-9.]+)\s*\)$/i);
    if (wm) { changed = true; return `(rolling eyes:${wm[1]})`; }
    if (/^\(?\s*white eyes?\s*\)?$/i.test(t)) { changed = true; return 'rolling eyes'; }
    return t;
  });
  if (!changed) return out;
  // 去重时同一个内容只保留权重最高的那条（(rolling eyes:0.7) 与 (rolling eyes:1.2) 不会同时留下）
  const weightOf = (t) => {
    const m = t.match(/^\((.*):\s*([0-9.]+)\)$/);
    return m ? Number(m[2]) : 0;
  };
  const innerOf = (t) => t.replace(/^\((.*):\s*[0-9.]+\)$/, '$1').trim().toLowerCase();
  const best = new Map();
  const order = [];
  for (const t of mapped) {
    const k = innerOf(t);
    if (!best.has(k)) { best.set(k, t); order.push(k); continue; }
    if (weightOf(t) > weightOf(best.get(k))) best.set(k, t);
  }
  return order.map((k) => best.get(k)).join(', ');
}

/**
 * 去重：同一内容同时出现加权版和未加权版时只保留加权版；
 * 未加权 tag 如果是某个加权 tag 的子集（yogurt ⊂ yogurt on hair），也丢掉。
 * 2026-11-15：修「同一个 tag 既有 (x:1.4) 又有 x」。
 */
export function dedupeWeightedTags(tags) {
  const list = String(tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length < 2) return list.join(', ');
  const isWeighted = (t) => /^\(.+:\s*[0-9.]+\)$/.test(t);
  const strip = (t) => t.replace(/^\((.*):\s*[0-9.]+\)$/, '$1').trim().toLowerCase();
  const info = list.map((t, i) => {
    const inner = strip(t);
    return { i, t, inner, weighted: isWeighted(t), words: new Set(inner.split(/\s+/).filter(Boolean)) };
  });
  const drop = new Set();
  // 1) 完全相同的内容：保留加权版
  const byInner = new Map();
  for (const x of info) {
    if (!byInner.has(x.inner)) { byInner.set(x.inner, x); continue; }
    const prev = byInner.get(x.inner);
    if (x.weighted && !prev.weighted) { drop.add(prev.i); byInner.set(x.inner, x); }
    else drop.add(x.i);
  }
  // 2) 未加权的短 tag 被某个加权 tag 包含
  const weighted = info.filter((x) => x.weighted && !drop.has(x.i));
  for (const x of info) {
    if (x.weighted || drop.has(x.i)) continue;
    if (x.words.size === 0) continue;
    for (const w of weighted) {
      if (w.words.size > x.words.size && [...x.words].every((word) => w.words.has(word))) {
        drop.add(x.i);
        break;
      }
    }
  }
  return list.filter((_, i) => !drop.has(i)).join(', ');
}

/**
 * 用户手写权重（2026-11-15）：在中文描述里用 (酸奶:1.4) / （酸奶:1.4） 标注，
 * 翻译后把对应的 tag 设成这个权重。
 * 返回 { text: 去掉标注但保留名词的文本, items: [{ phrase, weight }] }。
 * 权重范围 0.5~2.0，超范围的括号原样保留、不当作标注。
 */
const USER_WEIGHT_RE = /[（(\[【]\s*([^()（）\[\]【】:：]{1,24})\s*[:：]\s*([0-9]*\.?[0-9]+)\s*[)）\]】]/g;

export function extractUserWeights(text) {
  const items = [];
  const cleaned = String(text ?? '').replace(USER_WEIGHT_RE, (whole, phrase, raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0.5 || n > 2) return whole;
    items.push({ phrase: String(phrase).trim(), weight: Math.round(n * 100) / 100 });
    return String(phrase).trim();
  });
  return { text: cleaned, items };
}

/**
 * 把用户指定的权重套到 tag 上：能匹配到已有 tag（含修饰词，如 light yellow yogurt）就整条加权，
 * 匹配不到就追加 (tag:权重)。resolved 是 [{ tag, weight }]。
 */
export function applyUserWeights(tags, resolved) {
  const list = String(tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0 || !Array.isArray(resolved) || resolved.length === 0) return list.join(', ');
  const isWeighted = (t) => /^\(.+:\s*[0-9.]+\)$/.test(t);
  const strip = (t) => t.replace(/^\((.*):\s*[0-9.]+\)$/, '$1');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const { tag, weight } of resolved) {
    const target = String(tag ?? '').trim().toLowerCase();
    if (!target) continue;
    const re = new RegExp(`(^|\\s)${escapeRe(target)}(\\s|$)`, 'i');
    const matches = list
      .map((t, i) => ({ t, i, inner: strip(t).toLowerCase() }))
      .filter((x) => re.test(x.inner))
      .sort((a, b) => b.inner.length - a.inner.length);
    if (matches.length > 0) {
      const idx = matches[0].i;
      list[idx] = `(${strip(list[idx])}:${weight})`;
    } else {
      list.push(`(${target}:${weight})`);
    }
  }
  return list.join(', ');
}

/**
 * 强调权重兜底（2026-11-15）：把「程度词所修饰的那个 tag」补上权重。
 * 只处理 target 本身，不碰其它 tag —— 模型只加了一个权重、漏了重点时也能补上。
 * resolveTargets(text) 返回英文目标词（如 yogurt / hair / cum）。
 */
export function ensureEmphasisWeight(text, tags, resolveTargets) {
  const list = String(tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const targets = typeof resolveTargets === 'function' ? resolveTargets(text) : [];
  if (list.length === 0 || targets.length === 0) return list.join(', ');
  const isWeighted = (t) => /^\(.+:\s*[0-9.]+\)$/.test(t);
  const strip = (t) => t.replace(/^\((.*):\s*[0-9.]+\)$/, '$1');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const tgt of targets) {
    const re = new RegExp(`(^|\\s)${escapeRe(tgt)}(\\s|$)`, 'i');
    // 目标已经带权重 → 什么都不用做（别重复追加）
    if (list.some((t) => isWeighted(t) && re.test(strip(t)))) continue;
    // 多个候选时优先加权更长的那个（light yellow yogurt 优于 yogurt）
    const candidates = list
      .map((t, i) => ({ t, i, inner: strip(t).toLowerCase() }))
      .filter((x) => !isWeighted(x.t) && re.test(x.inner))
      .sort((a, b) => b.inner.length - a.inner.length);
    const idx = candidates.length > 0 ? candidates[0].i : -1;
    if (idx >= 0) {
      if (list.filter(isWeighted).length < 2) {
        list[idx] = `(${strip(list[idx])}:1.2)`;
      } else {
        // 已有 2 个权重但不是重点：把最后一个非目标权重降级，换成目标
        for (let k = list.length - 1; k >= 0; k--) {
          if (isWeighted(list[k]) && !re.test(strip(list[k]))) {
            list[k] = strip(list[k]);
            list[idx] = `(${strip(list[idx])}:1.2)`;
            break;
          }
        }
      }
    } else {
      list.push(`(${tgt}:1.2)`);
    }
  }
  return list.join(', ');
}

/** 统一后处理：先修成语误译，再补颜色。所有翻译出口都走这里。 */
export function postProcessTags(text, tags) {
  return dedupeWeightedTags(enforceColorTags(text, applyColorModifiers(text, fixIdiomTranslations(text, tags))));
}

export function createTagTranslator({ cfg = {}, log = () => {} } = {}) {
  const t = cfg.translate ?? {};
  const baseURL = String(t.baseURL ?? 'http://127.0.0.1:8081/v1').replace(/\/+$/, '');
  const apiKey = t.apiKey ?? 'sk-local';
  const model = t.model ?? 'qwen3-8b-heretic';
  const timeoutMs = Number(t.timeoutMs ?? 25000);
  const maxTokens = Number(t.maxTokens ?? 300);
  const temperature = Number(t.temperature ?? 0.2);
  // 思考链默认关：开着的话模型会把 token 全烧在 reasoning 上（实测 1024 token / 20 秒，
  // content 仍为空），翻译这种确定性任务完全不需要它。
  const thinking = t.thinking === true;
  // 纯磁盘缓存（2026-11-09 定稿）：进程内不驻留内容，查询时直接读 jsonl。
  // 条数不设上限（需要清理时发「。生图 清缓存」）。cacheSize 已废弃，不再生效。
  const cacheFile = String(t.cacheFile ?? 'E:\\AI绘图\\ComfyUI_windows_portable\\tag-cache.jsonl');
  // 缓存开关：config.image.translate.useCache=false 或环境变量 TAG_NO_CACHE=1 时彻底禁用
  // （禁用后既不读也不写，用于排查「结果是否被旧缓存污染」）
  const useCache = t.useCache !== false && process.env.TAG_NO_CACHE !== '1';

  /** 中英对照词典（精确命中 + 术语提示） */
  const dict = createTagDictionary({ cfg: { translate: t }, log });

  // 强调目标解析（2026-11-15）：找出「程度词修饰的是哪个名词」→ 对应英文 tag。
  // 用来修「模型加了一个权重、但漏了重点」的情况（如给了 thighhighs 权重却没给 yogurt）。
  const BODY_NOUN_TAGS = {
    头发: 'hair', 长发: 'hair', 短发: 'hair',
    眼睛: 'eyes', 眼: 'eyes', 瞳: 'eyes', 眼眸: 'eyes',
    脸: 'face', 脸颊: 'cheeks', 皮肤: 'skin',
    胸: 'breasts', 腿: 'legs', 手: 'hands', 嘴: 'mouth', 耳朵: 'ears'
  };
  const DEGREE_NEAR_RE = /超级|非常|特别|极其|极|十分|相当|格外|异常|强烈|夸张|巨大|超大|很|好|太|最|超|挺|多|少/;
  const DEGREE_TAIL_RE = /(?:多|少|大|长|短|亮|暗|高|低|厚|薄|宽|窄|浓|淡|深|浅)\s*(?:的)?\s*([\u4e00-\u9fff]{2,12})/g;

  function isNearDegree(text, word) {
    let i = text.indexOf(word);
    while (i >= 0) {
      const before = text.slice(Math.max(0, i - 12), i);
      const after = text.slice(i + word.length, i + word.length + 4);
      if (DEGREE_NEAR_RE.test(before) || /^(多|少|大|长|亮|高)/.test(after)) return true;
      i = text.indexOf(word, i + 1);
    }
    return false;
  }

  /** 解析程度词修饰的目标（英文词），供 ensureEmphasisWeight 使用。 */
  function resolveEmphasisTargets(text) {
    const zhText = String(text ?? '');
    const targets = [];
    const add = (value) => { if (value && !targets.includes(value)) targets.push(value); };
    // 1) 程度词后面的名词（多/大/长… + 的? + 名词），按「的」切段从右往左查词典
    for (const m of zhText.matchAll(DEGREE_TAIL_RE)) {
      const segs = m[1].split('的').filter(Boolean).reverse();
      for (const seg of segs) {
        const hit = dict.lookupExact(seg);
        if (hit) { add(hit); break; }
        const noColor = seg.replace(/^(淡|浅|深|亮|暗)?(红|蓝|白|黑|黄|绿|紫|粉|棕|褐|灰|橙|青|金|银)色?/, '');
        if (noColor && noColor !== seg) {
          const hit2 = dict.lookupExact(noColor);
          if (hit2) { add(hit2); break; }
        }
      }
    }
    // 2) 身体/外观名词（词典里没有「头发」这类词）
    for (const [zh, tag] of Object.entries(BODY_NOUN_TAGS)) {
      if (zhText.includes(zh) && isNearDegree(zhText, zh)) add(tag);
    }
    return targets;
  }

  // 加权 / 不加权是两套**互相独立**的缓存：一个是带 (tag:1.2) 的结果，一个是纯 tag。
  // 混在一起会出事 —— 关掉加权后仍命中带权重的旧缓存，开着加权又命中旧的裸 tag，
  // 开关看起来就像"没生效"。落盘同样分两个文件：xxx.jsonl / xxx-weight.jsonl。
  const defaultAutoWeight = t.autoWeight !== false;

  function cacheFileFor(mode) {
    if (!cacheFile) return '';
    if (mode !== 'weight') return cacheFile;
    const ext = path.extname(cacheFile);
    const base = ext ? cacheFile.slice(0, -ext.length) : cacheFile;
    return `${base}-weight${ext || '.jsonl'}`;
  }
  const cacheFiles = { plain: cacheFileFor('plain'), weight: cacheFileFor('weight') };
  // 缓存格式版本：v2 修截断、v3 修成语/修饰色、v4 修程度词漏权重、v5 丢弃重试上线前的旧结果（v1 的长描述可能被截断成 20 条、加权 tag 丢失）。
  // 读到旧版本条目直接跳过，让那句话重新翻一次。
  const CACHE_VERSION = 7;

  /** 本次调用用哪套缓存：显式传入优先，否则跟配置默认值。 */
  function cacheModeOf(opts) {
    if (opts && typeof opts.autoWeight === 'boolean') return opts.autoWeight ? 'weight' : 'plain';
    return defaultAutoWeight ? 'weight' : 'plain';
  }

  function normalize(text) {
    return String(text ?? '').trim().replace(/\s+/g, ' ');
  }

  /** 直接从磁盘按行查找该 key 的最新值（后写的覆盖先写的），进程内不驻留。 */
  function cacheGet(mode, key) {
    if (!useCache) return null;
    const file = cacheFiles[mode];
    if (!file || !key) return null;
    try {
      if (!fs.existsSync(file)) return null;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const s = lines[i].trim();
        if (!s) continue;
        try {
          const obj = JSON.parse(s);
          if (obj && obj.k === key && typeof obj.v === 'string' && obj.ver === CACHE_VERSION) return obj.v;
        } catch {
          // 单行坏了就跳过，不影响其它条目
        }
      }
    } catch (error) {
      log(`[image] 翻译缓存读取失败（${mode}）: ${error?.message ?? error}`);
    }
    return null;
  }

  function appendCacheToDisk(mode, key, val) {
    if (!useCache) return;
    const file = cacheFiles[mode];
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ k: key, v: val, at: Date.now(), ver: CACHE_VERSION })}\n`, 'utf8');
    } catch (error) {
      log(`[image] 翻译缓存写入失败（${mode}）: ${error?.message ?? error}`);
    }
  }

  function cacheSet(mode, key, val) {
    appendCacheToDisk(mode, key, val);
  }

  /** 启动时只统计条数用于日志，不把内容读进内存。 */
  function reportCacheOnDisk(mode) {
    if (!useCache) { log('[image] 翻译缓存已禁用（useCache=false）'); return; }
    const file = cacheFiles[mode];
    if (!file) return;
    try {
      if (!fs.existsSync(file)) return;
      const n = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((s) => s.trim()).length;
      log(`[image] 翻译缓存（磁盘）${n} 条（${mode === 'weight' ? '加权' : '普通'}：${file}）`);
    } catch (error) {
      log(`[image] 翻译缓存读取失败（${mode}）: ${error?.message ?? error}`);
    }
  }

  for (const mode of Object.keys(cacheFiles)) reportCacheOnDisk(mode);

  /**
   * 加权模式下遇到强调词就别走词典直出：词典只会给裸 tag（巨大的眼睛 → huge eyes），
   * 强调语义会丢，必须交给模型加权重。
   */
  function dictShortcutAllowed(key, mode) {
    return !(mode === 'weight' && EMPHASIS_RE.test(key));
  }

  // 缓存启动检查已在 cacheFiles 定义后完成（只统计条数，不驻留）。

  /** 缓存命中直接返回 tag 串，不需要调用模型；未命中返回 null。 */
  function getCached(text, opts) {
    const key = normalize(text);
    if (!key) return null;
    const val = cacheGet(cacheModeOf(opts), key);
    return val == null ? null : postProcessTags(key, val);
  }

  /**
   * 不启 LLM 的预检：缓存 → 整句精确 → 多词全命中。
   * 命中返回 { tags, cached, dictWords }；没命中返回 null，交给 translate()。
   * 桥接在拉起 llama-server **之前**调它，避免为一句「猫耳」白等 5 秒加载。
   */
  function getDictDirect(text, opts) {
    // 带手写权重的文本不能走词典直出（权重要在翻译结果上套）
    if (extractUserWeights(text).items.length > 0) return null;
    const key = normalize(text);
    if (!key) return null;
    const mode = cacheModeOf(opts);
    const hit = cacheGet(mode, key);
    if (hit) return { tags: postProcessTags(key, hit), cached: true, dictWords: 0 };
    if (!dictShortcutAllowed(key, mode)) return null;
    const direct = dict.lookupExact(key);
    if (direct) {
      const tags = postProcessTags(key, direct);
      cacheSet(mode, key, tags);
      log('[image] 词典直出（1 词）');
      return { tags, cached: false, dictWords: 1 };
    }
    const all = dict.lookupAllTerms(key);
    if (all) {
      const tags = postProcessTags(key, all.tags);
      cacheSet(mode, key, tags);
      log(`[image] 词典直出（${all.words} 词）`);
      return { tags, cached: false, dictWords: all.words };
    }
    return null;
  }

  /**
   * 纯查询：这句话会不会真的走 LLM（缓存/词典能直接给答案就不算）。
   * 只读，不写缓存、不启动实例，用来决定要不要先发一条「正在翻译…」。
   */
  function needsLlm(text, opts) {
    const key = normalize(text);
    if (!key) return false;
    const mode = cacheModeOf(opts);
    if (cacheGet(mode, key) !== null) return false;
    if (extractUserWeights(text).items.length > 0) return true;
    if (!dictShortcutAllowed(key, mode)) return true;
    if (dict.lookupExact(key)) return false;
    if (dict.lookupAllTerms(key)) return false;
    return true;
  }

  async function translate(text, opts) {
    // 用户手写权重：缓存键保留原标注（不同权重分开缓存），翻译时把括号去掉只留名词
    const cacheKey = normalize(text);
    const parsedUser = extractUserWeights(cacheKey);
    const userWeights = parsedUser.items;
    const key = userWeights.length > 0 ? normalize(parsedUser.text) : cacheKey;
    const mode = cacheModeOf(opts);
    if (mode === 'weight' && EMPHASIS_RE.test(key) && isDegreeOnly(key)) {
      throw new Error(`「${key}」只有程度词，没有要强调的对象；请补充描述，例如「超级多的头发」「很长的头发」`);
    }
    const hit = cacheGet(mode, cacheKey);
    if (hit) return { tags: postProcessTags(key, hit), cached: true, autoWeight: mode === 'weight' };

    // 只发了一个词且词典里正好有：直接给结果，不启动 LLM
    if (userWeights.length === 0 && dictShortcutAllowed(key, mode)) {
      const direct = dict.lookupExact(key);
      if (direct) {
        const tags = postProcessTags(key, direct);
        cacheSet(mode, cacheKey, tags);
        log('[image] 词典直出（1 词，dict）');
        return { tags, cached: false, source: 'dict', dictWords: 1, autoWeight: mode === 'weight' };
      }

      // 多个词、且每段都能查到：直接拼 tag，不启 LLM
      const allTerms = dict.lookupAllTerms(key);
      if (allTerms) {
        const tags = postProcessTags(key, allTerms.tags);
        cacheSet(mode, cacheKey, tags);
        log(`[image] 词典直出（${allTerms.words} 词，dict）`);
        return { tags, cached: false, source: 'dict', dictWords: allTerms.words, autoWeight: mode === 'weight' };
      }
    }

    // 整句翻译前，先挑出句子里认识的词当术语参考
    const hints = dict.findTerms(key);
    if (hints.length > 0) {
      log(`[image] 术语参考命中 ${hints.length} 个词`);
    }
    const hintText = (hints.length > 0
      ? `【术语参考（按原意取舍，不必全用）】${hints.map((h) => `${h.zh}=${h.tag}`).join('；')}\n【待翻译描述】${key}`
      : key) + '\n（只翻译上面这一句，不要复用示例里的任何 tag）';

    /** 发一次请求，返回模型原始文本。extra 非空时追加一条补充要求。 */
    async function requestOnce(extra = '') {
      const systemPrompt = mode === 'weight' ? `${BASE_RULES}${WEIGHT_RULES}` : BASE_RULES;
      const shots = mode === 'weight' ? [...FEW_SHOT_BASE, ...FEW_SHOT_WEIGHT] : FEW_SHOT_BASE;
      const messages = [
        { role: 'system', content: systemPrompt },
        ...shots.flatMap(([u, tags]) => [
          { role: 'user', content: u },
          { role: 'assistant', content: tags.join('\n') }
        ]),
        { role: 'user', content: hintText }
      ];
      if (extra) {
        messages.push({ role: 'user', content: extra });
      }
      const body = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        ...(thinking ? {} : { chat_template_kwargs: { enable_thinking: false } })
      };

      let res;
      try {
        res = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        if (error?.name === 'TimeoutError') throw new Error(`翻译超时（>${Math.round(timeoutMs / 1000)} 秒）`);
        throw new Error(`翻译服务连接失败：${error?.message ?? error}`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`翻译服务返回 ${res.status}${detail ? `：${detail.slice(0, 120)}` : ''}`);
      }
      const json = await res.json();
      return json?.choices?.[0]?.message?.content ?? '';
    }

    // 用户标注的词如果词典查不到，单独问一次模型（只翻这个词，成本低）
    async function requestTerm(phrase) {
      const body = {
        model,
        messages: [
          { role: 'system', content: '把用户给的中文词翻译成最合适的 Danbooru tag。只输出英文 tag 本身，小写，不要解释、不要逗号。' },
          { role: 'user', content: String(phrase) }
        ],
        temperature: 0.1,
        max_tokens: 32,
        stream: false,
        ...(thinking ? {} : { chat_template_kwargs: { enable_thinking: false } })
      };
      try {
        const res = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) return null;
        const json = await res.json();
        const rawTerm = json?.choices?.[0]?.message?.content ?? '';
        const tag = sanitizeTags(rawTerm).split(',')[0].trim();
        return tag || null;
      } catch {
        return null;
      }
    }

    let raw = await requestOnce();
    // 排查用：TAG_DEBUG_RAW=1 时打印模型原始输出（平时关闭，避免敏感内容进日志）
    if (process.env.TAG_DEBUG_RAW === '1') {
      console.log(`[image][raw] ${String(raw).replace(/\r?\n/g, ' | ').slice(0, 800)}`);
    }
    let tags = sanitizeTags(raw);

    // 防「照抄示例」：8B 偶尔会直接把 few-shot 里的示例 tag 当答案输出
    // （典型症状：用户完全没提眼睛/校服，结果却出现 1girl, blue eyes, school uniform 或 (huge eyes:1.2)）
    const shotsUsed = mode === 'weight' ? [...FEW_SHOT_BASE, ...FEW_SHOT_WEIGHT] : FEW_SHOT_BASE;
    const normTags = (s) => String(s).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const isExampleEcho = (tagsStr) => {
      const out = new Set(normTags(tagsStr));
      // 单个 tag 的结果不做判定：像「翻白眼」这种合法结果本身就等于示例里的 rolling eyes，会误判
      if (out.size < 2) return false;
      for (const [, ex] of shotsUsed) {
        const exSet = new Set(normTags(ex.join(',')));
        let inter = 0;
        for (const t of out) if (exSet.has(t)) inter++;
        if (inter / out.size >= 0.8) return true;
      }
      return false;
    };
    if (isExampleEcho(tags)) {
      log('[image] 检测到输出像照抄示例，重试一次');
      const retryRaw = await requestOnce(
        '注意：你刚才直接把上面的示例 tag 当成了答案。示例只是格式演示，不要复用其中任何 tag。' +
        '请只翻译【待翻译描述】这一句，用户没提到的外观、颜色、服装、表情一律不要出现。'
      );
      const retryTags = sanitizeTags(retryRaw);
      if (!isExampleEcho(retryTags)) {
        tags = retryTags;
        log('[image] 重试后已修正');
      } else {
        log('[image] 重试后仍疑似照抄示例，结果可能不准');
      }
    }
    // 加权兜底（2026-11-15）：原文有程度词但模型一个权重都没给 → 明确要求重出一次。
    // 8B 模型对「好大 / 很长」这类词经常只给 huge / long，不给 (tag:1.2)。
    const WEIGHTED_ANY_RE = /\([^()]+:\s*[0-9.]+\)/;
    if (mode === 'weight' && EMPHASIS_RE.test(key) && !WEIGHTED_ANY_RE.test(tags)) {
      const retryRaw = await requestOnce(
        '注意：原文里有程度词（很 / 好 / 超 / 太 / 最 / 非常 / 特别…），必须给对应的外观、表情、' +
        '物体或液体 tag 加权重，写成 (tag:1.2)，最多 2 个；其它 tag 不要加权重。请重新输出完整 tag 列表。'
      );
      const retryTags = sanitizeTags(retryRaw);
      if (WEIGHTED_ANY_RE.test(retryTags)) {
        tags = retryTags;
        log('[image] 加权重试补上权重');
      }
    }
    // 强调权重兜底：模型只加了一个权重、漏掉程度词修饰的那个 tag 时，按原文补上
    if (mode === 'weight') {
      tags = ensureEmphasisWeight(key, tags, resolveEmphasisTargets);
    }
    // 颜色 / 修饰色 / 固定搭配兜底
    tags = postProcessTags(key, tags);
    // 用户手写权重（优先级最高，最后套）：(酸奶:1.4) / （酸奶:1.4）
    if (userWeights.length > 0) {
      const resolved = [];
      for (const item of userWeights) {
        const phrase = item.phrase;
        let tag = null;
        if (/[\u3400-\u9fff]/.test(phrase)) {
          tag = dict.lookupExact(phrase);
          if (!tag) {
            for (const seg of phrase.split('的').reverse()) {
              tag = dict.lookupExact(seg);
              if (tag) break;
            }
          }
          if (!tag) {
            const noColor = phrase.replace(/^(淡|浅|深|亮|暗)?(红|蓝|白|黑|黄|绿|紫|粉|棕|褐|灰|橙|青|金|银)色?/, '');
            if (noColor !== phrase) tag = dict.lookupExact(noColor);
          }
          if (!tag) tag = await requestTerm(phrase);
        } else {
          tag = phrase.replace(/_/g, ' ').toLowerCase();
        }
        if (tag) resolved.push({ tag, weight: item.weight });
      }
      tags = applyUserWeights(tags, resolved);
      log(`[image] 用户手写权重 ${resolved.length} 个`);
    }
    cacheSet(mode, cacheKey, tags);
    // ⚠ 不把原始中文 key 和翻译后的 tags 写进 bridge.log：用户输入可能含敏感词，
    // tags 里也可能带 cum/anal 这类合成用词，避免被网关上游拦截。
    // 只记录模式和条数，足够排查；具体内容不落日志。
    log(`[image] LLM翻译完成${mode === 'weight' ? '（加权）' : ''}，${tags.split(', ').length}条`);
    return { tags, cached: false, source: 'llm', termHits: hints.length, autoWeight: mode === 'weight' };
  }

  /** 删除两个落盘文件（纯磁盘缓存，没有内存副本）。返回清掉的条数和是否真的删了文件。 */
  function clearCache() {
    let removed = 0;
    let deleted = false;
    for (const file of Object.values(cacheFiles)) {
      try {
        if (file && fs.existsSync(file)) {
          removed += fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((s) => s.trim()).length;
          fs.rmSync(file);
          deleted = true;
        }
      } catch (error) {
        log(`[image] 翻译缓存删除失败: ${error?.message ?? error}`);
      }
    }
    return { removed, deleted };
  }

  return { translate, getCached, getDictDirect, needsLlm, sanitizeTags, hasChinese, clearCache, cacheFiles };
}