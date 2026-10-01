/**
 * dsh-diff-review —— 客户端半（浏览器侧）
 *
 * 这个文件是「已经打包好的客户端 bundle」格式，不是普通 ESM：
 * DSH 的加载器只接受 `window.__ModuleLoader__.load({ id, factory })` 这种
 * factory-CJS 外壳，依赖从 factory 注入的 `require` 拿（React 等 9 个基座模块
 * 已被宿主外部化，直接 require 即可）。所以这里不用 JSX、不用 import，
 * 也就完全不需要打包器 —— 手写这个外壳同样合法。
 *
 * 干什么：
 *   在左侧栏底部放一个「变更 N」按钮；点开是审阅面板：
 *   左边是本次会话改过的文件清单，点一个文件右边显示逐行差异，
 *   面板顶部提供「保留 / 撤销」，并支持 Ctrl+Enter 保留、Ctrl+Backspace 撤销。
 *
 * 怎么用：装上插件后点左下角/底部那个按钮，或等有改动时徽标自动亮起。
 *
 * 注意什么：
 *   - 只读 /api/dsh-diff-review/* 三个路由，数据全部来自宿主半的清单。
 *   - 样式只用 DSH 的 --dsw-* 设计 token，因此自动跟随明暗主题。
 *   - 「保留」不改磁盘；「撤销」由宿主把原文写回去。
 */
window.__ModuleLoader__.load({
  id: 'dsh-diff-review',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /** 本模块需要的 cordis 客户端服务：只需要插槽注册能力。 */
    var inject = ['slots'];

    /** 注入到页面里的样式（带前缀 ddr- 避免与宿主样式冲突）。 */
    var CSS = `
.ddr-trigger{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;text-align:left}
.ddr-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ddr-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,#d98600);flex:none}
.ddr-dot[data-empty='true']{background:var(--dsw-alias-label-tertiary);opacity:.5}
.ddr-count{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
/* 面板基准字号由界面动态写在 style 上（见 ZOOM_*），内部一律用 em，
   于是一对「A- / A+」按钮就能把代码和界面文字一起缩放。 */
.ddr-panel{position:fixed;right:16px;bottom:16px;z-index:70;display:flex;flex-direction:column;width:min(920px,calc(100vw - 32px));height:min(580px,calc(100vh - 32px));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 40px rgb(0 0 0 / 22%);overflow:hidden;pointer-events:auto;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.ddr-head{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
/* 全屏：让面板铺满整个应用窗口（不是操作系统的全屏），Esc 退出 */
.ddr-panel[data-fullscreen='true']{inset:0;width:auto;height:auto;max-width:none;max-height:none;border-radius:0;border-width:0;z-index:80}
.ddr-title{font-size:1.08em;font-weight:600}
.ddr-sub{font-size:1em;color:var(--dsw-alias-label-tertiary)}
.ddr-btn{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:1em;padding:4px 10px}
.ddr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ddr-btn:disabled{opacity:.45;cursor:default}
.ddr-btn[data-kind='primary']{border-color:transparent;background:var(--dsw-alias-brand-primary,#0f1115);color:var(--dsw-alias-label-inverse,#fff)}
.ddr-btn[data-kind='danger']:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}
/* 字号调整按钮：等宽一点，避免数字/字母跳动 */
.ddr-zoom{display:flex;align-items:center;gap:4px;flex:none}
.ddr-zoom .ddr-btn{min-width:2.4em;padding:4px 6px;text-align:center;font-variant-numeric:tabular-nums}
.ddr-spacer{flex:1}
.ddr-body{display:flex;min-height:0;flex:1}
.ddr-list{width:280px;flex:none;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:6px}
.ddr-row{display:flex;flex-direction:column;gap:2px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;cursor:pointer;text-align:left;font:inherit;color:var(--dsw-alias-label-secondary)}
.ddr-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ddr-row[data-active='true']{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ddr-row-path{display:flex;align-items:baseline;gap:6px;min-width:0}
.ddr-row-name{font-size:1em;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddr-row-meta{display:flex;align-items:center;gap:6px;font-size:.92em;color:var(--dsw-alias-label-tertiary)}
.ddr-add{color:var(--dsw-alias-state-success-primary)}
.ddr-del{color:var(--dsw-alias-state-error-primary)}
.ddr-tag{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;font-size:.83em;line-height:1.35em}
.ddr-view{flex:1;min-width:0;display:flex;flex-direction:column}
.ddr-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.ddr-bar-path{font-size:1em;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace)}
.ddr-bar-count{font-size:.92em;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ddr-nav{display:flex;align-items:center;gap:4px;flex:none}
/* 滚动容器要 position:relative，行元素的 offsetTop 才是相对它算的（定位靠这个）。
   font 简写负责拿到 DSH 的代码字体与行高，紧跟其后的 font-size 再把它挂到面板基准字号上
   （同一条规则里后者胜出，且行高 1.6 是无单位值，会随字号一起放大）。 */
.ddr-diff{flex:1;overflow:auto;padding:6px 0 20px;position:relative;font:var(--dsw-font-markdown-code-block,12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace);font-size:1em}
.ddr-line{display:grid;grid-template-columns:3.5em 3.5em 1.6em 1fr;min-height:1lh;white-space:pre}
.ddr-gutter{color:var(--dsw-alias-label-tertiary);text-align:right;padding-right:8px;user-select:none}
.ddr-sign{user-select:none;text-align:center}
.ddr-text{padding-right:22px}
.ddr-line[data-kind='del']{background:var(--dsw-alias-code-diff-deleted);box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary)}
.ddr-line[data-kind='del'] .ddr-sign{color:var(--dsw-alias-state-error-primary)}
.ddr-line[data-kind='del'] .ddr-text{color:var(--dsw-alias-state-error-primary)}
.ddr-line[data-kind='add']{background:var(--dsw-alias-code-diff-added);box-shadow:inset 3px 0 0 var(--dsw-alias-state-success-primary)}
.ddr-line[data-kind='add'] .ddr-sign{color:var(--dsw-alias-state-success-primary)}
.ddr-line[data-kind='add'] .ddr-text{color:var(--dsw-alias-state-success-primary)}
.ddr-line[data-kind='gap']{color:var(--dsw-alias-label-tertiary)}
/* 当前「上一处/下一处」定位到的那一块：只把行号染色，不与增删的红绿底打架 */
.ddr-line[data-hunk='active'] .ddr-gutter{color:var(--dsw-alias-brand-primary,#0f1115);font-weight:600}
/* ── 左右对照：一行两格，左边原文、右边现文，改动的那一侧着色 ── */
.ddr-srow{display:grid;grid-template-columns:1fr 1fr;min-height:1lh}
.ddr-side{display:grid;grid-template-columns:3.5em 1.6em 1fr;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.ddr-side + .ddr-side{border-left:1px solid var(--dsw-alias-border-l1)}
/* 一侧没有对应内容时补一块浅灰，让「这边没有」一眼看得出来 */
.ddr-side[data-empty='true']{background:var(--dsw-alias-interactive-bg-hover)}
.ddr-side[data-kind='del']{background:var(--dsw-alias-code-diff-deleted)}
.ddr-side[data-kind='del'] .ddr-sign{color:var(--dsw-alias-state-error-primary)}
.ddr-side[data-kind='del'] .ddr-text{color:var(--dsw-alias-state-error-primary)}
.ddr-side[data-kind='add']{background:var(--dsw-alias-code-diff-added)}
.ddr-side[data-kind='add'] .ddr-sign{color:var(--dsw-alias-state-success-primary)}
.ddr-side[data-kind='add'] .ddr-text{color:var(--dsw-alias-state-success-primary)}
.ddr-srow[data-hunk='active'] .ddr-gutter{color:var(--dsw-alias-brand-primary,#0f1115);font-weight:600}
.ddr-sgap{padding:2px 0 2px 3.5em;color:var(--dsw-alias-label-tertiary)}
/* 对照模式靠换行展示，不再需要横向滚动 */
.ddr-diff[data-split='true']{overflow-x:hidden}
.ddr-empty{display:flex;align-items:center;justify-content:center;flex:1;padding:24px;color:var(--dsw-alias-label-tertiary);font-size:1em;text-align:center}
.ddr-note{padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:.92em;color:var(--dsw-alias-state-error-primary);flex:none}
/* 提示条（例如「文件太大，已折叠未变更部分」）：不是错误，所以用次要文字色 */
.ddr-hint{padding:4px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:.92em;color:var(--dsw-alias-label-tertiary);flex:none}
`;

    /** 中英文案。默认跟随浏览器语言，zh 开头用中文。 */
    var STRINGS = {
      zh: {
        title: '文件变更审阅',
        trigger: '变更审阅',
        pending: (n) => `${n} 个待审`,
        empty: '暂无文件改动。agent 改动文件后会自动出现在这里。',
        pick: '左侧选一个文件查看差异',
        keep: '保留',
        undo: '撤销',
        keepAll: '全部保留',
        undoAll: '全部撤销',
        close: '关闭',
        splitView: '左右对照',
        unifiedView: '统一视图',
        viewHint: '在「左右对照」和「统一视图」之间切换（会记住）',
        fontSmaller: 'A-',
        fontLarger: 'A+',
        fontSmallerHint: '缩小字号（Alt+-）',
        fontLargerHint: '放大字号（Alt+=）',
        fontSizeTitle: (px) => `当前字号 ${px}px（10~24，会被记住）`,
        fullscreen: '全屏',
        exitFullscreen: '退出全屏',
        prevDiff: '上一处',
        nextDiff: '下一处',
        diffCount: (index, total) => `第 ${index}/${total} 处`,
        reverted: '已撤销',
        kept: '已保留',
        oversized: '文件过大，未保存内容',
        elided: (lines) => `文件共 ${lines} 行，超过单屏渲染上限，已折叠未变更部分（改动处仍全部显示）`,
        undoDisabled: '此条无法撤销（未保存修改前的内容）',
        navHint: 'Ctrl+Enter 保留 · Ctrl+Backspace 撤销 · Alt+↑/↓ 上一处/下一处 · Alt+-/= 字号 · Esc 退出全屏或关闭',
        loadFail: '读取失败，稍后重试',
        actionFail: '操作失败',
      },
      en: {
        title: 'Change review',
        trigger: 'Review',
        pending: (n) => `${n} pending`,
        empty: 'No file changes yet. They appear here as the agent edits files.',
        pick: 'Pick a file on the left to see its diff',
        keep: 'Keep',
        undo: 'Undo',
        keepAll: 'Keep all',
        undoAll: 'Undo all',
        close: 'Close',
        splitView: 'Side by side',
        unifiedView: 'Unified view',
        viewHint: 'Switch between side-by-side and unified diff (remembered)',
        fontSmaller: 'A-',
        fontLarger: 'A+',
        fontSmallerHint: 'Smaller text (Alt+-)',
        fontLargerHint: 'Larger text (Alt+=)',
        fontSizeTitle: (px) => `Text size ${px}px (10–24, remembered)`,
        fullscreen: 'Fullscreen',
        exitFullscreen: 'Exit fullscreen',
        prevDiff: 'Prev change',
        nextDiff: 'Next change',
        diffCount: (index, total) => `change ${index}/${total}`,
        reverted: 'Undone',
        kept: 'Kept',
        oversized: 'File too large, content not captured',
        elided: (lines) => `File has ${lines} lines, above the single-view render cap — unchanged regions are collapsed (every change is still shown)`,
        undoDisabled: 'Cannot undo this one (previous content was not captured)',
        navHint: 'Ctrl+Enter keep · Ctrl+Backspace undo · Alt+↑/↓ prev/next change · Alt+-/= text size · Esc exits fullscreen or closes',
        loadFail: 'Load failed, retrying shortly',
        actionFail: 'Action failed',
      },
    };

    /** 当前语言对应的词表。 */
    function strings() {
      var lang = (typeof navigator !== 'undefined' && navigator.language) || 'zh';
      return /^zh/i.test(lang) ? STRINGS.zh : STRINGS.en;
    }

    // —— 面板字号（用户偏好） ——
    /** 允许的字号范围与默认值（px）。面板基准字号取这个值，内部全部用 em 跟着缩放。 */
    var FONT_SIZE_MIN = 10;
    var FONT_SIZE_MAX = 24;
    var FONT_SIZE_DEFAULT = 12;
    /** localStorage 里记住字号的键。 */
    var FONT_SIZE_KEY = 'dsh-diff-review:font-size';
    /** localStorage 里记住「左右对照 / 统一视图」的键（'1' 左右，'0' 统一）。 */
    var SPLIT_KEY = 'dsh-diff-review:split-view';

    /**
     * 读一个存在 localStorage 里的字符串偏好。
     *
     * 干什么：字号、左右对照开关这类「看代码的人」的偏好，刷新页面、重启 DSH 之后都该还在。
     * 返回：字符串，或 null（没有记录 / 存储不可用）。
     * 注意：隐私模式或存储被策略禁掉时 localStorage 会**直接抛异常**，
     *   所以整段都包在 try 里，读不到不算错。
     */
    function readPreference(key) {
      try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
      } catch (error) {
        /* 读不了就当没存过 */
      }
      return null;
    }

    /**
     * 写一个字符串偏好。
     * 注意：写失败（配额、隐私模式）静默忽略——本次调整照样生效，只是下次记不住。
     */
    function writePreference(key, value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
      } catch (error) {
        /* 存不了就算了 */
      }
    }

    /**
     * 读出上次记住的字号。
     * 返回：10~24 之间的整数；没有记录、数据坏了、存储不可用，一律退回默认 12。
     */
    function readFontSize() {
      var saved = Number(readPreference(FONT_SIZE_KEY));
      if (Number.isInteger(saved) && saved >= FONT_SIZE_MIN && saved <= FONT_SIZE_MAX) return saved;
      return FONT_SIZE_DEFAULT;
    }

    /** 记住字号。参数：size —— 10~24 的整数。 */
    function saveFontSize(size) {
      writePreference(FONT_SIZE_KEY, String(size));
    }

    /**
     * 读出「是否用左右对照视图」。
     * 返回：布尔值；没存过时**默认开**（用户要的就是左边原文、右边现文）。
     * 注意：只有明确存过 '0' 才算关，别的值（含坏数据）都当默认开。
     */
    function readSplitView() {
      return readPreference(SPLIT_KEY) !== '0';
    }

    /** 记住视图模式。参数：on —— true 表示左右对照。 */
    function saveSplitView(on) {
      writePreference(SPLIT_KEY, on ? '1' : '0');
    }

    /**
     * 把「统一差异」摊成「左右对照」的行。
     *
     * 干什么：
     *   统一差异是一列，每行按顺序标着 ctx / del / add；左右对照要的是每一行里
     *   左边放原文、右边放现文。做法是把一段**连续的改动**（一串 del 与 add）
     *   按顺序一一配对：第 1 个删除配第 1 个新增，多出来的一侧补空白。
     *
     * 参数：lines —— buildDiff() 产出的显示行数组（ctx / del / add / gap）。
     * 返回：{ rows, rowOfLine }
     *   rows      —— 对照后的每一行：{ kind: 'ctx'|'change'|'gap', left, right, li, ri }
     *                left / right 是那一侧的显示行（没有就是 null）；
     *                li / ri 是它们在 lines 里的下标（用来把差异块高亮与滚动定位映射过来）。
     *   rowOfLine —— 数组：lines 的下标 → rows 的下标（「上一处/下一处」定位要用）。
     *
     * 注意：
     *   - 配对只按顺序做，不做块内二次比对——所以「3 行换成 2 行」会显示成
     *     2 行左右都有 + 1 行只有左边，与 VS Code 默认的对照观感一致。
     *   - ctx 行左右各显示一次（同一份内容）；gap 行独占一整行（两侧都不给编号）。
     */
    function buildSideBySide(lines) {
      var rows = [];
      var rowOfLine = new Array(lines.length);
      var index = 0;

      while (index < lines.length) {
        var line = lines[index];

        if (line.kind === 'gap') {
          rowOfLine[index] = rows.length;
          rows.push({ kind: 'gap', left: null, right: null, li: null, ri: null, text: line.text });
          index += 1;
          continue;
        }

        if (line.kind === 'ctx') {
          rowOfLine[index] = rows.length;
          rows.push({ kind: 'ctx', left: line, right: line, li: index, ri: index });
          index += 1;
          continue;
        }

        // 一段连续的改动：先把这一块里的删除行、新增行分别收出来，再一一配对
        var dels = [];
        var adds = [];
        while (index < lines.length && (lines[index].kind === 'del' || lines[index].kind === 'add')) {
          if (lines[index].kind === 'del') dels.push({ line: lines[index], at: index });
          else adds.push({ line: lines[index], at: index });
          index += 1;
        }

        var pairs = Math.max(dels.length, adds.length);
        for (var k = 0; k < pairs; k++) {
          var left = k < dels.length ? dels[k] : null;
          var right = k < adds.length ? adds[k] : null;
          if (left !== null) rowOfLine[left.at] = rows.length;
          if (right !== null) rowOfLine[right.at] = rows.length;
          rows.push({
            kind: 'change',
            left: left === null ? null : left.line,
            right: right === null ? null : right.line,
            li: left === null ? null : left.at,
            ri: right === null ? null : right.at,
          });
        }
      }

      return { rows: rows, rowOfLine: rowOfLine };
    }

    /**
     * 极简可订阅状态容器。
     *
     * 干什么：让两个插槽（侧栏按钮与浮层面板）共享同一份数据与开关状态，
     *   而不必依赖 dsh-client-store（第三方包在平台表里没有它，虽然可用，
     *   但这里只需要「存 + 通知」，自己写更少的耦合面）。
     * 返回：{ get, set, subscribe }。set 用浅合并，subscribe 返回取消订阅函数。
     */
    function createStore(initial) {
      var state = initial;
      var listeners = new Set();
      return {
        get: function () {
          return state;
        },
        set: function (patch) {
          state = Object.assign({}, state, patch);
          listeners.forEach(function (listener) {
            try {
              listener();
            } catch (error) {
              /* 单个订阅者出错不影响其他订阅者 */
            }
          });
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        },
      };
    }

    /** 组合 useSyncExternalStore，让组件订阅上面的容器。 */
    function useStore(React, store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get);
    }

    /**
     * 调用宿主路由并解析 JSON。
     * 参数：path —— 形如 /api/dsh-diff-review/state；options —— fetch 选项。
     * 返回：解析后的对象；HTTP 非 2xx 时抛出携带 status 的错误。
     */
    async function api(path, options) {
      var response = await fetch(path, Object.assign({
        cache: 'no-store',
        credentials: 'same-origin',
      }, options || {}));
      var payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!response.ok) {
        var failure = new Error('http ' + response.status);
        failure.status = response.status;
        failure.payload = payload;
        throw failure;
      }
      return payload;
    }

    /**
     * 插件入口。
     * 参数：ctx —— 客户端 cordis 上下文（inject 保证 slots 存在）。
     */
    function apply(ctx) {
      var React = null;
      try {
        React = require('react');
      } catch (error) {
        // 拿不到 React 就什么都不注册：宁可没有界面，也不能让启动失败
        if (typeof console !== 'undefined') {
          console.warn('[dsh-diff-review] require("react") 失败，界面未注册：', error);
        }
        return;
      }
      if (!React) return;

      var store = createStore({
        open: false,
        fullscreen: false, // 面板是否铺满整个应用窗口
        fontSize: readFontSize(), // 面板基准字号（px），内部用 em 跟着缩放
        split: readSplitView(), // true = 左右对照（默认），false = 统一视图
        rev: -1,
        entries: [], // 宿主返回的**全部**记录（可能含别的会话、已审批的），显示前再筛
        sessionId: null, // 当前正在看的 agent 对话；null = 不知道（退回显示全部）
        pending: 0, // 当前可见的待审条数（侧栏徽标用）
        selectedId: null,
        hunk: 0, // 当前定位到该文件的第几个「差异块」（上一处/下一处）
        files: {}, // id -> /file 的返回
        loading: false,
        error: null,
      });

      /**
       * 从全部记录里挑出「该显示给用户」的那些。
       *
       * 干什么：左侧清单是一份「待办」，所以要多两把筛子：
       *   1. **只留当前对话的**——宿主返回的是所有会话的记录，别的 agent 对话改的文件不该混进来；
       *   2. **已审批的不再占位**——保留/撤销过的（status 不是 pending）直接从清单里消失，
       *      这样点一个就少一个，审批完就自动跳到下一条。
       *
       * 参数：
       *   all       —— 宿主返回的原始清单项。
       *   sessionId —— 当前会话 id；为 null（拿不到 uiSession 服务）时**不过滤会话**，
       *                宁可多显示也不要把用户的改动藏起来。
       * 返回：过滤后的数组（保持宿主给的顺序：新→旧）。
       */
      function visibleEntries(all, sessionId) {
        return all.filter(function (entry) {
          if (entry.status !== 'pending') return false;
          if (sessionId !== null && entry.sessionId !== sessionId) return false;
          return true;
        });
      }

      /**
       * 把宿主返回的清单收进 store，并维护「当前选中哪个文件」。
       *
       * 干什么：清单变化（新的改动、审批掉一条、切换对话）之后，重新算一遍可见列表；
       *   如果原来选中的那个已经不在可见列表里，就自动跳到可见列表的第一条。
       * 参数：
       *   raw —— 宿主返回的全部清单项。
       *   rev —— 清单版本号。
       * 注意：选中的文件一律**强制重拉**差异（理由见 refresh 里的注释）。
       */
      function applyEntries(raw, rev) {
        var state = store.get();
        var visible = visibleEntries(raw, state.sessionId);
        var selection = state.selectedId;
        var stillVisible = visible.some(function (entry) {
          return entry.id === selection;
        });
        if (!stillVisible) selection = visible.length > 0 ? visible[0].id : null;

        var patch = {
          rev: rev,
          entries: raw,
          pending: visible.length,
          selectedId: selection,
          error: null,
        };
        // 换了当前文件就把「第几处」归零，否则会停在上一个文件的序号上
        if (selection !== state.selectedId) patch.hunk = 0;
        store.set(patch);
        if (selection) loadFile(selection, true);
      }

      /** 拉取清单；rev 没变就不重算，避免无谓重渲染。 */
      function refresh() {
        if (typeof document !== 'undefined' && document.hidden) return;
        api('/api/dsh-diff-review/state').then(function (payload) {
          if (payload.rev === store.get().rev) return;
          applyEntries(payload.entries, payload.rev);
        }).catch(function () {
          store.set({ error: strings().loadFail });
        });
      }

      /**
       * 订阅「当前正在看的 agent 对话」，让左侧清单跟着对话切换。       *
       * 干什么：DSH 的客户端服务 `uiSession` 就带着这个信息——`current` 是一个
       *   getSnapshot/subscribe 源，它的绑定对象 `key` 就是当前会话 id（没选中会话时是 undefined）。
       *   实现见 `dsh-client-ui-session` 的 `publishMain()`：它取的是「被 mainView 持有的那个会话」，
       *   也就是用户此刻正在看的对话。
       *
       * 注意：
       *   - 这个服务是**可选**的：拿不到就当「不知道当前会话」，清单退回显示全部（见 visibleEntries）。
       *     也刻意不写进 `inject`，否则缺它的组合会让整个插件不加载。
       *   - 切换对话时 `rev` 不会变，所以不能只靠轮询：这里要主动重算一次可见列表。
       */
      ctx.effect(function () {
        var service = null;
        try {
          // ctx.get 是 cordis 读取「可选服务」的入口；这里连它本身都要防着没有
          service = typeof ctx.get === 'function' ? ctx.get('uiSession') : null;
        } catch (error) {
          service = null;
        }
        var source = service && service.current;
        if (!source || typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') {
          return function () {};
        }

        /** 把当前绑定里的会话 id 同步进 store；变了才写，避免多余重渲染。 */
        function sync() {
          var binding = source.getSnapshot();
          var id = binding && typeof binding.key === 'string' && binding.key.length > 0 ? binding.key : null;
          if (store.get().sessionId === id) return;
          store.set({ sessionId: id });
          // 会话换了：用手里已有的清单立刻重算（否则要等下一次轮询）
          applyEntries(store.get().entries, store.get().rev);
        }

        sync();
        var unsubscribe = source.subscribe(sync);
        return function () {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, 'dsh-diff-review: current session');

      /** 左右对照结果的缓存：diff 对象 → { rows, rowOfLine }（见 sideBySideOf）。 */
      var sideBySideCache = new WeakMap();

      /**
       * 取（并缓存）某个差异的左右对照结果。
       *
       * 干什么：对照要把整个 diff 重排一遍，而面板每次重渲染（轮询、切字号、开关面板）
       *   都会走到这里。用 WeakMap 以 diff 对象为键缓存：同一个差异只算一次，
       *   差异换新对象（重新拉取）时旧条目会被自动回收。
       * 参数：diff —— /file 返回里的 diff 对象。
       * 返回：{ rows, rowOfLine }，或 null（没有差异时）。
       */
      function sideBySideOf(diff) {
        if (!diff || !Array.isArray(diff.lines)) return null;
        var cached = sideBySideCache.get(diff);
        if (cached === undefined) {
          cached = buildSideBySide(diff.lines);
          sideBySideCache.set(diff, cached);
        }
        return cached;
      }

      /**
       * 拉取某个文件的逐行差异与前后全文。
       * 参数：
       *   id    —— 记录 id。
       *   force —— true 表示无视缓存重拉（清单变化时必须重拉，见 applyEntries）。
       * 注意：只有「用户主动点开某个文件」这种场景才允许吃缓存；清单刷新一律 force。
       */
      function loadFile(id, force) {
        var state = store.get();
        if (!id || (!force && state.files[id])) return;
        store.set({ loading: true });
        api('/api/dsh-diff-review/file?id=' + encodeURIComponent(id)).then(function (payload) {
          var files = Object.assign({}, store.get().files);
          files[id] = payload;
          store.set({ files: files, loading: false });
        }).catch(function () {
          store.set({ loading: false, error: strings().loadFail });
        });
      }

      /** 选中文件（并把缓存失效，保证看到最新差异）。 */
      function select(id) {
        var files = Object.assign({}, store.get().files);
        delete files[id];
        // 切文件时把「第几处」归零：定位永远从新文件的第一个差异块开始
        store.set({ selectedId: id, hunk: 0, files: files });
        loadFile(id);
      }

      /**
       * 调整面板字号。
       * 参数：delta —— +1 放大，-1 缩小（单位 px）。
       * 注意：夹在 FONT_SIZE_MIN~FONT_SIZE_MAX 之间；到边界就什么都不做（按钮也会置灰），
       *   成功调整后写进 localStorage，刷新/重启都还在。
       */
      function stepFontSize(delta) {
        var current = store.get().fontSize;
        var next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, current + delta));
        if (next === current) return;
        saveFontSize(next);
        store.set({ fontSize: next });
      }

      /** 提交动作（保留 / 撤销 / 批量）。 */
      function act(action, ids) {
        return api('/api/dsh-diff-review/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: action, ids: ids || [] }),
        }).then(function (payload) {
          var files = {};
          store.set({ files: files, error: null });
          var failures = (payload.results || []).filter(function (result) {
            return result && result.ok === false;
          });
          if (failures.length > 0) {
            store.set({ error: failures[0].error || strings().actionFail });
          }
          refresh();
          return payload;
        }).catch(function () {
          store.set({ error: strings().actionFail });
        });
      }

      // —— 样式与轮询：各注册一次，跟随插件生命周期 ——
      ctx.effect(function () {
        if (typeof document === 'undefined') return function () {};
        if (!document.getElementById('dsh-diff-review-style')) {
          var style = document.createElement('style');
          style.id = 'dsh-diff-review-style';
          style.textContent = CSS;
          (document.head || document.documentElement).appendChild(style);
        }
        return function () {};
      }, 'dsh-diff-review: styles');

      ctx.effect(function () {
        refresh();
        var timer = setInterval(refresh, 2000);
        return function () {
          clearInterval(timer);
        };
      }, 'dsh-diff-review: poll');

      /** 侧栏底部的入口按钮：显示待审数量，点击开关面板。 */
      function Trigger() {
        var state = useStore(React, store);
        var labels = strings();
        var empty = state.pending === 0;
        return React.createElement('button', {
          type: 'button',
          className: 'ddr-trigger',
          onClick: function () {
            var state = store.get();
            // 关面板时顺手退出全屏，避免下次打开莫名其妙铺满整个窗口
            store.set(state.open ? { open: false, fullscreen: false } : { open: true });
          },
          title: labels.navHint,
        }, [
          React.createElement('span', { key: 'dot', className: 'ddr-dot', 'data-empty': String(empty) }),
          React.createElement('span', { key: 'label' }, labels.trigger),
          React.createElement('span', { key: 'count', className: 'ddr-count' },
            empty ? '' : String(state.pending)),
        ]);
      }

      /** 审阅面板：左清单 + 右差异 + 顶部保留/撤销。 */
      function Panel() {
        var state = useStore(React, store);
        var labels = strings();
        // 左侧清单只列「当前 agent 对话改的 + 还没审批的」这两把筛子过完的（见 visibleEntries）
        var pendingEntries = visibleEntries(state.entries, state.sessionId);
        var selected = state.selectedId
          ? pendingEntries.filter(function (entry) {
            return entry.id === state.selectedId;
          })[0]
          : null;
        var file = selected ? state.files[selected.id] : null;
        var position = pendingEntries.findIndex(function (entry) {
          return selected && entry.id === selected.id;
        });

        // —— 差异块：界面「上一处 / 下一处」的跳转单位 ——
        // 切分逻辑放在宿主半（lib/diff.js 的 diffHunks），随 /file 一起下发，
        // 保证只有一份实现；这里只负责序号、定位和滚动。
        var diff = file && file.diff ? file.diff : null;
        var hunks = diff && Array.isArray(diff.hunks) ? diff.hunks : [];
        var hunkCount = hunks.length;
        // 差异可能变短（撤销/保留后重新拉取），序号要夹回合法范围再显示与定位
        var activeHunk = hunkCount === 0 ? -1 : Math.min(Math.max(state.hunk, 0), hunkCount - 1);
        var scrollerRef = React.useRef(null);
        var lineRefs = React.useRef({});
        var fileKey = (selected ? selected.id : '') + '#';

        // —— 左右对照 ——
        // split=true 时把统一差异摊成两列（左=原文、右=现文）；结果按 diff 对象缓存。
        var split = !!state.split;
        var aligned = split ? sideBySideOf(diff) : null;
        // 定位用的 ref 前缀带上视图模式，避免两种布局的下标撞车
        var refPrefix = fileKey + (split ? 'S#' : 'U#');

        /**
         * 造一个行的 ref 回调：把 DOM 节点按「前缀 + 下标」存进表里，供滚动定位查。
         * 参数：key —— 已经拼好的存储键。
         */
        function nodeRef(key) {
          return function (node) {
            if (node) lineRefs.current[key] = node;
          };
        }

        /**
         * 走到「上一处 / 下一处」。
         * 参数：delta —— +1 下一处，-1 上一处。
         * 注意：到两端就回绕（用户选的行为），所以一直点不会卡住。
         */
        function stepHunk(delta) {
          if (hunkCount === 0) return;
          var next = (activeHunk + delta + hunkCount) % hunkCount;
          store.set({ hunk: next });
        }

        /**
         * 渲染左右对照里的一侧（一个格子）。
         * 参数：
         *   line —— 该侧对应的显示行；null 表示这一侧没有对应内容，补一块空白。
         *   side —— 'left'（取旧行号）或 'right'（取新行号）。
         */
        function renderSide(line, side) {
          if (line === null) {
            return React.createElement('span', { className: 'ddr-side', 'data-empty': 'true' }, [
              React.createElement('span', { key: 'g', className: 'ddr-gutter' }, ''),
              React.createElement('span', { key: 's', className: 'ddr-sign' }, ''),
              React.createElement('span', { key: 't', className: 'ddr-text' }, ''),
            ]);
          }
          var number = side === 'left' ? line.a : line.b;
          var sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
          return React.createElement('span', {
            className: 'ddr-side',
            'data-kind': line.kind,
          }, [
            React.createElement('span', { key: 'g', className: 'ddr-gutter' },
              number === null ? '' : String(number)),
            React.createElement('span', { key: 's', className: 'ddr-sign' }, sign),
            React.createElement('span', { key: 't', className: 'ddr-text' }, line.text),
          ]);
        }

        // 定位：差异块序号变化（含切文件、切视图、切全屏引起的重排）后，
        // 把那一块的第一行改动滚到视口上方约 1/3 处，留出上下文可读。
        React.useLayoutEffect(function () {
          if (!state.open || hunkCount === 0) return undefined;
          // 只保留当前文件、当前视图的 DOM 节点引用，翻很多文件后不会一直挂着旧节点
          for (var key in lineRefs.current) {
            if (key.indexOf(refPrefix) !== 0) delete lineRefs.current[key];
          }
          var startLine = hunks[activeHunk].start;
          // 对照模式下「第几个显示行」要换算成「第几个对照行」
          var targetIndex = split && aligned && typeof aligned.rowOfLine[startLine] === 'number'
            ? aligned.rowOfLine[startLine]
            : startLine;
          var container = scrollerRef.current;
          var node = lineRefs.current[refPrefix + targetIndex];
          if (!container || !node) return undefined;
          container.scrollTop = Math.max(0, node.offsetTop - Math.round((container.clientHeight || 0) / 3));
          return undefined;
        }, [state.open, state.fullscreen, selected && selected.id, hunkCount, activeHunk]);

        // 键盘快捷键：与 Trae 的手感对齐
        React.useEffect(function () {
          if (!state.open) return undefined;
          function onKey(event) {
            if (event.key === 'Escape') {
              // 全屏时第一次 Esc 只退出全屏，面板留着；再按一次才关闭
              if (store.get().fullscreen) {
                store.set({ fullscreen: false });
                return;
              }
              store.set({ open: false });
              return;
            }
            if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              if (hunkCount === 0) return;
              event.preventDefault();
              stepHunk(event.key === 'ArrowDown' ? 1 : -1);
              return;
            }
            // 字号：Alt+- / Alt+=（不同键盘布局下 '+' 可能带 shift，所以两种都收）
            if (event.altKey && (event.key === '-' || event.key === '_')) {
              event.preventDefault();
              stepFontSize(-1);
              return;
            }
            if (event.altKey && (event.key === '=' || event.key === '+')) {
              event.preventDefault();
              stepFontSize(1);
              return;
            }
            if (event.ctrlKey && event.key === 'Enter' && selected && selected.status === 'pending') {
              event.preventDefault();
              act('keep', [selected.id]);
              return;
            }
            if (event.ctrlKey && event.key === 'Backspace' && selected && selected.status === 'pending') {
              event.preventDefault();
              act('undo', [selected.id]);
            }
          }
          window.addEventListener('keydown', onKey);
          return function () {
            window.removeEventListener('keydown', onKey);
          };
        }, [state.open, selected && selected.id, selected && selected.status, hunkCount]);

        if (!state.open) return null;

        var header = React.createElement('div', { className: 'ddr-head' }, [
          React.createElement('span', { key: 't', className: 'ddr-title' }, labels.title),
          React.createElement('span', { key: 's', className: 'ddr-sub' },
            labels.pending(pendingEntries.length)),
          React.createElement('span', { key: 'sp', className: 'ddr-spacer' }),
          // 视图切换：按钮文案是「点了会切到哪个」（与「全屏 / 退出全屏」同一套约定）
          React.createElement('button', {
            key: 'split',
            type: 'button',
            className: 'ddr-btn',
            'data-kind': split ? 'primary' : undefined,
            title: labels.viewHint,
            onClick: function () {
              var next = !store.get().split;
              saveSplitView(next);
              store.set({ split: next });
            },
          }, split ? labels.unifiedView : labels.splitView),
          // 字号调整：改的是面板基准字号；面板内部全用 em，所以代码与界面文字一起缩放
          React.createElement('span', { key: 'zoom', className: 'ddr-zoom' }, [
            React.createElement('button', {
              key: 'minus',
              type: 'button',
              className: 'ddr-btn',
              disabled: state.fontSize <= FONT_SIZE_MIN,
              title: labels.fontSmallerHint,
              onClick: function () {
                stepFontSize(-1);
              },
            }, labels.fontSmaller),
            React.createElement('span', {
              key: 'value',
              className: 'ddr-sub',
              title: labels.fontSizeTitle(state.fontSize),
            }, state.fontSize + 'px'),
            React.createElement('button', {
              key: 'plus',
              type: 'button',
              className: 'ddr-btn',
              disabled: state.fontSize >= FONT_SIZE_MAX,
              title: labels.fontLargerHint,
              onClick: function () {
                stepFontSize(1);
              },
            }, labels.fontLarger),
          ]),
          React.createElement('button', {
            key: 'ka',
            type: 'button',
            className: 'ddr-btn',
            disabled: pendingEntries.length === 0,
            onClick: function () {
              act('keep-all');
            },
          }, labels.keepAll),
          React.createElement('button', {
            key: 'ua',
            type: 'button',
            className: 'ddr-btn',
            'data-kind': 'danger',
            disabled: pendingEntries.length === 0,
            onClick: function () {
              act('undo-all');
            },
          }, labels.undoAll),
          React.createElement('button', {
            key: 'fs',
            type: 'button',
            className: 'ddr-btn',
            'data-kind': state.fullscreen ? 'primary' : undefined,
            title: labels.navHint,
            onClick: function () {
              store.set({ fullscreen: !store.get().fullscreen });
            },
          }, state.fullscreen ? labels.exitFullscreen : labels.fullscreen),
          React.createElement('button', {
            key: 'close',
            type: 'button',
            className: 'ddr-btn',
            onClick: function () {
              store.set({ open: false, fullscreen: false });
            },
          }, labels.close),
        ]);

        var list = React.createElement('div', { className: 'ddr-list' },
          pendingEntries.length === 0
            ? React.createElement('div', { className: 'ddr-empty' }, labels.empty)
            : pendingEntries.map(function (entry) {
              var name = entry.display.split('/').pop();
              var dir = entry.display.slice(0, entry.display.length - name.length);
              // 列表里的 +N/-M 优先用宿主随清单下发的权威计数；
              // 宿主半还是旧版时（没有这两个字段）退回用已拉到的差异兜底，
              // 这样只刷新页面、不重启 DSH 也不会让列表数字消失。
              var cached = state.files[entry.id] && state.files[entry.id].diff;
              var added = typeof entry.added === 'number' ? entry.added : (cached ? cached.added : null);
              var removed = typeof entry.removed === 'number' ? entry.removed : (cached ? cached.removed : null);
              var showCounts = !entry.oversized && added !== null && removed !== null;
              return React.createElement('button', {
                key: entry.id,
                type: 'button',
                className: 'ddr-row',
                'data-active': String(entry.id === state.selectedId),
                onClick: function () {
                  select(entry.id);
                },
              }, [
                React.createElement('span', { key: 'p', className: 'ddr-row-path' }, [
                  React.createElement('span', { key: 'n', className: 'ddr-row-name' }, name),
                ]),
                React.createElement('span', { key: 'm', className: 'ddr-row-meta' }, [
                  React.createElement('span', { key: 'd' }, dir || '.'),
                  showCounts
                    ? React.createElement('span', { key: 'add', className: 'ddr-add' }, '+' + added)
                    : null,
                  showCounts
                    ? React.createElement('span', { key: 'del', className: 'ddr-del' }, '-' + removed)
                    : null,
                  entry.status !== 'pending'
                    ? React.createElement('span', { key: 'tag', className: 'ddr-tag' },
                      entry.status === 'kept' ? labels.kept : labels.reverted)
                    : null,
                  entry.oversized
                    ? React.createElement('span', { key: 'big', className: 'ddr-tag' }, labels.oversized)
                    : null,
                ]),
              ]);
            }));

        var bar = React.createElement('div', { className: 'ddr-bar' }, [
          React.createElement('span', { key: 'p', className: 'ddr-bar-path' },
            selected ? selected.display : ''),
          selected && pendingEntries.length > 0
            ? React.createElement('span', { key: 'i', className: 'ddr-sub' },
              (position >= 0 ? position + 1 : 0) + '/' + pendingEntries.length)
            : null,
          React.createElement('span', { key: 'sp', className: 'ddr-spacer' }),
          // 差异块导航：只在真的有改动块时出现，没改动时完全不占位
          hunkCount > 0
            ? React.createElement('span', { key: 'hc', className: 'ddr-bar-count' },
              labels.diffCount(activeHunk + 1, hunkCount))
            : null,
          hunkCount > 0
            ? React.createElement('span', { key: 'nav', className: 'ddr-nav' }, [
              React.createElement('button', {
                key: 'prev',
                type: 'button',
                className: 'ddr-btn',
                title: labels.prevDiff + '（Alt+↑）',
                onClick: function () {
                  stepHunk(-1);
                },
              }, labels.prevDiff),
              React.createElement('button', {
                key: 'next',
                type: 'button',
                className: 'ddr-btn',
                title: labels.nextDiff + '（Alt+↓）',
                onClick: function () {
                  stepHunk(1);
                },
              }, labels.nextDiff),
            ])
            : null,
          React.createElement('button', {
            key: 'undo',
            type: 'button',
            className: 'ddr-btn',
            disabled: !selected || selected.status !== 'pending' || !selected.undoable,
            title: selected && !selected.undoable ? labels.undoDisabled : labels.navHint,
            onClick: function () {
              if (selected) act('undo', [selected.id]);
            },
          }, labels.undo),
          React.createElement('button', {
            key: 'keep',
            type: 'button',
            className: 'ddr-btn',
            'data-kind': 'primary',
            disabled: !selected || selected.status !== 'pending',
            onClick: function () {
              if (selected) act('keep', [selected.id]);
            },
          }, labels.keep),
        ]);

        var diffBody;
        if (!selected) {
          diffBody = React.createElement('div', { className: 'ddr-empty' }, labels.pick);
        } else if (selected.oversized) {
          diffBody = React.createElement('div', { className: 'ddr-empty' }, labels.oversized);
        } else if (!file) {
          diffBody = React.createElement('div', { className: 'ddr-empty' }, '…');
        } else if (!file.diff || file.diff.lines.length === 0) {
          diffBody = React.createElement('div', { className: 'ddr-empty' }, labels.pick);
        } else if (split && aligned) {
          // 左右对照：一行两格，左=原文、右=现文；改动的那一侧着色，缺的一侧补灰
          diffBody = React.createElement('div', {
            className: 'ddr-diff',
            'data-split': 'true',
            ref: scrollerRef,
          }, aligned.rows.map(function (row, rowIndex) {
            if (row.kind === 'gap') {
              return React.createElement('div', {
                key: rowIndex,
                className: 'ddr-sgap',
                ref: nodeRef(refPrefix + rowIndex),
              }, row.text);
            }
            // 这一行是否属于当前定位的差异块：两侧任一行号落在块内就算
            var inActiveHunk = activeHunk >= 0 && (
              (row.li !== null && row.li >= hunks[activeHunk].start && row.li <= hunks[activeHunk].end)
              || (row.ri !== null && row.ri >= hunks[activeHunk].start && row.ri <= hunks[activeHunk].end)
            );
            return React.createElement('div', {
              key: rowIndex,
              className: 'ddr-srow',
              'data-kind': row.kind,
              'data-hunk': inActiveHunk ? 'active' : undefined,
              ref: nodeRef(refPrefix + rowIndex),
            }, [renderSide(row.left, 'left'), renderSide(row.right, 'right')]);
          }));
        } else {
          diffBody = React.createElement('div', { className: 'ddr-diff', ref: scrollerRef },
            file.diff.lines.map(function (line, index) {
              var sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'gap' ? '' : ' ';
              var inActiveHunk = activeHunk >= 0
                && index >= hunks[activeHunk].start
                && index <= hunks[activeHunk].end;
              return React.createElement('div', {
                key: index,
                className: 'ddr-line',
                'data-kind': line.kind,
                // 当前定位到的那一块：行号染色，方便一眼看出「下一处」跳到哪了
                'data-hunk': inActiveHunk ? 'active' : undefined,
                ref: nodeRef(refPrefix + index),
              }, [
                React.createElement('span', { key: 'a', className: 'ddr-gutter' }, line.a === null ? '' : String(line.a)),
                React.createElement('span', { key: 'b', className: 'ddr-gutter' }, line.b === null ? '' : String(line.b)),
                React.createElement('span', { key: 's', className: 'ddr-sign' }, sign),
                React.createElement('span', { key: 't', className: 'ddr-text' }, line.text),
              ]);
            }));
        }

        return React.createElement('div', {
          className: 'ddr-panel',
          'data-fullscreen': String(state.fullscreen),
          // 面板基准字号：CSS 里所有文字都写成 em，所以这一处就能缩放整个面板
          style: { fontSize: state.fontSize + 'px' },
        }, [
          header,
          React.createElement('div', { key: 'body', className: 'ddr-body' }, [
            list,
            React.createElement('div', { key: 'view', className: 'ddr-view' }, [
              bar,
              // 文件太大退回折叠时明确写出来，不能让用户以为改动就这么点
              file && file.diff && file.diff.elided
                ? React.createElement('div', { key: 'elided', className: 'ddr-hint' },
                  labels.elided(file.diff.totalLines || 0))
                : null,
              diffBody,
            ]),
          ]),
          state.error
            ? React.createElement('div', { key: 'err', className: 'ddr-note' }, state.error)
            : null,
        ]);
      }

      // —— 注册两个插槽：入口按钮（左侧栏底部）与浮层面板（全帧浮层） ——
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-diff-review-trigger',
            order: 60,
            label: function () {
              return strings().trigger;
            },
          }, Trigger);
        });
      }, 'dsh-diff-review: trigger');

      ctx.effect(function () {
        return ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-diff-review-panel',
            order: 60,
          }, Panel);
        });
      }, 'dsh-diff-review: panel');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
