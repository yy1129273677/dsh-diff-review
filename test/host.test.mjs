/**
 * lib/index.js（宿主半）的集成测试。
 *
 * 跑法：`node test/host.test.mjs`
 *
 * 思路：宿主插件只依赖 cordis 上下文里很少的几个能力，所以这里用假 ctx
 * 把它装配起来（收集 post-execute 监听与三个路由），然后像 DSH 一样
 * 依次调用它们，验证：捕获 → 清单 → 逐行差异 → 保留 → 撤销。
 * 这样即使不启动 DSH，核心逻辑也能被钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { name, inject, apply } from '../lib/index.js';

/** 测试用的临时文件放在系统临时目录：源码树里不留任何写入痕迹，也便于插件装在任意盘符。 */
const TMP_FILE = path.join(tmpdir(), `dsh-diff-review-test-${process.pid}.txt`);

/**
 * 造一个最小的假 cordis 上下文。
 *
 * 参数：overrides —— 覆盖默认的 ctx.fs 行为（撤销相关的用例需要）。
 * 返回：{ ctx, routes, emit, fs }，其中 routes 是注册到 connection.fetch 的路由表。
 * 注意：ctx.effect 在这里直接执行回调（真实的 cordis 会托管其生命周期），
 *       测试不需要卸载语义。
 */
function makeCtx(overrides = {}) {
  const routes = new Map();
  const emitted = [];
  const fsCalls = [];
  const fs = Object.assign({
    async resolve(target) {
      return { targetKey: target, displayPath: target };
    },
    async stat() {
      return { version: 'v2', type: 'file', size: 3 };
    },
    async readText() {
      return 'after-content';
    },
    async writeText(target, content, expected, signal, policy) {
      fsCalls.push({ target, content, expected, policy });
      return { operation: 'update', version: 'v3', before: 'after-content', after: content };
    },
  }, overrides.fs || {});

  const ctx = {
    effect(fn) {
      const disposer = fn();
      void disposer;
    },
    on(event, handler) {
      ctx.handlers.set(event, handler);
    },
    handlers: new Map(),
    emit(...args) {
      emitted.push(args);
    },
    fs,
    // ctx.get 是 cordis 读取「可选服务」的入口；默认没有 sandboxPolicy 服务，
    // 用例可以通过 overrides.get 注入一个假的。
    get(name) {
      return overrides.get ? overrides.get(name) : undefined;
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => {};
        },
      },
    },
  };
  return { ctx, routes, emitted, fs, fsCalls };
}

/** 取某个已注册路由的响应体（routes 里的 fetch 返回 Response）。 */
async function callRoute(routes, routePathWithQuery, init) {
  // 路由表按纯路径做键，查询串只进 Request
  const [routePath] = routePathWithQuery.split('?');
  const route = routes.get(routePath);
  assert.ok(route, `路由未注册：${routePath}`);
  const method = (init && init.method) || 'GET';
  assert.ok(route.methods.includes(method), `路由 ${routePath} 不支持 ${method}`);
  const request = new Request(`http://localhost${routePathWithQuery}`, init);
  const response = await route.fetch(request);
  const body = await response.json();
  return { status: response.status, body };
}

/** 模拟一次成功的 write/edit 工具调用经过 post-execute。 */
function simulateWrite(ctx, value, toolName = 'edit', extra = {}) {
  const handler = ctx.handlers.get('tools/post-execute');
  assert.ok(handler, 'post-execute 监听未注册');
  let calledNext = false;
  const resultValue = {
    path: value.path,
    before: value.before,
    after: value.after,
  };
  handler(
    { name: toolName, arguments: { file_path: value.path }, agent: { session: Object.assign({ id: 'sess-1', header: { cwd: 'C:\\work' } }, extra.session || {}) } },
    { isError: false, value: resultValue },
    () => {
      calledNext = true;
      return Promise.resolve({ kind: 'accept' });
    },
  );
  return { calledNext };
}

test('插件暴露的名字与装配依赖正确', () => {
  assert.equal(name, 'dsh-diff-review');
  assert.deepEqual(inject, ['connection', 'fs']);
});

test('捕获 write/edit 的 before/after，并且必须放行 next()', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);

  const { calledNext } = simulateWrite(ctx, {
    path: 'C:\\work\\src\\a.js',
    before: 'a\nb\nc',
    after: 'a\nX\nc',
  });
  assert.equal(calledNext, true, '必须调用 next()，否则会改变工具结果');

  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.pending, 1);
  assert.equal(state.body.entries.length, 1);
  // 清单路由不携带正文
  assert.equal(state.body.entries[0].before, undefined);
  assert.equal(state.body.entries[0].path, 'C:\\work\\src\\a.js');
  assert.equal(state.body.entries[0].display, 'src/a.js');
});

test('忽略失败结果与非文件工具', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const handler = ctx.handlers.get('tools/post-execute');

  handler({ name: 'read', arguments: {}, agent: undefined }, { isError: false, value: {} }, () => Promise.resolve());
  handler({ name: 'write', arguments: {}, agent: undefined }, { isError: true, value: { path: 'x', before: null, after: 'y' } }, () => Promise.resolve());

  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  assert.equal(state.body.total, 0);
});

test('同一文件的连续改动合并成一条，保留最早的原文', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  simulateWrite(ctx, { path: 'C:\\work\\f.txt', before: 'v1', after: 'v2' });
  simulateWrite(ctx, { path: 'C:\\work\\f.txt', before: 'v2', after: 'v3' });

  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  assert.equal(state.body.total, 1);
  const file = await callRoute(routes, '/api/dsh-diff-review/file?id=' + state.body.entries[0].id);
  assert.equal(file.body.before, 'v1', '撤销要还原到这一轮开始前');
  assert.equal(file.body.after, 'v3');
});

test('file 路由给出逐行差异（增删与行号）', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  simulateWrite(ctx, { path: 'C:\\work\\g.txt', before: 'a\nb\nc', after: 'a\nX\nc' });

  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  const file = await callRoute(routes, '/api/dsh-diff-review/file?id=' + state.body.entries[0].id);
  assert.equal(file.body.diff.added, 1);
  assert.equal(file.body.diff.removed, 1);
  const kinds = file.body.diff.lines.map((line) => line.kind);
  assert.deepEqual(kinds, ['ctx', 'del', 'add', 'ctx']);
  const del = file.body.diff.lines.find((line) => line.kind === 'del');
  assert.equal(del.a, 2);
  assert.equal(del.b, null);
});

test('file 路由把整个文件都发下来（不用 ⋯ 省略未变更内容）', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  // 40 行、两处相距很远的改动：折叠模式下会出现 ⋯，全量模式不该有
  const beforeLines = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);
  const afterLines = beforeLines.slice();
  afterLines[1] = 'X2';
  afterLines[38] = 'X39';
  simulateWrite(ctx, {
    path: 'C:\\work\\long.ts',
    before: beforeLines.join('\n'),
    after: afterLines.join('\n'),
  });

  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  const file = await callRoute(routes, '/api/dsh-diff-review/file?id=' + state.body.entries[0].id);
  const diff = file.body.diff;

  assert.equal(diff.lines.filter((line) => line.kind === 'gap').length, 0, '不应有 ⋯');
  assert.equal(diff.elided, false, '这个尺寸不该触发折叠');
  assert.equal(diff.totalLines, diff.lines.length);
  assert.equal(diff.lines.filter((line) => line.kind === 'ctx').length, 38, '未变更的每一行都要下发');
  // 既然没有 ⋯，差异块就得靠距离切分，否则「上一处/下一处」会并成一块
  assert.equal(diff.hunks.length, 2);
});

test('file 路由的清单项与清单里的计数一致', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  simulateWrite(ctx, { path: 'C:\\work\\m.txt', before: 'a\nb\nc', after: 'a\nX\nY\nc' });
  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  const file = await callRoute(routes, '/api/dsh-diff-review/file?id=' + state.body.entries[0].id);
  assert.equal(file.body.entry.added, state.body.entries[0].added);
  assert.equal(file.body.entry.removed, state.body.entries[0].removed);
  assert.equal(file.body.diff.added, state.body.entries[0].added, '列表数字与展开的差异必须同源');
  assert.equal(file.body.diff.removed, state.body.entries[0].removed);
});

test('keep 只改状态、不动磁盘，随后从待审里消失', async () => {
  const { ctx, routes, fsCalls } = makeCtx();
  apply(ctx);
  simulateWrite(ctx, { path: 'C:\\work\\h.txt', before: 'a', after: 'b' });

  let state = await callRoute(routes, '/api/dsh-diff-review/state');
  const id = state.body.entries[0].id;
  const keep = await callRoute(routes, '/api/dsh-diff-review/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'keep', ids: [id] }),
  });
  assert.equal(keep.body.ok, true);
  assert.equal(fsCalls.length, 0, '保留不应该写文件');

  state = await callRoute(routes, '/api/dsh-diff-review/state');
  assert.equal(state.body.pending, 0);
  assert.equal(state.body.entries[0].status, 'kept');
});

test('undo 用当前版本做 CAS 写回原文，并补发 fs/observed', async () => {
  const { ctx, routes, fsCalls, emitted } = makeCtx();
  apply(ctx);
  simulateWrite(ctx, { path: 'C:\\work\\i.txt', before: 'old', after: 'new' });

  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  const id = state.body.entries[0].id;
  const undo = await callRoute(routes, '/api/dsh-diff-review/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'undo', ids: [id] }),
  });

  assert.equal(undo.body.results[0].ok, true);
  assert.equal(fsCalls.length, 1);
  assert.equal(fsCalls[0].content, 'old', '写回的必须是修改前的全文');
  assert.deepEqual(fsCalls[0].expected, { kind: 'replaceIfVersion', version: 'v2' }, '必须做版本防护');

  const observed = emitted.filter((args) => args[0] === 'fs/observed');
  assert.equal(observed.length, 1, '必须补发 fs/observed，否则模型下次编辑会 FS_STALE_VERSION');
  assert.equal(observed[0][2].kind, 'present');

  const after = await callRoute(routes, '/api/dsh-diff-review/state');
  assert.equal(after.body.pending, 0);
  assert.equal(after.body.entries[0].status, 'reverted');
});

test('撤销遇到 FS_STALE_VERSION 时保留待审状态并回报原因', async () => {
  const { ctx, routes } = makeCtx({
    fs: {
      async writeText() {
        const error = new Error('file changed since it was read');
        error.code = 'FS_STALE_VERSION';
        throw error;
      },
    },
  });
  apply(ctx);
  simulateWrite(ctx, { path: 'C:\\work\\j.txt', before: 'old', after: 'new' });

  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  const id = state.body.entries[0].id;
  const undo = await callRoute(routes, '/api/dsh-diff-review/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'undo', ids: [id] }),
  });

  assert.equal(undo.body.results[0].ok, false);
  assert.equal(undo.body.results[0].code, 'FS_STALE_VERSION');

  const after = await callRoute(routes, '/api/dsh-diff-review/state');
  assert.equal(after.body.pending, 1, '失败了要留在待审里，用户可以重试');
  assert.match(String(after.body.entries[0].note), /重新|stale|变更|改过/i);
});

test('撤销「新建文件」时会删除文件，但内容不符则拒绝删除', async () => {
  const filePath = TMP_FILE;
  const created = 'created by agent';

  // —— 情况一：内容仍是 agent 写的那份 → 允许删除 ——
  await writeFile(filePath, created, 'utf8');
  const first = makeCtx({
    fs: {
      async resolve(target) {
        return { targetKey: target, displayPath: target };
      },
      async stat() {
        return { version: 'v1', type: 'file', size: created.length };
      },
      async readText() {
        return created;
      },
    },
  });
  apply(first.ctx);
  simulateWrite(first.ctx, { path: filePath, before: null, after: created });
  let state = await callRoute(first.routes, '/api/dsh-diff-review/state');
  await callRoute(first.routes, '/api/dsh-diff-review/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'undo', ids: [state.body.entries[0].id] }),
  });
  await assert.rejects(() => access(filePath), '新建的文件应被删除');

  // —— 情况二：内容已被你改过 → 拒绝删除，宁可失败也不误删 ——
  await writeFile(filePath, 'my own edit', 'utf8');
  const second = makeCtx({
    fs: {
      async resolve(target) {
        return { targetKey: target, displayPath: target };
      },
      async stat() {
        return { version: 'v2', type: 'file', size: 11 };
      },
      async readText() {
        return 'my own edit';
      },
    },
  });
  apply(second.ctx);
  simulateWrite(second.ctx, { path: filePath, before: null, after: created });
  state = await callRoute(second.routes, '/api/dsh-diff-review/state');
  const undo = await callRoute(second.routes, '/api/dsh-diff-review/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'undo', ids: [state.body.entries[0].id] }),
  });
  assert.equal(undo.body.results[0].ok, false);
  assert.equal(undo.body.results[0].code, 'FS_STALE_VERSION');
  assert.equal(await readFile(filePath, 'utf8'), 'my own edit', '不能删掉用户自己的修改');
  // 清理本用例自己造的文件，避免污染仓库
  await rm(filePath, { force: true });
});

test('撤销写回必须带上「原会话」解析出的沙箱策略，否则会被沙箱拒绝', async () => {
  // 复刻 dsh-fs-sandbox 的真实行为：没收到 per-call policy 时回落到部署默认
  // （workspace-write + 进程 cwd，没有会话工作区根），于是写回必然 FS_SANDBOX_DENIED。
  // 这个用例就是那次实机验证里撤销失败的复现。
  const policyRequests = [];
  const { ctx, routes, fsCalls } = makeCtx({
    get(name) {
      if (name !== 'sandboxPolicy') return undefined;
      return {
        resolve(request) {
          policyRequests.push(request);
          return { mode: 'workspace-write', workspaceRoot: 'C:\\work' };
        },
      };
    },
    fs: {
      async writeText(target, content, expected, signal, policy) {
        fsCalls.push({ target, content, expected, policy });
        if (policy === undefined || policy.workspaceRoot !== 'C:\\work') {
          const error = new Error(`cannot write "${target}": file access denied under workspace-write mode`);
          error.code = 'FS_SANDBOX_DENIED';
          throw error;
        }
        return { operation: 'update', version: 'v3', before: 'new', after: content };
      },
    },
  });
  apply(ctx);
  simulateWrite(ctx, { path: 'C:\\work\\k.txt', before: 'old', after: 'new' });

  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  const undo = await callRoute(routes, '/api/dsh-diff-review/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'undo', ids: [state.body.entries[0].id] }),
  });

  assert.equal(undo.body.results[0].ok, true, '带上策略后写回应成功');
  assert.equal(fsCalls[0].policy.workspaceRoot, 'C:\\work', '策略的工作区根必须来自原会话');
  assert.equal(policyRequests.length, 1);
  assert.equal(policyRequests[0].session.id, 'sess-1', '必须按产生这条改动的会话解析策略');
});

test('没有沙箱策略服务时撤销照常可用（sandboxPolicy 只能可选读取，不能进 inject）', async () => {
  const { ctx, routes, fsCalls } = makeCtx();
  apply(ctx);
  simulateWrite(ctx, { path: 'C:\\work\\l.txt', before: 'old', after: 'new' });

  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  const undo = await callRoute(routes, '/api/dsh-diff-review/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'undo', ids: [state.body.entries[0].id] }),
  });

  assert.equal(undo.body.results[0].ok, true);
  assert.equal(fsCalls[0].policy, undefined, '无沙箱服务时不传策略，交给未设限的后端');
  assert.deepEqual(inject, ['connection', 'fs'], '写进 inject 会让没装沙箱后端的部署整个不加载');
});

test('清单项带增删计数，且同一文件被再次改动后会重算（否则列表显示旧数字）', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  simulateWrite(ctx, { path: 'C:\\work\\n.txt', before: 'a\nb\nc\nd', after: 'a\nX\nc\nd' });

  let state = await callRoute(routes, '/api/dsh-diff-review/state');
  assert.equal(state.body.entries[0].added, 1, '首轮新增数');
  assert.equal(state.body.entries[0].removed, 1, '首轮删除数');
  assert.equal(state.body.entries[0].kind, 'modify');

  // 同一个文件再改一次：记录会被合并（before 仍是最早的原文）
  //   改前 a,b,c,d → 改后 a,X,c,Y,d：删掉 b，插入 X 与 Y
  simulateWrite(ctx, { path: 'C:\\work\\n.txt', before: 'a\nX\nc\nd', after: 'a\nX\nc\nY\nd' });
  state = await callRoute(routes, '/api/dsh-diff-review/state');
  assert.equal(state.body.entries.length, 1, '仍然只有一条（合并）');
  assert.equal(state.body.entries[0].added, 2, '合并后要按新的 after 重算：多了 X 与 Y');
  assert.equal(state.body.entries[0].removed, 1, '相对最早的 before，只删了 b');
});

test('新建文件的清单项计数是纯新增', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  simulateWrite(ctx, { path: 'C:\\work\\new.txt', before: null, after: 'x\ny\nz' }, 'write');
  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  assert.equal(state.body.entries[0].kind, 'create');
  assert.equal(state.body.entries[0].added, 3);
  assert.equal(state.body.entries[0].removed, 0);
});

test('未知动作返回 400，不抛异常', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const response = await callRoute(routes, '/api/dsh-diff-review/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'nope' }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
});

test('正文超过上限时标记 oversized 且禁止撤销', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const huge = 'x'.repeat(512 * 1024 + 1);
  simulateWrite(ctx, { path: 'C:\\work\\big.txt', before: huge, after: 'small' });

  const state = await callRoute(routes, '/api/dsh-diff-review/state');
  assert.equal(state.body.entries[0].oversized, true);
  assert.equal(state.body.entries[0].undoable, false);

  const undo = await callRoute(routes, '/api/dsh-diff-review/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'undo', ids: [state.body.entries[0].id] }),
  });
  assert.equal(undo.body.results[0].ok, false);
  assert.equal(undo.body.results[0].code, 'TOO_LARGE');
});
