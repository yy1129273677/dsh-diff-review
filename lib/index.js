/**
 * dsh-diff-review —— 宿主半（Node 侧）
 *
 * 干什么（这个插件解决什么问题）：
 *   DSH 的 agent 直接改磁盘文件，改完你只能在对话里看到一条工具卡片。
 *   本插件把「这次会话改了哪些文件」攒成一份清单，并把它和修改前后的原文
 *   一起交给客户端半的界面，让你能像 Trae 那样：点开一个文件看逐行差异，
 *   再决定「保留」还是「撤销」。
 *
 * 数据从哪来（为什么不自己读文件）：
 *   `write` / `edit` 工具的成功返回值本身就是 `{ path, before, after }`，
 *   这是权威的修改前后全文，零额外 IO、零竞态（见 dsh-tool-fs 的
 *   `presentationMeta` 就是用同一份 value 算 diff 的）。
 *   所以在 `tools/post-execute` 瀑布里读 `result.value` 即可，
 *   不必去碰 `fs/write-intent`（那是单槽决策瀑布，抢槽会破坏
 *   dsh-fs-observation-policy 的防护语义）。
 *
 * 对外提供三个路由（都走 connection 的认证栅栏，落在 /api/ 下）：
 *   GET  /api/dsh-diff-review/state  —— 清单（不含正文，轻量）
 *   GET  /api/dsh-diff-review/file   —— 单个文件的逐行差异与正文
 *   POST /api/dsh-diff-review/action —— keep / undo / keep-all / undo-all / clear
 *
 * 注意什么：
 *   - 清单只活在 Host 进程内，DSH 重启后清空（与官方 workspace-changes 的既定行为一致）。
 *   - 「保留」不改磁盘，只是把你的确认记下来；「撤销」才会把原文写回去。
 *   - 撤销「新建文件」时 ctx.fs 没有删除原语，只能退出 ctx.fs 用 node:fs 删除，
 *     并且必须先确认文件内容仍是我们记录的那一份，避免误删你自己后来的修改。
 */

import { unlink } from 'node:fs/promises';
import { buildDiff } from './diff.js';

export const name = 'dsh-diff-review';

/**
 * 装配依赖：
 *   connection —— 注册 /api/* 认证路由（客户端用同源 fetch 读）
 *   fs         —— 撤销时把原文写回（带版本防护）
 * 若某个服务缺失，本插件不会加载（cordis 的 inject 语义），而不是半死不活。
 */
export const inject = ['connection', 'fs'];

/** 能提供 before/after 全文的工具（其余工具忽略）。str_replace_editor 是 Claude Code 风格工具名。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

/** 清单里最多留多少条（含已处理的），超出后先丢最老的已处理记录。 */
const MAX_ENTRIES = 200;

/** 单侧正文的字节上限：超过就不保存正文，只留一条「过大」提示（也就无法撤销）。 */
const MAX_TEXT_BYTES = 512 * 1024;

/** 上下文行数：与 DSH 自带 DiffBlock 的 3 行保持一致。 */
const CONTEXT_LINES = 3;

/**
 * 把一个字符串按 UTF-8 字节数判断是否超限。
 * 参数：text —— 待测文本（null 视为 0 字节）。
 * 返回：字节数。
 */
function byteLength(text) {
  if (typeof text !== 'string') return 0;
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 算一条改动的「增删行数摘要」，供清单列表直接显示。
 *
 * 干什么：
 *   列表每行右边的 +N/-M 原本是界面自己按需拉正文算的，于是有两个毛病：
 *   没点开过的文件没有数字；**同一个文件被再次改动（记录被合并）之后，
 *   界面还显示上一轮的数字**。改成宿主在记录/合并的那一刻算好、随清单下发，
 *   界面就完全不依赖自己那份缓存了。
 *
 * 参数：
 *   before / after —— 修改前后全文（null 表示新建 / 删除）。
 *   oversized      —— 是否因为正文过大而没有保存内容（那就只剩 0/0）。
 * 返回：{ added, removed, kind }。
 * 注意：只在这里算一次（记录或合并时），轮询清单不会重复计算。
 */
function summarize(before, after, oversized) {
  if (oversized || (before === null && after === null)) {
    return { added: 0, removed: 0, kind: 'same' };
  }
  // context: 0 —— 只要增删计数，不需要上下文行，省掉一大半计算
  const diff = buildDiff(before, after, { context: 0 });
  return { added: diff.added, removed: diff.removed, kind: diff.kind };
}

/**
 * 从工具执行上下文里取出「这次改动属于哪个会话」。
 *
 * 干什么：清单要按会话分组，撤销时也要用会话的 cwd 去解析相对路径。
 * 参数：exec —— tools/post-execute 的 exec（含 name / arguments / agent）。
 * 返回：{ sessionId, cwd, session }，取不到时字段为 undefined。
 * 注意：exec 可被复用为撤销时的 actor（补发 fs/observed 用），所以这里也把它带出来。
 */
function sessionOf(exec) {
  const session = exec?.agent?.session;
  return {
    sessionId: typeof session?.id === 'string' ? session.id : undefined,
    cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined,
    session,
  };
}

/**
 * 创建清单存储。为 HMR / 卸载安全，状态全部关在这个闭包里。
 *
 * 返回：一个对象，暴露 record / list / get / keep / drop / clear / size。
 * 注意：同一次会话里对同一路径的连续改动会合并成一条（保留最早的 before、
 *       最新的 after），这样「撤销」还原的是这一轮开始前的样子，
 *       与 Trae 里一个文件只有一条待审记录的手感一致。
 */
function createStore() {
  /** @type {Map<string, any>} id -> 记录，插入顺序即时间顺序 */
  const entries = new Map();
  /** @type {Map<string, string>} `${sessionId}\0${path}` -> 待审记录的 id（用于合并） */
  const pendingByPath = new Map();
  let seq = 0;
  let rev = 0;

  /** 变更计数：任何写操作都 +1，客户端据此判断要不要重新拉取。 */
  function touch() {
    rev += 1;
  }

  /** 由会话 id 与路径算出合并键；没有会话时退化成只用路径。 */
  function keyOf(sessionId, path) {
    return `${sessionId ?? ''}\u0000${path}`;
  }

  /** 超出上限时淘汰最老的「已处理」记录；全是待审就不淘汰（待审优先保留）。 */
  function trim() {
    if (entries.size <= MAX_ENTRIES) return;
    for (const [id, entry] of entries) {
      if (entry.status === 'pending') continue;
      entries.delete(id);
      if (entries.size <= MAX_ENTRIES) return;
    }
  }

  return {
    /** 写入或合并一条改动。返回最终那一条记录。 */
    record(input) {
      const key = keyOf(input.sessionId, input.path);
      const existingId = pendingByPath.get(key);
      const existing = existingId ? entries.get(existingId) : undefined;

      if (existing && existing.status === 'pending') {
        // 合并：保留最早的 before，换上最新的 after；正文一起重新判超限
        existing.after = input.after;
        existing.tool = input.tool;
        existing.updatedAt = input.ts;
        existing.afterOversized = byteLength(input.after) > MAX_TEXT_BYTES;
        existing.undoable = !existing.beforeOversized && !existing.afterOversized;
        if (existing.afterOversized) existing.after = null;
        // 差异摘要要跟着新的 after 重算，否则清单里会留着上一轮的 +N/-M
        Object.assign(existing, summarize(existing.before, existing.after, !existing.undoable));
        touch();
        return existing;
      }

      seq += 1;
      const beforeOversized = byteLength(input.before) > MAX_TEXT_BYTES;
      const afterOversized = byteLength(input.after) > MAX_TEXT_BYTES;
      const entry = {
        id: `c${seq}`,
        sessionId: input.sessionId,
        cwd: input.cwd,
        path: input.path,
        display: input.display,
        tool: input.tool,
        status: 'pending',
        before: beforeOversized ? null : input.before,
        after: afterOversized ? null : input.after,
        beforeOversized,
        afterOversized,
        // 撤销需要原文；任一侧过大都做不到，界面据此禁用按钮
        undoable: !beforeOversized && !afterOversized,
        // 撤销成功后补发 fs/observed 要用的 actor
        actor: input.actor,
        createdAt: input.ts,
        updatedAt: input.ts,
        note: undefined,
      };
      // 清单里的 +N/-M 由宿主一次性算好随清单下发（见 summarize）
      Object.assign(entry, summarize(entry.before, entry.after, !entry.undoable));
      entries.set(entry.id, entry);
      pendingByPath.set(key, entry.id);
      trim();
      touch();
      return entry;
    },

    /** 列出全部记录（新→旧给界面用，这里按插入顺序返回，客户端自行排序）。 */
    list() {
      return [...entries.values()];
    },

    get(id) {
      return entries.get(id);
    },

    /** 标记为已保留。保留不动磁盘，只更新状态。 */
    keep(id) {
      const entry = entries.get(id);
      if (!entry) return { ok: false, error: 'not-found' };
      if (entry.status === 'pending') {
        entry.status = 'kept';
        pendingByPath.delete(keyOf(entry.sessionId, entry.path));
        touch();
      }
      return { ok: true, entry };
    },

    /** 标记撤销成功。 */
    reverted(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.status = 'reverted';
      entry.before = entry.before ?? null;
      pendingByPath.delete(keyOf(entry.sessionId, entry.path));
      touch();
    },

    /** 撤销失败时留下原因，状态仍是待审，用户可以重试。 */
    fail(id, note) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.note = note;
      touch();
    },

    /** 把一条记录彻底移出清单。 */
    drop(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id);
      pendingByPath.delete(keyOf(entry.sessionId, entry.path));
      touch();
    },

    clear(scope) {
      for (const [id, entry] of [...entries]) {
        if (scope === 'all' || entry.status === scope) entries.delete(id);
      }
      // 重建待审索引
      pendingByPath.clear();
      for (const [id, entry] of entries) {
        if (entry.status === 'pending') pendingByPath.set(keyOf(entry.sessionId, entry.path), id);
      }
      touch();
    },

    get rev() {
      return rev;
    },

    get size() {
      return entries.size;
    },
  };
}

/**
 * 把一条记录整理成可以安全发给浏览器的清单项（不含正文）。
 *
 * 参数：entry —— 存储里的记录。
 * 返回：轻量对象；正文只在 /file 路由里单独取。
 * 注意：added / removed / kind 是记录或合并时就算好的（见 summarize），
 *       界面直接用它们画列表，不必为了显示一个数字去拉每个文件的正文。
 */
function toListItem(entry) {
  return {
    id: entry.id,
    sessionId: entry.sessionId ?? null,
    cwd: entry.cwd ?? null,
    path: entry.path,
    display: entry.display ?? entry.path,
    tool: entry.tool,
    status: entry.status,
    oversized: !!(entry.beforeOversized || entry.afterOversized),
    undoable: entry.undoable,
    added: entry.added ?? 0,
    removed: entry.removed ?? 0,
    kind: entry.kind ?? 'same',
    note: entry.note ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/**
 * 解析「这次撤销该用哪套文件沙箱策略」。
 *
 * 干什么：
 *   修一个实测出来的坑——`dsh-fs-sandbox` 的 `checkedTarget()` 在**没收到 per-call
 *   policy 时**会回落到 `ctx.sandboxPolicy.resolve()`，那是「部署默认模式 + 进程 cwd」，
 *   没有会话工作区根目录。于是哪怕要撤销的文件就在会话工作区里，`workspace-write`
 *   也判定「不在任何可写根之下」，直接抛 FS_SANDBOX_DENIED，撤销永远失败。
 *   所以必须像官方 `dsh-tool-fs` 那样，按「产生这条改动的那个会话」解析策略。
 *
 * 参数：
 *   ctx   —— cordis 上下文（没有沙箱后端时也没有 sandboxPolicy 服务）。
 *   entry —— 清单记录；`entry.actor` 就是当初那次工具调用的 exec，里面带着会话。
 * 返回：
 *   形如 `{ mode, workspaceRoot }` 的策略对象；拿不到服务时返回 undefined
 *   （undefined 在未装沙箱后端的部署里表示「不设限」，与官方语义一致）。
 * 注意：
 *   刻意不把 sandboxPolicy 写进 `inject`——用 dsh-fs-local 的部署根本没有这个服务，
 *   写进 inject 会让整个插件不加载。这里取不到就退回无策略。
 */
function sandboxPolicyOf(ctx, entry) {
  try {
    const service = ctx.get('sandboxPolicy');
    if (!service || typeof service.resolve !== 'function') return undefined;
    const session = entry.actor?.agent?.session;
    return service.resolve(session === undefined ? {} : { session });
  } catch {
    return undefined;
  }
}

/**
 * 撤销一条记录：把 before 全文写回磁盘。
 *
 * 干什么：这是「撤销」按钮的唯一实现。
 * 参数：
 *   ctx   —— cordis 上下文（需要 ctx.fs / ctx.emit）
 *   entry —— 存储里的记录
 * 返回：{ ok: true } 或 { ok: false, error, code }
 * 注意（四条都踩过坑，别删）：
 *   1. 必须先 stat 拿当前 version，用 replaceIfVersion 做 CAS；否则会覆盖你审阅期间的新改动。
 *   2. 直接调 ctx.fs 不会经过 fs-observation-policy，该会话对这条路径的观察状态仍是旧的，
 *      模型下一次 edit 会 FS_STALE_VERSION —— 所以成功后必须用当初的 actor 补发 fs/observed。
 *   3. ctx.fs 没有删除原语，撤销「新建文件」只能退出 ctx.fs 用 node:fs 删除；
 *      删除前必须确认内容仍是记录里的 after，否则宁可失败也不误删。
 *   4. 写回必须显式传 per-call 沙箱策略（见 sandboxPolicyOf），否则会被
 *      dsh-fs-sandbox 按「部署默认」拒绝，撤销对已有文件 100% 失败。
 */
async function undoEntry(ctx, entry) {
  if (!entry.undoable) {
    return { ok: false, error: '正文过大，未保存内容，无法撤销', code: 'TOO_LARGE' };
  }

  const resolveOpts = entry.cwd ? { cwd: entry.cwd } : undefined;
  let target;
  try {
    target = await ctx.fs.resolve(entry.path, resolveOpts);
  } catch (error) {
    return { ok: false, error: `无法定位文件：${messageOf(error)}`, code: 'RESOLVE_FAILED' };
  }

  // —— 情况一：这个文件是 agent 新建的（before === null）→ 撤销即删除 ——
  if (entry.before === null) {
    try {
      const info = await ctx.fs.stat(target);
      if (!info) return { ok: true, note: '文件已不存在，无需撤销' };
      let current = null;
      try {
        current = await ctx.fs.readText(target);
      } catch (error) {
        return { ok: false, error: `无法读取以确认内容：${messageOf(error)}`, code: 'READ_FAILED' };
      }
      if (current !== entry.after) {
        return {
          ok: false,
          error: '文件在你审阅期间又被改过，为避免误删已放弃撤销',
          code: 'FS_STALE_VERSION',
        };
      }
      await unlink(processPathOf(target));
      return { ok: true, note: '已删除新建的文件' };
    } catch (error) {
      return { ok: false, error: `删除失败：${messageOf(error)}`, code: 'UNLINK_FAILED' };
    }
  }

  // —— 情况二：普通修改 → 用当前版本做 CAS，把 before 写回去 ——
  try {
    const info = await ctx.fs.stat(target);
    const expected = info === undefined
      ? { kind: 'createIfAbsent' }
      : { kind: 'replaceIfVersion', version: info.version };
    const outcome = await ctx.fs.writeText(target, entry.before, expected, undefined, sandboxPolicyOf(ctx, entry));
    // 补发观察：让该会话对这条路径重新建立「已读 + 最新版本」的状态
    if (entry.actor) {
      try {
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, entry.actor);
      } catch {
        // 补发失败不影响撤销本身，只是模型下次编辑可能要求重读
      }
    }
    return { ok: true, version: String(outcome.version ?? '') };
  } catch (error) {
    const code = error?.code ?? 'WRITE_FAILED';
    const hint = code === 'FS_STALE_VERSION'
      ? '（文件在审阅期间又被改过，请刷新后重试）'
      : '';
    return { ok: false, error: `写回失败：${messageOf(error)}${hint}`, code };
  }
}

/** 统一把未知错误转成可读文本。 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 取文件在宿主进程里的真实路径，用于 node:fs 删除。
 * fs-local 后端里 targetKey 就是 realpath；取不到时退回 displayPath。
 */
function processPathOf(target) {
  return String(target?.targetKey ?? target?.displayPath ?? '');
}

/**
 * 读取请求体并解析 JSON（POST 用）。
 * 参数：request —— 认证栅栏交进来的 Request（requestBody: 'buffered' 时 body 可读）。
 * 返回：解析后的对象；空体或非法 JSON 返回 {}。
 */
async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 构造一个「不缓存 + JSON」的响应。 */
function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * 插件入口：挂捕获监听与三个路由。
 * 参数：ctx —— cordis 上下文（inject 保证了 connection 与 fs 存在）。
 */
export function apply(ctx) {
  const store = createStore();

  // 卸载 / 热重载时清空清单，避免旧记录残留到新实例
  ctx.effect(() => () => {
    store.clear('all');
  }, 'dsh-diff-review store teardown');

  // —— 捕获：工具执行完之后、进入日志之前 ——
  // 只用纯观测，不调用也不跳过 next()，绝不改变工具结果。
  ctx.on('tools/post-execute', (exec, result, next) => {
    try {
      if (result && !result.isError && WRITE_TOOLS.has(exec?.name)) {
        const value = result?.value;
        const hasBefore = value && typeof value === 'object'
          && (typeof value.before === 'string' || value.before === null);
        const hasAfter = value && typeof value === 'object' && typeof value.after === 'string';
        if (hasBefore && hasAfter) {
          const path = typeof value.path === 'string' && value.path.length > 0
            ? value.path
            : (typeof exec.arguments?.file_path === 'string' ? exec.arguments.file_path : undefined);
          if (path) {
            const { sessionId, cwd } = sessionOf(exec);
            store.record({
              sessionId,
              cwd,
              path,
              display: displayOf(path, cwd),
              tool: exec.name,
              before: value.before,
              after: value.after,
              actor: exec,
              ts: Date.now(),
            });
          }
        }
      }
    } catch {
      // 观测失败绝不能影响 agent 的正常运行
    }
    return next();
  });

  // —— 路由：清单 ——
  ctx.connection.fetch.register({
    path: '/api/dsh-diff-review/state',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => {
      const items = store.list().map(toListItem);
      const pending = items.filter((item) => item.status === 'pending');
      // 新→旧排列，界面直接用
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      return Promise.resolve(json({
        ok: true,
        rev: store.rev,
        pending: pending.length,
        total: items.length,
        entries: items,
      }));
    },
  });

  // —— 路由：单个文件的逐行差异与正文 ——
  ctx.connection.fetch.register({
    path: '/api/dsh-diff-review/file',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const id = new URL(request.url, 'http://localhost').searchParams.get('id') ?? '';
      const entry = store.get(id);
      if (!entry) return Promise.resolve(json({ ok: false, error: 'not-found' }, 404));
      // full: true —— 整个文件都下发给界面，不用 ⋯ 省略未变更的内容。
      // 文件大到超过引擎的 MAX_DISPLAY_LINES 时引擎会自行退回折叠，并把 elided 置真，
      // 由界面写明「已折叠」，而不是悄悄省略。
      const diff = entry.undoable
        ? buildDiff(entry.before, entry.after, { context: CONTEXT_LINES, full: true })
        : { lines: [], hunks: [], added: 0, removed: 0, truncated: false, elided: false, totalLines: 0, kind: 'same' };
      return Promise.resolve(json({
        ok: true,
        entry: toListItem(entry),
        diff,
        before: entry.before,
        after: entry.after,
      }));
    },
  });

  // —— 路由：动作（保留 / 撤销） ——
  ctx.connection.fetch.register({
    path: '/api/dsh-diff-review/action',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson(request);
      const action = typeof body.action === 'string' ? body.action : '';
      const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : [];

      if (action === 'keep' || action === 'drop') {
        const results = ids.map((id) => {
          const result = action === 'keep' ? store.keep(id) : (store.drop(id), { ok: true });
          return { id, ok: result.ok !== false, error: result.error };
        });
        return json({ ok: true, results, rev: store.rev });
      }

      if (action === 'undo') {
        const results = [];
        for (const id of ids) {
          const entry = store.get(id);
          if (!entry) {
            results.push({ id, ok: false, error: 'not-found' });
            continue;
          }
          if (entry.status !== 'pending') {
            results.push({ id, ok: false, error: '已处理过' });
            continue;
          }
          const outcome = await undoEntry(ctx, entry);
          if (outcome.ok) {
            store.reverted(id);
            results.push({ id, ok: true, note: outcome.note ?? null });
          } else {
            store.fail(id, outcome.error);
            results.push({ id, ok: false, error: outcome.error, code: outcome.code });
          }
        }
        return json({ ok: true, results, rev: store.rev });
      }

      if (action === 'keep-all' || action === 'undo-all') {
        const pendingIds = store.list().filter((entry) => entry.status === 'pending').map((entry) => entry.id);
        if (action === 'keep-all') {
          for (const id of pendingIds) store.keep(id);
          return json({ ok: true, count: pendingIds.length, rev: store.rev });
        }
        const results = [];
        for (const id of pendingIds) {
          const entry = store.get(id);
          const outcome = await undoEntry(ctx, entry);
          if (outcome.ok) {
            store.reverted(id);
            results.push({ id, ok: true });
          } else {
            store.fail(id, outcome.error);
            results.push({ id, ok: false, error: outcome.error, code: outcome.code });
          }
        }
        return json({ ok: true, results, rev: store.rev });
      }

      if (action === 'clear') {
        store.clear(body.scope === 'all' ? 'all' : 'kept');
        return json({ ok: true, rev: store.rev });
      }

      return json({ ok: false, error: `未知动作：${action || '(空)'}` }, 400);
    },
  });
}

/**
 * 生成界面显示用的短路径。
 *
 * 干什么：把绝对路径压成「相对工作目录」或「~/…」，让清单更好扫。
 * 参数：path —— 记录里的路径；cwd —— 该会话的工作目录。
 * 返回：显示用字符串。
 * 注意：只做展示，撤销时仍用原始 path + cwd 去 resolve。
 */
function displayOf(path, cwd) {
  if (typeof path !== 'string' || path.length === 0) return String(path ?? '');
  if (cwd) {
    const normalizedCwd = cwd.replace(/[\\/]+$/, '');
    if (path === normalizedCwd) return '.';
    for (const sep of ['\\', '/']) {
      const prefix = normalizedCwd + sep;
      if (path.startsWith(prefix)) return path.slice(prefix.length).split('\\').join('/');
    }
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home && path.startsWith(home)) return `~${path.slice(home.length).split('\\').join('/')}`;
  return path.split('\\').join('/');
}
