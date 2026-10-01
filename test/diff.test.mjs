/**
 * lib/diff.js 的单元测试。
 *
 * 跑法：在本目录下执行 `node --test test/`
 * 这些用例钉住的是「界面会显示成什么样」，所以断言都针对 lines / added / removed / kind。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiff, splitLines, countChanges, diffHunks } from '../lib/diff.js';

/** 把 lines 压成便于断言的紧凑形式：kind + 文本。 */
function shape(diff) {
  return diff.lines.map((line) => `${line.kind}:${line.text}`);
}

test('完全相同的内容不算改动', () => {
  const diff = buildDiff('a\nb\nc', 'a\nb\nc');
  assert.equal(diff.kind, 'same');
  assert.deepEqual(diff.lines, []);
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
});

test('只有末尾换行不同不算改动', () => {
  const diff = buildDiff('a\nb', 'a\nb\n');
  assert.equal(diff.kind, 'same');
  assert.deepEqual(diff.lines, []);
});

test('CRLF 与 LF 视为相同（Windows 上不能整篇标红）', () => {
  const diff = buildDiff('a\r\nb\r\nc\r\n', 'a\nb\nc\n');
  assert.equal(diff.kind, 'same');
  assert.deepEqual(diff.lines, []);
});

test('空文件新增一行', () => {
  const diff = buildDiff('', 'x');
  assert.deepEqual(shape(diff), ['add:x']);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 0);
});

test('新建文件：before 为 null 时为 create，整篇都是新增', () => {
  const diff = buildDiff(null, 'a\nb');
  assert.equal(diff.kind, 'create');
  assert.deepEqual(shape(diff), ['add:a', 'add:b']);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 0);
});

test('删除文件：after 为 null 时为 delete，整篇都是删除', () => {
  const diff = buildDiff('a\nb', null);
  assert.equal(diff.kind, 'delete');
  assert.deepEqual(shape(diff), ['del:a', 'del:b']);
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 2);
});

test('中间改一行：输出改动行与上下文行，且行号正确', () => {
  const diff = buildDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne');
  assert.equal(diff.kind, 'modify');
  assert.deepEqual(shape(diff), [
    'ctx:a',
    'ctx:b',
    'del:c',
    'add:X',
    'ctx:d',
    'ctx:e',
  ]);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);

  // 删除行的旧侧行号是 3，新增行的新侧行号也是 3
  const del = diff.lines.find((line) => line.kind === 'del');
  const add = diff.lines.find((line) => line.kind === 'add');
  assert.equal(del.a, 3);
  assert.equal(del.b, null);
  assert.equal(add.b, 3);
  assert.equal(add.a, null);
  // 上下文行两侧行号都有
  assert.equal(diff.lines[0].a, 1);
  assert.equal(diff.lines[0].b, 1);
});

test('远距离两处改动之间用 gap 收敛，不把整篇都displayed', () => {
  const before = Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join('\n');
  const afterLines = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);
  afterLines[1] = 'X2';
  afterLines[38] = 'X39';
  const diff = buildDiff(before, afterLines.join('\n'));

  const gaps = diff.lines.filter((line) => line.kind === 'gap');
  assert.equal(gaps.length, 1); // 中间那段没变的内容收成一个占位
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
  // 显示行数应远小于 40 行：两处改动各带 3 行上下文
  assert.ok(diff.lines.length < 20, `实际 ${diff.lines.length} 行`);
});

test('context 参数可以调小', () => {
  const diff = buildDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne', { context: 1 });
  // 首尾被省略的未变更行各留一个 ⋯ 占位，提示上下还有内容
  assert.deepEqual(shape(diff), ['gap:⋯', 'ctx:b', 'del:c', 'add:X', 'ctx:d', 'gap:⋯']);
});

test('大改动退化为整块替换并标记 truncated', () => {
  const before = Array.from({ length: 600 }, (_, i) => `old-${i}`).join('\n');
  const after = Array.from({ length: 600 }, (_, i) => `new-${i}`).join('\n');
  const diff = buildDiff(before, after);
  assert.equal(diff.truncated, true);
  assert.equal(diff.added, 600);
  assert.equal(diff.removed, 600);
  assert.equal(diff.lines.filter((line) => line.kind === 'ctx').length, 0);
});

test('增加与删除混合时统计正确', () => {
  const diff = buildDiff('a\nb\nc', 'a\nX\nY\nc');
  assert.equal(diff.removed, 1); // b
  assert.equal(diff.added, 2); // X, Y
  assert.equal(diff.kind, 'modify');
});

test('splitLines 处理空串、null 与末尾换行', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines(null), []);
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  // 只含一个换行的文件 = 一行空行；空字符串才是「没有行」
  assert.deepEqual(splitLines('\n'), ['']);
});

test('countChanges 只回行数', () => {
  assert.deepEqual(countChanges('a\nb', 'a\nb\nc'), { added: 1, removed: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// 差异块（界面「上一处 / 下一处」的跳转单位）
// ─────────────────────────────────────────────────────────────────────────────

test('没有改动时没有差异块', () => {
  assert.deepEqual(diffHunks([]), []);
  assert.deepEqual(buildDiff('a\nb', 'a\nb').hunks, []);
});

test('单处改动就是 1 个差异块，且 start/end 都落在改动行上', () => {
  const diff = buildDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne');
  assert.equal(diff.hunks.length, 1);
  const hunk = diff.hunks[0];
  // 显示行是 ctx:a ctx:b del:c add:X ctx:d ctx:e，改动行在下标 2..3
  assert.equal(hunk.start, 2);
  assert.equal(hunk.end, 3);
  assert.equal(hunk.added, 1);
  assert.equal(hunk.removed, 1);
  assert.equal(diff.lines[hunk.start].kind, 'del');
  assert.equal(diff.lines[hunk.end].kind, 'add');
});

test('相隔很远的两处改动被 ⋯ 切开，算 2 个差异块', () => {
  const before = Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join('\n');
  const afterLines = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);
  afterLines[1] = 'X2';
  afterLines[38] = 'X39';
  const diff = buildDiff(before, afterLines.join('\n'));

  assert.equal(diff.hunks.length, 2);
  assert.equal(diff.hunks[0].added, 1);
  assert.equal(diff.hunks[0].removed, 1);
  assert.equal(diff.hunks[1].added, 1);
  assert.equal(diff.hunks[1].removed, 1);
  // 两块之间必须被 ⋯ 隔开，否则「上一处/下一处」会跳到没变化的位置上
  const between = diff.lines.slice(diff.hunks[0].end + 1, diff.hunks[1].start);
  assert.ok(between.some((line) => line.kind === 'gap'), '两块之间应有 ⋯ 占位');
});

test('挨得近的两处改动（中间上下文没被省略）算同一块', () => {
  // 中间只隔 3 行没变的内容，上下文各留 3 行就完全覆盖了，不会出现 ⋯
  const diff = buildDiff('a\nb\nc\nd\ne\nf\ng\nh', 'a\nB\nc\nd\ne\nF\ng\nh');
  assert.equal(diff.lines.filter((line) => line.kind === 'gap').length, 0);
  assert.equal(diff.hunks.length, 1, '显示上连成一片就该算一个地方');
  assert.equal(diff.hunks[0].added, 2);
  assert.equal(diff.hunks[0].removed, 2);
  assert.equal(diff.lines[diff.hunks[0].start].kind, 'del');
  assert.equal(diff.lines[diff.hunks[0].end].kind, 'add');
});

test('整块替换（truncated）时整个文件算 1 个差异块', () => {
  const before = Array.from({ length: 600 }, (_, i) => `old-${i}`).join('\n');
  const after = Array.from({ length: 600 }, (_, i) => `new-${i}`).join('\n');
  const diff = buildDiff(before, after);
  assert.equal(diff.truncated, true);
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0].added, 600);
  assert.equal(diff.hunks[0].removed, 600);
  assert.equal(diff.hunks[0].start, 0);
  assert.equal(diff.hunks[0].end, diff.lines.length - 1);
});

test('每个差异块的后端计数与整体增删数一致', () => {
  const before = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join('\n');
  const afterLines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`);
  afterLines[0] = 'A1';
  afterLines[10] = 'B11';
  afterLines[29] = 'C30';
  const diff = buildDiff(before, afterLines.join('\n'));

  assert.ok(diff.hunks.length >= 2, `实际 ${diff.hunks.length} 块`);
  const summed = diff.hunks.reduce((acc, hunk) => ({
    added: acc.added + hunk.added,
    removed: acc.removed + hunk.removed,
  }), { added: 0, removed: 0 });
  assert.deepEqual(summed, { added: diff.added, removed: diff.removed });
  // 块内字段必须自洽：start <= end，且都是改动行
  for (const hunk of diff.hunks) {
    assert.ok(hunk.start <= hunk.end);
    assert.ok(hunk.added + hunk.removed > 0);
    assert.ok(['add', 'del'].includes(diff.lines[hunk.start].kind));
    assert.ok(['add', 'del'].includes(diff.lines[hunk.end].kind));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 全量显示（full）：不用 ⋯ 省略任何未变更内容
// ─────────────────────────────────────────────────────────────────────────────

test('全量模式：整个文件都显示出来，一个 ⋯ 都没有', () => {
  const before = Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join('\n');
  const afterLines = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);
  afterLines[1] = 'X2';
  afterLines[38] = 'X39';

  const folded = buildDiff(before, afterLines.join('\n'));
  const full = buildDiff(before, afterLines.join('\n'), { full: true });

  // 折叠版：有 ⋯、行数远小于文件
  assert.equal(folded.lines.filter((line) => line.kind === 'gap').length, 1);
  assert.ok(folded.lines.length < 20, `折叠版实际 ${folded.lines.length} 行`);
  assert.equal(folded.elided, false, '默认不是「因过大而折叠」');

  // 全量版：没有 ⋯，未变更的 38 行全部在场
  assert.equal(full.lines.filter((line) => line.kind === 'gap').length, 0, '全量模式不能有 ⋯');
  assert.equal(full.elided, false);
  assert.equal(full.totalLines, full.lines.length);
  // 38 行没变的 + 2 行删除 + 2 行新增（被替换掉的那两行不再算「没变」）
  assert.equal(full.lines.length, 42);
  const unchanged = full.lines.filter((line) => line.kind === 'ctx');
  assert.equal(unchanged.length, 38, '未变更的每一行都要在');
  // 全量模式下「上一处/下一处」仍然切得出两块，不依赖 ⋯
  assert.equal(full.hunks.length, 2);
});

test('全量模式：改动挨得近算一块，隔得远算两块（不依赖 ⋯）', () => {
  const near = Array.from({ length: 12 }, (_, i) => `L${i + 1}`);
  near[4] = 'A';
  near[7] = 'B';
  const nearDiff = buildDiff(
    Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join('\n'),
    near.join('\n'),
    { full: true },
  );
  assert.equal(nearDiff.lines.filter((line) => line.kind === 'gap').length, 0);
  assert.equal(nearDiff.hunks.length, 1, '中间只隔 2 行没变，算同一个地方');

  const far = Array.from({ length: 40 }, (_, i) => `L${i + 1}`);
  far[2] = 'A';
  far[32] = 'B';
  const farDiff = buildDiff(
    Array.from({ length: 40 }, (_, i) => `L${i + 1}`).join('\n'),
    far.join('\n'),
    { full: true },
  );
  assert.equal(farDiff.lines.filter((line) => line.kind === 'gap').length, 0);
  assert.equal(farDiff.hunks.length, 2, '中间隔了 29 行没变，是两处');
});

test('文件超过渲染上限时退回折叠，并明确标记 elided（不能悄悄省略）', () => {
  const before = Array.from({ length: 60 }, (_, i) => `L${i + 1}`).join('\n');
  const afterLines = Array.from({ length: 60 }, (_, i) => `L${i + 1}`);
  afterLines[1] = 'X2';
  afterLines[58] = 'X59';

  const capped = buildDiff(before, afterLines.join('\n'), { full: true, maxLines: 10 });
  assert.equal(capped.elided, true, '超过了上限就要标记出来');
  assert.ok(capped.totalLines > 10, `全量本应有 ${capped.totalLines} 行`);
  assert.ok(capped.lines.length <= 10 + 4, '折叠后要明显短于全量');
  assert.ok(capped.lines.some((line) => line.kind === 'gap'), '折叠后才会出现 ⋯');
  // 折叠只是少显示未变更内容，改动一处都不能少
  assert.equal(capped.added, 2);
  assert.equal(capped.removed, 2);
});

test('行号不变量：新旧两侧的行号都必须严格递增（防止差异算错位）', () => {
  /** 检查 a / b 两列行号是否严格递增；这是「差异没错位」最硬的判据。 */
  function assertMonotonic(diff, label) {
    let lastA = 0;
    let lastB = 0;
    for (const line of diff.lines) {
      if (line.a !== null) {
        assert.ok(line.a > lastA, `${label}: a 列必须递增，但出现了 ${line.a}（上一个 ${lastA}）`);
        lastA = line.a;
      }
      if (line.b !== null) {
        assert.ok(line.b > lastB, `${label}: b 列必须递增，但出现了 ${line.b}（上一个 ${lastB}）`);
        lastB = line.b;
      }
    }
  }

  const long = Array.from({ length: 60 }, (_, i) => `L${i + 1}`).join('\n');
  const tweaked = Array.from({ length: 60 }, (_, i) => `L${i + 1}`);
  tweaked[1] = 'X2';
  tweaked[30] = 'Y31';
  tweaked[58] = 'Z59';
  const cases = [
    ['小改一行', buildDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne')],
    ['远距离两处', buildDiff(long, tweaked.join('\n'))],
    ['全量模式', buildDiff(long, tweaked.join('\n'), { full: true })],
    ['整块替换', buildDiff(
      Array.from({ length: 600 }, (_, i) => `old-${i}`).join('\n'),
      Array.from({ length: 600 }, (_, i) => `new-${i}`).join('\n'),
    )],
    ['新建文件', buildDiff(null, 'x\ny\nz')],
    ['删除文件', buildDiff('x\ny\nz', null)],
    ['带缩进的真实改动', buildDiff(
      'import {\n  A,\n  B,\n} from "x";\n\nconst a = 1;\n',
      'import {\n  A,\n  B,\n  C,\n} from "x";\n\nconst a = 2;\n',
    )],
  ];
  for (const [label, diff] of cases) assertMonotonic(diff, label);
});
