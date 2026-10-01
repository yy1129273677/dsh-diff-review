/**
 * dsh-diff-review —— 行级差异引擎（纯函数，零依赖）
 *
 * 干什么：
 *   把「修改前」和「修改后」两段文本，算成一行行可以直接显示的结果，
 *   每一行标明它是「新增」「删除」还是「没变」。这是文件变更审阅界面的核心，
 *   相当于 Trae / VS Code 里那个左右对比视图背后的计算部分。
 *
 * 怎么用：
 *   import { buildDiff } from './diff.js'
 *   const d = buildDiff(旧文本, 新文本)
 *   d.lines  // [{ kind: 'ctx' | 'add' | 'del' | 'gap', a, b, text }, ...]
 *   d.hunks  // [{ start, end, added, removed }, ...] 界面「上一处/下一处」的跳转单位
 *   d.added  // 新增了多少行
 *   d.removed// 删除了多少行
 *
 * 注意什么：
 *   - 只做「行级」比较，不做字符级高亮；同一行内的少量改动会整行显示为删除+新增。
 *   - 两段文本都很长时会退化成「整块替换」（truncated: true），避免计算量爆炸。
 *   - 行尾的换行符只当作行结束标记：仅仅末尾换行不同，不算改动。
 *   - CRLF 与 LF 视为相同，避免 Windows 上把整个文件都标成改动。
 */

/** 每次改动前后各显示几行「没变」的上下文行（与 DSH 自带的 DiffBlock 一致） */
const DEFAULT_CONTEXT = 3;

/**
 * 两处改动之间隔了多少行没变更的内容，就算「两个不同的地方」（界面「上一处/下一处」的切分阈值）。
 * 取 2×上下文行数：这样它和折叠模式下的观感一致——中间那点没变更的内容刚好被上下文覆盖住、
 * 显示上是连着的，就是一个地方；再多出一行就会被折叠成 ⋯，也就该算两处了。
 */
const HUNK_SEPARATION = DEFAULT_CONTEXT * 2;

/**
 * 全量模式下的行数上限。
 * 界面默认把整个文件都画出来（不再用 ⋯ 省略），但几百 KB 的文件能有上万行，
 * 一次渲染那么多行会卡；超过这个数就退回「只显示改动附近」，并在界面顶部写明
 * 是被折叠了（而不是悄悄省略）。想要更激进可以调这个数。
 */
const MAX_DISPLAY_LINES = 4000;

/**
 * 精确比较的最大规模：两侧行数相乘超过它就不再逐行算 LCS。
 * 250000 大约相当于「2000 行 vs 2000 行」，一张 Uint32 表约 1MB，够快也够省。
 */
const MAX_CELLS = 250000;

/** 单侧行数上限：超过就不做精确比较，直接整块替换（防止极端大文件卡住） */
const MAX_LINES_PER_SIDE = 20000;

/**
 * 把整段文本切成行数组。
 *
 * 干什么：统一换行符并去掉「末尾换行」带来的那个多余空行。
 * 参数：text —— 任意文本，可以是 null / undefined（当作空内容）。
 * 返回：行数组，例如 "a\nb\n" -> ['a', 'b']。
 * 注意：空白文件返回 []，因此「新建空文件」不会显示成一个空行。
 */
export function splitLines(text) {
  if (text === null || text === undefined) return [];
  const s = String(text);
  if (s === '') return [];
  // 先把 Windows 的 \r\n 和单独的 \r 都统一成 \n，否则 Windows 文件会被误判为全文改动
  const normalized = s.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  // 以换行结尾时，split 会多出一个空字符串，它不是一个真实的行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 用动态规划算最长公共子序列（LCS），得到「哪些行没变」。
 *
 * 干什么：这是差异比较的算法核心。两段文本里相同的行越多，说明改动越少。
 * 参数：
 *   a —— 修改前的行数组
 *   b —— 修改后的行数组
 * 返回：操作序列 [{ kind: 'equal' | 'del' | 'add', aIndex, bIndex, text }]，
 *       aIndex / bIndex 是各自数组里的下标，不适用时为 -1。
 * 注意：a.length * b.length 超过 MAX_CELLS 时走 coarse()，不做精确比较。
 */
function diffOps(a, b) {
  const n = a.length;
  const m = b.length;

  // 一边为空的情况直接给结果，省掉建表
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((text, j) => ({ kind: 'add', aIndex: -1, bIndex: j, text }));
  if (m === 0) return a.map((text, i) => ({ kind: 'del', aIndex: i, bIndex: -1, text }));

  if (n * m > MAX_CELLS || n > MAX_LINES_PER_SIDE || m > MAX_LINES_PER_SIDE) return coarse(a, b);

  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度，从右下往左上填
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      // 这一行相同，就接上各自后一位的最优解；不同则取「丢掉 a 这行」或「丢掉 b 这行」的较大者
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  // 顺着 dp 表回放路径，得到具体的增删改序列
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', aIndex: i, bIndex: j, text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      // 往下走更优：说明 a[i] 这行被删掉了
      ops.push({ kind: 'del', aIndex: i, bIndex: -1, text: a[i] });
      i++;
    } else {
      // 往右走更优：说明 b[j] 这行是新加的
      ops.push({ kind: 'add', aIndex: -1, bIndex: j, text: b[j] });
      j++;
    }
  }
  // 收尾：剩下的行要么全删、要么全新
  while (i < n) {
    ops.push({ kind: 'del', aIndex: i, bIndex: -1, text: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ kind: 'add', aIndex: -1, bIndex: j, text: b[j] });
    j++;
  }
  return ops;
}

/**
 * 退化路径：不做逐行比较，直接把旧内容全部标为删除、新内容全部标为新增。
 *
 * 干什么：文件太大或改动太碎时，精确比较又慢又没意义，整块替换更诚实。
 * 返回：操作序列，equal 一行都没有；调用方据 coarse 标记在界面上给出提示。
 */
function coarse(a, b) {
  const ops = [];
  for (let i = 0; i < a.length; i++) ops.push({ kind: 'del', aIndex: i, bIndex: -1, text: a[i] });
  for (let j = 0; j < b.length; j++) ops.push({ kind: 'add', aIndex: -1, bIndex: j, text: b[j] });
  return ops;
}

/**
 * 把完整的操作序列压缩成「界面要显示的那些行」。
 *
 * 干什么：
 *   1. 改动行全部保留；
 *   2. 每个改动块的上下各留 context 行没变的行；
 *   3. 中间被跳过的没变部分，合并成一行「⋯」占位（gap）。
 * 参数：
 *   ops —— diffOps() 的结果
 *   context —— 上下各留几行；传 Infinity 表示**全量模式**：不省略任何未变更行
 *   coarseMode —— 是否走了退化路径（决定 truncated 标记）
 * 返回：{ lines, added, removed, truncated }
 */
function toDisplayLines(ops, context, coarseMode) {
  // 先标出哪些下标属于「改动」，以及它们前后 context 行范围内需要保留的「没变」行
  const keep = new Uint8Array(ops.length);
  if (context === Infinity) {
    // 全量模式：整个文件的每一行都要显示，不存在「被跳过」的未变更行，也就不会有 ⋯
    keep.fill(1);
  } else {
    for (let k = 0; k < ops.length; k++) {
      if (ops[k].kind === 'equal') continue;
      keep[k] = 1;
      // 往前、往后各扩 context 行，只影响 equal 行
      for (let d = 1; d <= context; d++) {
        if (k - d >= 0 && ops[k - d].kind === 'equal') keep[k - d] = 1;
        if (k + d < ops.length && ops[k + d].kind === 'equal') keep[k + d] = 1;
      }
    }
  }

  const lines = [];
  let added = 0;
  let removed = 0;
  let skippedEqualRun = false;

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind === 'equal') {
      if (keep[k]) {
        // 被保留的上下文行：显示行号与原文本
        lines.push({
          kind: 'ctx',
          a: op.aIndex + 1,
          b: op.bIndex + 1,
          text: op.text,
        });
        skippedEqualRun = false;
      } else if (!skippedEqualRun) {
        // 一段被整段跳过的没变内容，只用一个占位符表示
        lines.push({ kind: 'gap', a: null, b: null, text: '⋯' });
        skippedEqualRun = true;
      }
      continue;
    }
    if (op.kind === 'del') {
      removed++;
      lines.push({ kind: 'del', a: op.aIndex + 1, b: null, text: op.text });
      skippedEqualRun = false;
      continue;
    }
    added++;
    lines.push({ kind: 'add', a: null, b: op.bIndex + 1, text: op.text });
    skippedEqualRun = false;
  }

  // 两侧完全一样时不该出现任何行（含首尾的 gap 占位）
  if (added === 0 && removed === 0) return { lines: [], added: 0, removed: 0, truncated: false };

  return { lines, added, removed, truncated: coarseMode };
}

/**
 * 把逐行差异切成「差异块」（界面「上一个 / 下一个」的跳转单位）。
 *
 * 干什么：
 *   界面一次只显示一个文件的差异，但一个文件里常常有好几处互不相邻的改动。
 *   这个函数把这些改动分成一块块，每一块就是用户眼中「一个不同的地方」，
 *   让「下一处」能直接滚过去，而不是让他自己在大段文本里找。
 *
 * 参数：
 *   lines —— buildDiff() 产出的显示行数组（全量模式或折叠模式都行）。
 * 返回：
 *   [{ start, end, added, removed }, ...]，start / end 是 lines 里的下标（含两端），
 *   每个块里的 added / removed 是这一块自己的增删行数。没有任何改动时返回 []。
 *
 * 注意：
 *   - 切分依据是「两处改动之间隔了多少行没变更的内容」，阈值 HUNK_SEPARATION：
 *     离得近（显示上是连着的）就算同一个地方；离得远就是两处。
 *     这样**和是否折叠无关**：全量模式下没有 ⋯，两处改动隔 30 行也照样分开。
 *   - 「⋯」（gap）代表中间省略了很长一段，一律按「离得很远」处理，
 *     所以折叠模式下切出来的块和全量模式一致。
 *   - start 指向块里**第一行改动**（不含前面的上下文行），因为「定位到不同处」
 *     要停在改动本身上面。
 *   - 退化成整块替换（truncated）时，整个文件就是 1 块。
 */
export function diffHunks(lines) {
  const hunks = [];
  let current = null;
  // 自上一行改动以来，显示上隔了多少行「没变更」的行
  let unchangedSince = HUNK_SEPARATION + 1;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.kind === 'gap') {
      // ⋯ 表示这里省略了一大段没变更的内容：离得足够远，下一处改动要另起一块
      unchangedSince = HUNK_SEPARATION + 1;
      continue;
    }
    if (line.kind !== 'add' && line.kind !== 'del') {
      unchangedSince += 1;
      continue;
    }
    if (current === null || unchangedSince > HUNK_SEPARATION) {
      current = { start: index, end: index, added: 0, removed: 0 };
      hunks.push(current);
    }
    current.end = index;
    if (line.kind === 'add') current.added += 1;
    else current.removed += 1;
    unchangedSince = 0;
  }
  return hunks;
}

/**
 * 生成一份可直接渲染的逐行差异。
 *
 * 干什么：对外的主入口，把两段文本变成界面要画的那些行。
 * 参数：
 *   before —— 修改前的文本（null 表示文件原本不存在）
 *   after  —— 修改后的文本（null 表示文件已被删除）
 *   options.context  —— 折叠时上下各留几行上下文，默认 3
 *   options.full     —— true 表示**全量模式**：整个文件都显示，不用 ⋯ 省略任何内容
 *   options.maxLines —— 全量模式的行数上限，默认 MAX_DISPLAY_LINES
 * 返回：{ lines, hunks, added, removed, truncated, elided, totalLines, kind }
 *   hunks 是差异块列表（见 diffHunks），供界面做「上一处 / 下一处」跳转；
 *   elided 为 true 表示「文件太大，已退回折叠显示」（界面要写明，不能悄悄省略）；
 *   totalLines 是全量显示时本应有的行数；
 *   kind 是这次变更的形态：'create'（新建）/ 'delete'（删除）/ 'modify'（修改）/ 'same'（无变化）
 * 注意：before 与 after 完全相同（含仅末尾换行不同）时，lines 为空、hunks 为空、kind 为 'same'。
 */
export function buildDiff(before, after, options = {}) {
  const context = Number.isInteger(options.context) && options.context >= 0
    ? options.context
    : DEFAULT_CONTEXT;
  const full = options.full === true;
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0
    ? options.maxLines
    : MAX_DISPLAY_LINES;

  const a = splitLines(before);
  const b = splitLines(after);

  const existedBefore = before !== null && before !== undefined;
  const existsAfter = after !== null && after !== undefined;
  const kind = !existedBefore && existsAfter
    ? 'create'
    : existedBefore && !existsAfter
      ? 'delete'
      : 'modify';

  // 掐掉公共前缀，减少参与比较的行数
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  // 再掐掉公共后缀（注意不要越过前缀的边界）
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const coarseMode = midA.length * midB.length > MAX_CELLS
    || midA.length > MAX_LINES_PER_SIDE
    || midB.length > MAX_LINES_PER_SIDE;

  // 前缀 + 中间 + 后缀拼成完整操作序列，行号在最后统一加回偏移量
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ kind: 'equal', aIndex: i, bIndex: i, text: a[i] });
  for (const op of diffOps(midA, midB)) {
    ops.push({
      kind: op.kind,
      aIndex: op.aIndex === -1 ? -1 : start + op.aIndex,
      bIndex: op.bIndex === -1 ? -1 : start + op.bIndex,
      text: op.text,
    });
  }
  const suffix = Math.min(a.length - endA, b.length - endB);
  for (let d = 0; d < suffix; d++) {
    ops.push({ kind: 'equal', aIndex: endA + d, bIndex: endB + d, text: a[endA + d] });
  }

  // 全量模式：先把整个文件都算出来；行数超过上限时再退回折叠显示并标记 elided
  const display = toDisplayLines(ops, full ? Infinity : context, coarseMode);
  let rendered = display;
  let elided = false;
  if (full && display.lines.length > maxLines) {
    rendered = toDisplayLines(ops, context, coarseMode);
    elided = true;
  }

  return {
    ...rendered,
    hunks: diffHunks(rendered.lines),
    elided,
    totalLines: display.lines.length,
    kind: rendered.lines.length === 0 ? 'same' : kind,
  };
}

/**
 * 只算增删行数，不构造逐行结果（列表里显示 +12 / -3 用）。
 * 参数：before / after 同上。返回：{ added, removed }。
 * 注意：
 *   - 大文件会走退化路径，此时统计的是整块替换的行数，属于有意为之的近似。
 *   - 增删计数与上下文行数无关，所以这里用 context: 0，少算一堆用不上的行。
 */
export function countChanges(before, after) {
  const d = buildDiff(before, after, { context: 0 });
  return { added: d.added, removed: d.removed };
}
