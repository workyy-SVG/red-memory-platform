/* ==========================================================================
 * 红色记忆 · 主题展览层（首页 / 五章参观 / 证据卡 / 观展摘要）
 *
 * 设计约束：
 *   1. 不复制史实正文：叙事与关键事实来自 data/exhibition.json，
 *      证据卡通过 snippet_id 指回 nodes.json 的审定片段。
 *   2. 只登记来源：按书名／篇名、作者／出版者、年份与链接引用，不生成假页码/假定位。
 *   3. AI 携带当前章节与最近对话；离线时明确提示，不伪装回答。
 *   4. 进度只存本机 localStorage，可一键清除。
 *
 * 与主页面通过 window.RgExhibitBridge 通信（见 红色记忆平台.html 主脚本末尾）。
 * ========================================================================== */
(function () {
  'use strict';

  var PROGRESS_KEY = 'rg.exhibition.progress.v1';
  var EXD = null, EX = null, CH = [], CHBY = {}, EVBY = {}, MEBY = {}, ATLAS_BY = {};
  var state = { chapter: '', mode: 'home', aiHistory: [], routing: false, homeTab: 'cover' };
  var TTS = { synth: null, utt: null, text: '', sentences: [], active: false, paused: false, rate: 1 };
  var toastTimer = null;

  function b() { return window.RgExhibitBridge || {}; }
  function byId(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function trim(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function srcTag(id) {
    var fn = b().srcTag;
    if (typeof fn === 'function') { try { return fn(id); } catch (e) {} }
    return '<span class="src-tag" data-sid="' + esc(id) + '">' + esc(id) + '</span>';
  }
  function nodeOf(id) {
    var map = b().nodeById || {};
    return map[id] || null;
  }
  function allNodes() {
    var fn = b().nodes;
    if (typeof fn === 'function') { try { return fn() || []; } catch (e) {} }
    return [];
  }
  function chOf(id) { return CHBY[id] || null; }
  function exId() { return EX ? EX.id : ''; }

  // 本章人物线索：只取知识图谱中已存在的「参与 / 指挥」关系，不补充图谱外的信息。
  function chapterPeople(c) {
    var kg = (b().data || {}).kg;
    if (!kg || !kg.entities || !kg.relations) return [];
    var evIds = c.event_ids || [];
    if (!evIds.length) return [];
    var ent = {};
    kg.entities.forEach(function (e) { if (e && e.id) ent[e.id] = e; });
    // 章节引用的是专题节点 id（如 chishui），图谱关系挂在事件实体（如 e_du1）上；
    // 只沿「包含事件」关系展开，不跨节点推断。
    var evSet = {};
    evIds.forEach(function (nid) { evSet[nid] = true; });
    kg.relations.forEach(function (r) {
      if (r && r.relation === '包含事件' && evIds.indexOf(r.head) >= 0) evSet[r.tail] = true;
    });
    var evList = Object.keys(evSet);
    var by = {};
    kg.relations.forEach(function (r) {
      if (!r) return;
      var rel = r.relation || '';
      if (rel !== '参与' && rel !== '指挥') return;
      var ev = null, pid = null;
      if (evList.indexOf(r.head) >= 0 && ent[r.tail] && ent[r.tail].type === 'person') {
        ev = r.head; pid = r.tail;
      } else if (evList.indexOf(r.tail) >= 0 && ent[r.head] && ent[r.head].type === 'person') {
        ev = r.tail; pid = r.head;
      }
      if (!ev || !pid) return;
      var it = by[pid];
      if (!it) {
        it = by[pid] = {
          id: pid, name: ent[pid].name || pid, role: ent[pid].role || '',
          rels: {}, labels: [], evs: [], srcs: []
        };
      }
      it.rels[rel] = true;
      var lb = r.label || rel;
      if (it.labels.indexOf(lb) < 0) it.labels.push(lb);
      if (it.evs.indexOf(ev) < 0) it.evs.push(ev);
      (r.source_ids || []).forEach(function (s) {
        if (it.srcs.indexOf(s) < 0) it.srcs.push(s);
      });
    });
    var out = Object.keys(by).map(function (k) { return by[k]; });
    out.sort(function (a, b2) {
      var ca = a.rels['指挥'] ? 0 : 1, cb = b2.rels['指挥'] ? 0 : 1;
      if (ca !== cb) return ca - cb;
      if (b2.evs.length !== a.evs.length) return b2.evs.length - a.evs.length;
      return String(a.name).localeCompare(String(b2.name), 'zh');
    });
    return out;
  }

  /* ------------------------------------------------------------------------
   * 进度（仅本机）
   * ---------------------------------------------------------------------- */
  function loadProgress() {
    try {
      var raw = localStorage.getItem(PROGRESS_KEY);
      var d = raw ? JSON.parse(raw) : {};
      return (d && typeof d === 'object') ? d : {};
    } catch (e) { return {}; }
  }
  function saveProgress(d) {
    try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(d)); } catch (e) {}
  }
  function myProgress() {
    var all = loadProgress();
    var p = all[exId()];
    if (!p || typeof p !== 'object') p = { visited: [], last: '', updatedAt: 0 };
    if (!Array.isArray(p.visited)) p.visited = [];
    return p;
  }
  function markVisited(cid) {
    var all = loadProgress();
    var p = all[exId()];
    if (!p || typeof p !== 'object') p = { visited: [], last: '', updatedAt: 0 };
    if (!Array.isArray(p.visited)) p.visited = [];
    if (p.visited.indexOf(cid) < 0) p.visited.push(cid);
    p.last = cid;
    p.updatedAt = Date.now();
    all[exId()] = p;
    saveProgress(all);
  }
  function visitedSet() {
    var p = myProgress(), out = {};
    p.visited.forEach(function (id) { out[id] = true; });
    return out;
  }

  /* ------------------------------------------------------------------------
   * 初始化
   * ---------------------------------------------------------------------- */
  function init() {
    var data = b().data;
    if (!data || !data.exhibition || !data.exhibition.exhibitions
      || !data.exhibition.exhibitions.length) return false;

    EXD = data.exhibition;
    EX = EXD.exhibitions[0];
    CH = (EXD.chapters || []).filter(function (c) {
      return c && c.exhibition_id === EX.id;
    }).sort(function (a, b2) { return (a.order || 0) - (b2.order || 0); });
    if (!CH.length) return false;

    CH.forEach(function (c) { CHBY[c.id] = c; });
    (EXD.evidence || []).forEach(function (e) { EVBY[e.id] = e; });
    (EXD.media || []).forEach(function (m) { MEBY[m.id] = m; });
    ((data.atlas && data.atlas.items) || []).forEach(function (a) { ATLAS_BY[a.id] = a; });

    state.chapter = '';
    state.mode = 'home';
    renderHome();
    bindGlobal();
    return true;
  }

  /* ------------------------------------------------------------------------
   * 路由
   * ---------------------------------------------------------------------- */
  function parseHash() {
    var h = location.hash || '';
    var m = /^#\/ex\/([^\/]+)(?:\/([^\/]+))?/.exec(h);
    if (!m) return null;
    var ex = '';
    var cid = '';
    try { ex = decodeURIComponent(m[1] || ''); } catch (e) { ex = m[1] || ''; }
    try { cid = decodeURIComponent(m[2] || ''); } catch (e) { cid = m[2] || ''; }
    return { exId: ex, chapter: cid };
  }
  function hashFor(cid) {
    return '#/ex/' + encodeURIComponent(exId()) + '/' + encodeURIComponent(cid);
  }
  function setHash(cid) {
    var h = hashFor(cid);
    if (location.hash !== h) {
      state.routing = true;
      location.hash = h;
      setTimeout(function () { state.routing = false; }, 0);
    }
  }
  function clearHash() {
    if (/^#\/ex\//.test(location.hash || '')) {
      try { history.replaceState(null, '', location.pathname + location.search); }
      catch (e) { location.hash = ''; }
    }
  }
  function onHashChange() {
    if (state.routing) return;
    routeFromHash();
  }
  function routeFromHash() {
    var p = parseHash();
    if (!p || p.exId !== exId()) {
      if (state.mode !== 'home') goHome();
      return;
    }
    if (p.chapter === 'summary') {
      if (state.mode !== 'summary') openSummary({ fromHash: true });
      return;
    }
    if (CHBY[p.chapter]) {
      if (state.mode !== 'chapter' || state.chapter !== p.chapter) {
        openChapter(p.chapter, { fromHash: true });
      }
      return;
    }
    goHome();
  }
  function bootRoute() {
    var p = parseHash();
    if (p && p.exId === exId()) {
      if (p.chapter === 'summary') { openSummary({ fromHash: true }); return; }
      if (CHBY[p.chapter]) { openChapter(p.chapter, { fromHash: true }); return; }
    }
    goHome();
  }

  /* ------------------------------------------------------------------------
   * 首页
   * ---------------------------------------------------------------------- */
  function heroRouteSvg() {
    var names = CH.map(function (c) {
      var n = nodeOf(c.primary_event_id);
      return n ? n.name : c.title;
    });
    // 纯示意：按章节顺序均匀布点，不冒充真实行军路线。
    var pts = [[46, 136], [120, 90], [190, 116], [262, 66], [318, 92]];
    var d = 'M46,136 C78,120 96,86 120,90 S158,118 190,116 S230,78 262,66 S298,84 318,92';
    var h = '<svg viewBox="0 0 360 190" role="img" aria-label="五章路线示意">';
    h += '<defs><linearGradient id="exRouteGrad" x1="0" y1="0" x2="1" y2="0">'
      + '<stop offset="0" stop-color="#E8C988" stop-opacity=".24"/>'
      + '<stop offset=".55" stop-color="#F0D9A8" stop-opacity=".7"/>'
      + '<stop offset="1" stop-color="#E8C988" stop-opacity=".28"/>'
      + '</linearGradient></defs>';
    // 淡等高线，只作档案图底纹，不承载任何地理信息
    h += '<g class="rt-grid" aria-hidden="true">'
      + '<path d="M-8,52 C58,22 118,68 188,40 S308,20 372,52"></path>'
      + '<path d="M-8,78 C62,50 128,92 196,66 S312,44 372,76"></path>'
      + '<path d="M-8,160 C66,134 140,176 214,150 S330,132 372,158"></path>'
      + '<path d="M28,-8 C66,40 34,96 86,142 S152,180 190,198"></path>'
      + '</g>';
    h += '<path class="rt-line" d="' + d + '"></path>';
    pts.forEach(function (p, i) {
      var nx = Math.max(18, Math.min(322, p[0]));
      var ny = p[1] < 100 ? p[1] - 16 : p[1] + 24;
      var delay = (i * 0.55).toFixed(2);
      h += '<circle class="rt-halo" cx="' + p[0] + '" cy="' + p[1] + '" r="14"'
        + ' style="animation-delay:' + delay + 's"></circle>';
      h += '<circle class="rt-dot" cx="' + p[0] + '" cy="' + p[1] + '" r="4.2"'
        + ' style="animation-delay:' + delay + 's"></circle>';
      h += '<text class="rt-no" x="' + (p[0] + 10) + '" y="' + (p[1] - 9) + '">'
        + '0' + (i + 1) + '</text>';
      var lx = Math.max(10, Math.min(312, nx - 22));
      h += '<text class="rt-name" x="' + lx + '" y="' + ny + '">'
        + esc(trim(names[i] || '', 8)) + '</text>';
    });
    h += '<text class="rt-cap" x="46" y="178">路线示意 · 非精确行军路线</text>';
    h += '</svg>';
    return h;
  }

  function renderCoverHtml(last) {
    var h = '';
    h += '<section class="ex-cover' + (state.homeTab !== 'intro' ? ' on' : '') + '" id="exCover">';
    h += '<div class="ex-cover-aura" aria-hidden="true"></div>';
    h += '<div class="ex-cover-main">';
    h += '<h1 class="ex-cover-title">' + esc(EX.title) + '</h1>';
    h += '<p class="ex-cover-sub">' + esc(EX.cover_line || EX.subtitle
      || '1934—1935，红军转战黔地，在绝境中迎来伟大历史转折') + '</p>';
    h += '<div class="ex-cover-actions">';
    h += '<button type="button" class="ex-btn cover-primary" data-ex-intro="1">开启参观 <span class="ar">→</span></button>';
    h += '<button type="button" class="ex-btn cover-ghost" data-ex-goto="topic">查看路线</button>';
    if (last) {
      h += '<button type="button" class="ex-btn cover-ghost" data-ex-ch="' + esc(last.id) + '">'
        + '继续参观 · 第' + esc(cnNum(last.order)) + '章</button>';
    }
    h += '</div>';
    h += '<div class="ex-cover-meta">';
    h += '<span><i></i>' + CH.length + ' 章</span>';
    h += '<span><i></i>约 ' + esc(EX.estimated_minutes || 5) + ' 分钟</span>';
    h += '<span><i></i>' + (EXD.evidence || []).length + ' 条可核对证据</span>';
    h += '<span><i></i>观展记录自动保存</span>';
    h += '</div></div>';
    h += '<div class="ex-hero-route ex-cover-route" aria-hidden="true">' + heroRouteSvg() + '</div>';
    h += '<nav class="ex-cover-stages" aria-label="五章快速入口">';
    CH.forEach(function (c) {
      h += '<button type="button" data-ex-ch="' + esc(c.id) + '"'
        + ' title="' + esc(c.subtitle || c.title) + '">'
        + '<i></i><span>' + esc(c.title) + '</span></button>';
    });
    h += '</nav>';
    h += '</section>';
    return h;
  }

  function renderIntroHtml(pct, visitedCount, last) {
    var h = '';
    h += '<section class="ex-intro' + (state.homeTab === 'intro' ? ' on' : '') + '" id="exIntro">';
    h += '<div class="ex-intro-grid">';

    // 左栏：展览导言
    h += '<div class="ex-intro-left">';
    h += '<button type="button" class="ex-intro-back" data-ex-cover="1">← 返回封面</button>';
    h += '<h2>展览导言</h2>';
    String(EX.intro || '').split(/\n+/).filter(Boolean).forEach(function (t) {
      h += '<p>' + esc(t) + '</p>';
    });
    h += '<div class="ex-intro-meta">'
      + '<span class="ex-tag gold">' + esc(EX.version || '') + '</span>'
      + '<span class="ex-tag line">' + esc(EX.review_status || '待复核') + '</span>'
      + '</div>';
    h += '<div class="ex-intro-actions">';
    if (last) {
      h += '<button type="button" class="ex-btn primary" data-ex-ch="' + esc(last.id) + '">'
        + '继续参观 · 第' + esc(cnNum(last.order)) + '章 <span class="ar">→</span></button>';
    } else if (CH[0]) {
      h += '<button type="button" class="ex-btn primary" data-ex-ch="' + esc(CH[0].id) + '">'
        + '开始参观 <span class="ar">→</span></button>';
    }
    h += '<button type="button" class="ex-btn" data-ex-story>五十秒纵览</button>';
    h += '<button type="button" class="ex-btn" data-ex-summary="1">观展摘要</button>';
    h += '<button type="button" class="ex-btn" data-ex-goto="sources">史料来源清单</button>';
    h += '</div>';
    h += '<div class="ex-progress-line"><i style="width:' + pct + '%"></i></div>';
    h += '<div class="ex-progress-text"><span>已浏览 <b>' + visitedCount + '</b> / ' + CH.length
      + ' 章</span><span>' + pct + '%</span></div>';
    h += '</div>';

    // 右栏：五章卡片
    h += '<div class="ex-intro-cards">';
    h += '<div class="ex-ch-grid">';
    CH.forEach(function (c) {
      var evs = c.event_ids || [];
      var evCount = (c.evidence_ids || []).length;
      h += '<button type="button" class="ex-ch-card" data-ex-ch="' + esc(c.id) + '">';
      h += '<div class="ex-ch-top"><span class="ex-ch-no"><b>' + esc(pad2(c.order)) + '</b>章</span></div>';
      h += '<h3>' + esc(c.title) + '</h3>';
      h += '<div class="ex-ch-sub">' + esc(c.subtitle || '') + '</div>';
      h += '<div class="ex-ch-foot"><span>' + evs.length + ' 个事件</span><span>·</span>'
        + '<span>' + evCount + ' 条证据</span><span class="go">进入 →</span></div>';
      h += '</button>';
    });
    h += '</div></div>';

    h += '</div>';

    // 底部：观展说明 / 进度 / 继续探索
    h += '<div class="ex-intro-side">';
    h += '<div class="ex-side-card"><h3>观展说明</h3>'
      + '<ul><li>每章 80—150 字叙事，配 2—3 条关键事实。</li>'
      + '<li>证据卡优先引用审定叙述；原文与文献题名单独标注。</li>'
      + '<li>证据卡只写明来源，不逐页标注，也不补造页码与定位。</li>'
      + '<li>当前为预展版，内容尚待第二人复核。</li></ul>'
      + '<div class="ex-side-note">本展不展示未经授权的高清历史照片；'
      + '所配图片均为可署名/公有领域素材，并在图下标注作者与许可。</div></div>';

    h += '<div class="ex-side-card"><h3>继续探索</h3><div class="ex-side-links">'
      + '<button type="button" data-ex-goto="topic">时空地图与时间轴<span>→</span></button>'
      + '<button type="button" data-ex-goto="atlas">红色记忆总库<span>→</span></button>'
      + '<button type="button" data-ex-goto="sources">史料来源清单<span>→</span></button>'
      + '</div><div class="ex-side-note">展览之外，仍可按地图、图谱与资源库自由检索。</div></div>';

    h += '</div>';
    h += '</section>';
    return h;
  }

  function renderHome() {
    if (!EX) return;
    var wrap = byId('exHomeWrap');
    if (!wrap) return;
    var p = myProgress();
    var vs = visitedSet();
    var visited = CH.filter(function (c) { return vs[c.id]; });
    var last = p.last && CHBY[p.last] ? CHBY[p.last] : null;
    var pct = Math.round(visited.length / CH.length * 100);

    wrap.innerHTML = renderCoverHtml(last) + renderIntroHtml(pct, visited.length, last);
  }

  /* 主题展览双界面切换：封面 ↔ 导言 */
  function applyHomeTab() {
    var cov = byId('exCover');
    var intro = byId('exIntro');
    if (cov) cov.classList.toggle('on', state.homeTab !== 'intro');
    if (intro) intro.classList.toggle('on', state.homeTab === 'intro');
    var v = byId('viewHome');
    if (v) v.scrollTop = 0;
  }
  function showCover() {
    state.homeTab = 'cover';
    applyHomeTab();
  }
  function showIntro() {
    state.homeTab = 'intro';
    applyHomeTab();
  }

  function pad2(n) { n = Number(n) || 0; return n < 10 ? '0' + n : String(n); }
  function cnNum(n) {
    var map = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十' };
    return map[Number(n)] || String(n);
  }

  /* ------------------------------------------------------------------------
   * 进入 / 离开
   * ---------------------------------------------------------------------- */
  function goHome() {
    stopTts();
    state.mode = 'home';
    state.chapter = '';
    state.homeTab = 'cover';
    clearHash();
    var sv = b().setView;
    if (typeof sv === 'function') sv('home');
    else renderHome();
  }

  function openChapter(cid, opts) {
    var c = chOf(cid);
    if (!c) return;
    opts = opts || {};
    stopTts();
    state.mode = 'chapter';
    state.chapter = cid;
    state.aiHistory = [];
    markVisited(cid);

    renderToc();
    renderArticle();
    renderRail();

    var sv = b().setView;
    if (typeof sv === 'function') sv('tour');

    if (!opts.fromHash) setHash(cid);
    document.dispatchEvent(new CustomEvent('rg:exhibit', { detail: { view: 'tour', chapter: cid } }));

    var v = byId('viewTour');
    if (v) v.scrollTop = 0;
    var art = byId('exArticle');
    if (art) art.scrollTop = 0;

    // 同步专题时间轴/详情，不改当前视图
    var sel = b().selectNode;
    if (typeof sel === 'function' && c.primary_event_id) {
      try { sel(c.primary_event_id, false); } catch (e) {}
    }
  }

  function openSummary(opts) {
    opts = opts || {};
    stopTts();
    state.mode = 'summary';
    state.chapter = '';
    renderToc();
    renderSummary();
    renderSummaryRail();
    var sv = b().setView;
    if (typeof sv === 'function') sv('tour');
    if (!opts.fromHash) setHash('summary');
    document.dispatchEvent(new CustomEvent('rg:exhibit', { detail: { view: 'tour', chapter: 'summary' } }));
    var v = byId('viewTour');
    if (v) v.scrollTop = 0;
  }

  // 主页面 setView 调用：离开参观页时停止朗读，回到首页时刷新进度
  function onView(v) {
    if (v !== 'tour') stopTts();
    if (v === 'home') renderHome();
  }

  /* ------------------------------------------------------------------------
   * 章节目录
   * ---------------------------------------------------------------------- */
  function renderToc() {
    var box = byId('exToc');
    if (!box) return;
    var vs = visitedSet();
    var p = myProgress();
    var h = '';
    h += '<button type="button" class="ex-toc-back" data-ex-home="1">← 返回展览首页</button>';
    h += '<div class="ex-toc-title">参观目录</div><ol>';
    CH.forEach(function (c) {
      var cls = '';
      if (state.mode === 'chapter' && state.chapter === c.id) cls += ' active';
      if (vs[c.id]) cls += ' visited';
      h += '<li><button type="button" class="' + cls.trim() + '" data-ex-ch="' + esc(c.id) + '">'
        + '<span class="no">' + esc(c.order) + '</span>'
        + '<span class="tx"><b>' + esc(c.title) + '</b><i>' + esc(c.date_label || '') + '</i></span>'
        + '</button></li>';
    });
    h += '</ol>';
    h += '<div class="ex-toc-stat">已浏览 ' + CH.filter(function (c) { return vs[c.id]; }).length
      + ' / ' + CH.length + ' 章 · 记录随当前访客保存</div>';
    h += '<div class="ex-toc-sum">';
    h += '<button type="button" class="ex-btn sm' + (state.mode === 'summary' ? ' on' : '')
      + '" data-ex-summary="1">观展摘要与引用</button>';
    h += '<button type="button" class="ex-btn sm" data-ex-home="1">展览首页</button>';
    h += '</div>';
    box.innerHTML = h;
  }

  /* ------------------------------------------------------------------------
   * 章节正文
   * ---------------------------------------------------------------------- */
  function renderArticle() {
    var box = byId('exArticle');
    if (!box) return;
    var c = chOf(state.chapter);
    if (!c) { box.innerHTML = ''; return; }

    var idx = CH.map(function (x) { return x.id; }).indexOf(c.id);
    var prev = idx > 0 ? CH[idx - 1] : null;
    var next = idx >= 0 && idx < CH.length - 1 ? CH[idx + 1] : null;
    var events = (c.event_ids || []).map(nodeOf).filter(Boolean);
    var media = (c.media_ids || []).map(function (id) { return MEBY[id]; }).filter(Boolean);
    var evs = (c.evidence_ids || []).map(function (id) { return EVBY[id]; }).filter(Boolean);

    var h = '<div class="ex-art-top"><div>';
    h += '<div class="ex-art-kicker">第' + esc(cnNum(c.order)) + '章 · 长征贵州段的关键转折</div>';
    h += '<h1 class="ex-art-title">' + esc(c.title) + '</h1>';
    h += '<div class="ex-art-sub">' + esc(c.subtitle || '') + '</div>';
    h += '<div class="ex-art-meta">'
      + '<span class="ex-tag red">' + esc(c.date_label || '') + '</span>'
      + '<span class="ex-tag line">' + esc(c.place_label || '') + '</span>'
      + '<span class="ex-tag gold">' + events.length + ' 个事件 · ' + evs.length + ' 条证据</span>'
      + '</div>';
    h += '</div><span class="ex-verify">' + esc(c.review_status || '待第二人复核') + '</span></div>';

    if (media.length) {
      media.forEach(function (m) {
        h += '<figure class="ex-figure' + (m.portrait ? ' portrait' : '') + '">';
        h += '<img src="' + esc(m.path) + '" alt="' + esc(m.caption) + '" loading="lazy" decoding="async">';
        h += '<figcaption>' + esc(m.caption || '')
          + ' · 作者：' + esc(m.author || '—')
          + ' · ' + esc(m.license_zh || m.license || '许可见原文件');
        if (m.license_url) {
          h += ' · <a href="' + esc(m.license_url) + '" target="_blank" rel="noopener noreferrer">许可</a>';
        }
        if (m.source_url) {
          h += ' · <a href="' + esc(m.source_url) + '" target="_blank" rel="noopener noreferrer">原始文件</a>';
        }
        h += '</figcaption>';
        if (m.item_id && ATLAS_BY[m.item_id]) {
          h += '<div class="ex-media-alt"><span>关联总库：</span>'
            + '<button type="button" data-ex-atlas="' + esc(m.item_id) + '">'
            + esc(ATLAS_BY[m.item_id].name) + ' →</button></div>';
        }
        h += '</figure>';
      });
    } else {
      h += '<div class="ex-schematic">' + schematicSvg(c, 100, 54)
        + '<div class="sc-cap">' + esc((c.visual && c.visual.caption)
          || '本章事件点位示意（按经纬度投影，非真实行军路线）') + '</div></div>';
    }

    h += '<div class="ex-narrative">' + esc(c.narrative) + '</div>';

    // 朗读
    h += '<div class="ex-tts" id="exTtsBar"><span>讲解</span>'
      + '<button type="button" data-tts="play">播放</button>'
      + '<button type="button" data-tts="pause">暂停</button>'
      + '<button type="button" data-tts="stop">停止</button>'
      + '<select id="exTtsRate" aria-label="语速">'
      + '<option value="0.8">0.8×</option><option value="1" selected>1.0×</option>'
      + '<option value="1.2">1.2×</option></select>'
      + '<span class="ex-tts-now" id="exTtsNow">不自动播放；点「播放」朗读本章叙事与关键事实</span>'
      + '<span class="ex-tts-hint">朗读由浏览器语音合成完成；不支持逐句字幕时降级为整段提示。'
      + '内容以页面文字为准。</span></div>';

    // 关键事实
    h += '<div class="ex-sec-title">关键事实<span class="ex-tag">逐条挂接来源</span></div>';
    h += '<div class="ex-facts">';
    (c.key_facts || []).forEach(function (f, i) {
      h += '<div class="ex-fact"><span class="n">' + (i + 1) + '</span><div>'
        + esc(f.text || '')
        + '<div class="src">' + (f.source_ids || []).map(srcTag).join('') + '</div>'
        + '</div></div>';
    });
    h += '</div>';

    // 人物线索（仅图谱已有关系）
    var people = chapterPeople(c);
    if (people.length) {
      h += '<div class="ex-sec-title">人物线索<span class="ex-tag">取自知识图谱 · 不推断</span></div>';
      h += '<div class="ex-people">';
      people.forEach(function (p) {
        // 优先显示图谱自带的短标签（如「主要指挥者」「参与战斗」），过长时退回关系类型。
        var label = '';
        p.labels.forEach(function (lb) {
          if (!label && lb.length <= 8 && (lb.indexOf('指挥') >= 0 || lb.indexOf('主持') >= 0)) label = lb;
        });
        if (!label) {
          p.labels.forEach(function (lb) { if (!label && lb.length <= 8) label = lb; });
        }
        if (!label) label = p.rels['指挥'] ? '指挥' : '参与';
        h += '<button type="button" class="ex-person" data-ex-person="' + esc(p.name)
          + '" title="查看人物简介：' + esc(p.name) + '（' + esc(p.labels.join(' / ')) + '）">';
        h += '<span class="ex-person-top"><b>' + esc(p.name) + '</b><em>'
          + esc(label) + '</em></span>';
        if (p.role) {
          h += '<span class="ex-person-role">' + esc(trim(p.role, 26)) + '</span>';
        }
        h += '<span class="ex-person-foot"><span>图谱关联 ' + p.evs.length + ' 个事件</span>'
          + '<span class="ex-person-src">' + p.srcs.slice(0, 2).map(srcTag).join('') + '</span>'
          + '</span></button>';
      });
      h += '</div>';
      h += '<div class="ex-side-note">人物与事件的关系只取自现有知识图谱的「参与 / 指挥」关系，'
        + '未补充图谱之外的任职或活动；点击人物可查看人物简介，简介内可再跳到图谱定位。</div>';
    }

    // 证据卡
    h += '<div class="ex-sec-title">证据卡<span class="ex-tag">可展开核对</span></div>';
    h += '<div class="ex-ev-list">';
    evs.forEach(function (e, i) { h += evidenceHtml(e, i); });
    h += '</div>';
    if (!evs.length) {
      h += '<div class="ex-side-note">本章证据卡待补。</div>';
    }

    // 本章事件
    if (events.length) {
      h += '<div class="ex-sec-title">本章事件<span class="ex-tag">点击联动专题 · 可播事件动画</span></div>';
      h += '<div class="ex-chips">';
      events.forEach(function (n) {
        h += '<button type="button" class="ex-chip' + (n.level === 'sub' ? ' sub' : '') + '"'
          + ' data-ex-node="' + esc(n.id) + '" title="' + esc(n.date_label || '') + '">'
          + '<span class="d"></span>' + esc(n.name) + '</button>';
      });
      h += '</div>';
      h += '<div class="ex-actions" style="margin-top:8px">';
      events.forEach(function (n) {
        h += '<button type="button" class="ex-btn sm" data-ex-evstory="' + esc(n.id) + '">'
          + '▶ ' + esc(n.name) + ' · 事件动画</button>';
      });
      h += '</div>';
    }

    // 关联资源
    var rel = (c.related_atlas_ids || []).map(function (id) { return ATLAS_BY[id]; }).filter(Boolean);
    if (rel.length) {
      h += '<div class="ex-sec-title">关联资源<span class="ex-tag">红色记忆总库</span></div>';
      h += '<div class="ex-chips">';
      rel.forEach(function (a) {
        h += '<button type="button" class="ex-chip" data-ex-atlas="' + esc(a.id) + '">'
          + esc(a.name) + '</button>';
      });
      h += '</div>';
    } else {
      h += '<div class="ex-sec-title">关联资源</div>'
        + '<div class="ex-side-note">本章关联资源待补；可先在「记忆资源」中检索相关条目，'
        + '馆方复核后再建立固定关联。</div>';
    }

    // 联动动作
    h += '<div class="ex-actions">';
    if (c.primary_event_id) {
      h += '<button type="button" class="ex-btn sm" data-ex-map="' + esc(c.primary_event_id)
        + '">在地图上查看</button>';
      var pn = nodeOf(c.primary_event_id);
      h += '<button type="button" class="ex-btn sm" data-ex-graph="'
        + esc((pn && pn.name) || c.title) + '">在图谱中查看</button>';
    }
    h += '<button type="button" class="ex-btn sm" data-ex-node="' + esc(c.primary_event_id)
      + '">打开事件详情</button>';
    if (c.primary_event_id) {
      h += '<button type="button" class="ex-btn sm" data-ex-evstory="'
        + esc(c.primary_event_id) + '">▶ 事件动画</button>';
    }
    h += '</div>';

    h += '<div class="ex-art-nav">';
    h += prev
      ? '<button type="button" class="ex-btn sm" data-ex-ch="' + esc(prev.id) + '">← 上一章：'
        + esc(prev.title) + '</button>'
      : '<span></span>';
    if (next) {
      h += '<button type="button" class="ex-btn primary sm" data-ex-ch="' + esc(next.id) + '">'
        + '下一章：' + esc(next.title) + ' →</button>';
    } else {
      h += '<button type="button" class="ex-btn primary sm" data-ex-summary="1">'
        + '完成参观 · 查看摘要 →</button>';
    }
    h += '</div>';

    h += '<div class="ex-sum-note">本章为预展文案（' + esc(EX.version || '') + '），'
      + '内容状态：' + esc(c.review_status || '待第二人复核') + '。证据卡按来源级引用，'
      + '平台不以推测值替代。</div>';

    box.innerHTML = h;
    // 恢复语速选择
    var rateSel = byId('exTtsRate');
    if (rateSel) rateSel.value = String(TTS.rate);
  }

  function evidenceHtml(e, i) {
    var qt = e.quote_type || '审定叙述';
    var qtCls = qt === '原文' ? 'red' : (qt === '文献题名' ? 'line' : 'gold');
    var qtLabel = qt === '审定叙述' ? '审定叙述 · 非逐字原文'
      : qt === '原文' ? '原文 · 节选' : qt;
    var loc = e.locator || {};
    var verify = String(e.verify_status || '待复核');
    var verifyOk = verify.indexOf('已核') === 0;

    var h = '<details class="ex-ev"' + (i === 0 ? ' open' : '') + '>';
    h += '<summary><span class="ev-i">证</span><div class="ev-main">'
      + '<div class="ev-claim">' + esc(e.claim || '') + '</div>'
      + '<div class="ev-meta"><span class="ex-tag ' + qtCls + '">' + esc(qtLabel) + '</span>'
      + '<span class="ex-verify' + (verifyOk ? ' ok' : '') + '">' + esc(verify) + '</span></div>'
      + '</div><span class="ev-arrow">▶</span></summary>';
    h += '<div class="ex-ev-body">';
    if (e.quote) {
      h += '<div class="ex-quote"><span class="qt">' + esc(qt) + '</span>' + esc(e.quote);
      if (qt === '审定叙述') {
        h += '<span class="nonverbatim">平台审定叙述，非逐字原文；引用时请核对来源原文。</span>';
      } else if (qt === '原文') {
        h += '<span class="nonverbatim">原文节选，仅供说明，未复制全篇。</span>';
      }
      h += '</div>';
    }
    h += '<div class="ex-loc"><b>来源：</b>' + esc(loc.label || '见下方引用来源');
    if (loc.url && /^https?:\/\//i.test(String(loc.url))) {
      h += ' · <a href="' + esc(loc.url) + '" target="_blank" rel="noopener noreferrer">在线查看</a>';
    }
    h += '</div>';
    h += '<div class="ex-loc"><b>引用来源：</b></div>';
    h += '<div class="ex-ev-src">' + (e.source_ids || []).map(srcTag).join('') + '</div>';
    if (e.verify_note) {
      h += '<div class="ex-loc" style="color:var(--ink3)">' + esc(e.verify_note) + '</div>';
    }
    (e.public_checks || []).forEach(function (pc) {
      if (!pc || !/^https?:\/\//i.test(String(pc.url || ''))) return;
      h += '<div class="ex-loc"><b>公开来源核对：</b>'
        + '<a href="' + esc(pc.url) + '" target="_blank" rel="noopener noreferrer">'
        + esc(pc.title || pc.url) + '</a>'
        + (pc.publisher ? ' · ' + esc(pc.publisher) : '')
        + (pc.checked_at ? ' · ' + esc(pc.checked_at) : '')
        + (pc.result ? '<div class="ex-pub-note">' + esc(pc.result) + '</div>' : '')
        + '</div>';
    });
    h += '<div class="ex-loc" style="font-size:10.5px;color:var(--ink3)">片段 ID：'
      + '<code>' + esc(e.snippet_id || '') + '</code></div>';
    h += '</div></details>';
    return h;
  }

  /* ------------------------------------------------------------------------
   * 地图示意
   * ---------------------------------------------------------------------- */
  function schematicSvg(c, W, H) {
    var nodes = allNodes();
    var hot = {};
    (c.event_ids || []).forEach(function (id) { hot[id] = true; });
    var mfX = b().mfX, mfY = b().mfY;
    if (typeof mfX !== 'function' || typeof mfY !== 'function') return '';
    var h = '<svg class="ex-mini" viewBox="0 0 ' + W + ' ' + H + '" width="100%"'
      + ' preserveAspectRatio="xMidYMid meet" role="img" aria-label="本章事件点位示意">';
    // 全专题节点的淡色底图
    var allPts = [];
    nodes.forEach(function (n) {
      if (typeof n.lng !== 'number' || typeof n.lat !== 'number') return;
      var x = mfX(n.lng, W), y = mfY(n.lat, H);
      allPts.push({ n: n, x: x, y: y });
      if (!hot[n.id]) {
        h += '<circle class="mn-dot" cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="1.05"></circle>';
      }
    });
    // 本章事件按时间顺序连线
    var hp = [];
    (c.event_ids || []).forEach(function (id) {
      allPts.forEach(function (p) { if (p.n.id === id) hp.push(p); });
    });
    if (hp.length > 1) {
      h += '<path class="mn-line" d="' + hp.map(function (p, i) {
        return (i ? 'L' : 'M') + p.x.toFixed(2) + ',' + p.y.toFixed(2);
      }).join(' ') + '"></path>';
    }
    hp.forEach(function (p) {
      h += '<circle class="mn-hot" cx="' + p.x.toFixed(2) + '" cy="' + p.y.toFixed(2) + '" r="2.1"></circle>';
      var lx = Math.max(2, Math.min(W - 18, p.x + 3));
      var ly = Math.max(5, Math.min(H - 2, p.y - 2.3));
      h += '<text class="mn-label" x="' + lx.toFixed(2) + '" y="' + ly.toFixed(2) + '">'
        + esc(trim(p.n.name, 7)) + '</text>';
    });
    h += '<text class="mn-cap" x="2" y="' + (H - 1.2) + '">按经纬度投影 · 非真实底图</text>';
    h += '</svg>';
    return h;
  }

  /* ------------------------------------------------------------------------
   * 右栏：地图 + AI
   * ---------------------------------------------------------------------- */
  function renderRail() {
    var box = byId('exRail');
    if (!box) return;
    var c = chOf(state.chapter);
    if (!c) { box.innerHTML = ''; return; }
    var events = (c.event_ids || []).map(nodeOf).filter(Boolean);
    var primary = nodeOf(c.primary_event_id);

    var h = '<div class="ex-side"><div class="ex-side-h"><h3>本章现场</h3>'
      + '<span class="ex-tag">' + events.length + ' 个事件</span></div>';
    h += schematicSvg(c, 100, 64);
    h += '<p>' + esc(c.place_label || '') + '</p>';
    if (primary) {
      h += '<p class="ex-side-note">主事件：' + esc(primary.name) + ' · ' + esc(primary.date_label || '') + '</p>';
    }
    h += '<div class="ex-chips" style="margin-top:6px">';
    h += '<button type="button" class="ex-btn sm" data-ex-map="' + esc(c.primary_event_id)
      + '">地图定位</button>';
    h += '<button type="button" class="ex-btn sm" data-ex-graph="'
      + esc((primary && primary.name) || c.title) + '">图谱查看</button>';
    if (c.primary_event_id) {
      h += '<button type="button" class="ex-btn sm" data-ex-evstory="'
        + esc(c.primary_event_id) + '">事件动画</button>';
    }
    h += '</div></div>';

    h += '<div class="ex-side ex-side-ai"><div class="ex-side-h"><h3>AI 讲解 · 本章</h3>'
      + '<span class="ex-tag green">带章节上下文</span></div>';
    h += '<p>回答限定在本章事件与已审定史料片段内；检索不到会明确说「史料未载」。</p>';
    var ok = false;
    try { ok = !!(b().serviceOk && b().serviceOk()); } catch (e) { ok = false; }
    if (!ok) {
      h += '<div class="ex-ai-offline">当前为离线模式：展陈文字、证据卡与摘要仍可阅读；'
        + 'AI 讲解需通过本地服务打开本页。</div>';
    }
    h += '<div class="ex-ai-quick">';
    (c.ai_quick || []).forEach(function (q) {
      h += '<button type="button" data-ex-q="' + esc(q) + '">' + esc(q) + '</button>';
    });
    h += '</div>';
    h += '<form class="ex-ai-form" id="exAiForm">'
      + '<textarea id="exAiInput" rows="2" placeholder="问本章：如「这次会议有什么意义？」"></textarea>'
      + '<button type="submit">提问</button></form>';
    h += '<div class="ex-ai-log" id="exAiLog" aria-live="polite"></div>';
    h += '<div class="ex-side-note">AI 回答会显示引用片段 ID 与来源标签；'
      + '未经史料核验的补充回答会单独标红提示。</div></div>';

    box.innerHTML = h;
  }

  function renderSummaryRail() {
    var box = byId('exRail');
    if (!box) return;
    var p = myProgress();
    var vs = visitedSet();
    var visited = CH.filter(function (c) { return vs[c.id]; });
    var h = '<div class="ex-side"><div class="ex-side-h"><h3>摘要说明</h3></div>'
      + '<p>摘要只汇总本展章节、事件与证据来源；不生成新的史实结论。</p>'
      + '<p class="ex-side-note">已浏览 ' + visited.length + ' / ' + CH.length + ' 章。'
      + '进度关联当前访客，可随时清除；离线时暂存在本机。</p></div>';
    h += '<div class="ex-side"><div class="ex-side-h"><h3>审校状态</h3></div>'
      + '<p><span class="ex-tag gold">' + esc(EX.review_status || '待第二人复核') + '</span></p>'
      + '<p class="ex-side-note">证据卡按来源级引用；'
      + '正式发布前需由内容负责人逐条复核。</p></div>';
    h += '<div class="ex-side"><div class="ex-side-h"><h3>继续</h3></div>'
      + '<div class="ex-side-links"><button type="button" data-ex-home="1">返回展览首页<span>→</span></button>'
      + '<button type="button" data-ex-ch="' + esc(CH[0].id) + '">从第一章重新参观<span>→</span></button>'
      + '</div></div>';
    box.innerHTML = h;
  }

  /* ------------------------------------------------------------------------
   * 观展摘要
   * ---------------------------------------------------------------------- */
  function renderSummary() {
    var box = byId('exArticle');
    if (!box) return;
    var vs = visitedSet();
    var visited = CH.filter(function (c) { return vs[c.id]; });
    var evCount = 0;
    var srcMap = {};
    CH.forEach(function (c) {
      (c.evidence_ids || []).forEach(function (eid) {
        var e = EVBY[eid];
        if (!e) return;
        evCount++;
        (e.source_ids || []).forEach(function (sid) {
          if (!srcMap[sid]) srcMap[sid] = { id: sid, use: 0 };
          srcMap[sid].use++;
        });
      });
    });
    var srcs = Object.keys(srcMap).map(function (k) { return srcMap[k]; })
      .sort(function (a, b2) { return a.id < b2.id ? -1 : 1; });
    var srcDoc = (b().data && b().data.sources) || {};
    var srcList = srcDoc.sources || [];
    var srcById = {};
    srcList.forEach(function (s) { srcById[s.id] = s; });
    var h = '<div class="ex-summary">';
    h += '<div class="ex-sum-hero"><div class="ex-art-kicker">观展摘要 · ' + esc(EX.title) + '</div>'
      + '<h1>从转折走向胜利</h1>'
      + '<p>' + esc((EX.closing && EX.closing.text) || '') + '</p>'
      + '<div class="ex-sum-stats">'
      + '<div><b>' + visited.length + '/' + CH.length + '</b>已浏览章节</div>'
      + '<div><b>' + evCount + '</b>条证据</div>'
      + '<div><b>' + srcs.length + '</b>个引用来源</div>'
      + '<div><b>' + (EXD.media || []).length + '</b>个媒体素材</div>'
      + '</div></div>';

    h += '<div class="ex-sec-title">章节回顾</div><div class="ex-sum-list">';
    CH.forEach(function (c) {
      var done = !!vs[c.id];
      var evs = (c.event_ids || []).map(nodeOf).filter(Boolean);
      h += '<div class="ex-sum-row"><span class="no">' + esc(c.order) + '</span><div>'
        + '<div class="tt">' + esc(c.title) + '</div>'
        + '<div class="ds">' + esc(c.date_label || '') + ' · '
        + evs.map(function (n) { return n.name; }).join(' / ') + '</div></div>'
        + '<span class="st' + (done ? ' done' : '') + '">' + (done ? '已浏览' : '未浏览')
        + '</span></div>';
    });
    h += '</div>';

    h += '<div class="ex-sec-title">关键事件</div><div class="ex-chips">';
    var seen = {};
    CH.forEach(function (c) {
      (c.event_ids || []).forEach(function (nid) {
        if (seen[nid]) return;
        seen[nid] = true;
        var n = nodeOf(nid);
        if (!n) return;
        h += '<button type="button" class="ex-chip' + (n.level === 'sub' ? ' sub' : '') + '"'
          + ' data-ex-node="' + esc(n.id) + '"><span class="d"></span>' + esc(n.name) + '</button>';
      });
    });
    h += '</div>';

    h += '<div class="ex-sec-title">引用来源清单<span class="ex-tag">按编号排序</span></div>';
    h += '<div class="ex-cites">';
    srcs.forEach(function (x) {
      var s = srcById[x.id];
      h += '<div class="ex-cite"><span class="sid">' + srcTag(x.id) + '</span>'
        + '<span class="c-title">' + esc((s && s.title) || '（来源信息缺失）') + '</span>'
        + '<span class="c-use">用于 ' + x.use + ' 条证据</span></div>';
    });
    h += '</div>';

    h += '<div class="ex-sum-note">共 ' + evCount + ' 条证据，均按来源级引用'
      + '（书名／篇名、出版者、年份、链接），不逐页标注页码；'
      + '平台不以推测值替代，正式发布前需完成第二人复核。</div>';

    h += '<div class="ex-sum-actions">'
      + '<button type="button" class="ex-btn primary" data-sum-act="print">打印 / 导出 PDF</button>'
      + '<button type="button" class="ex-btn" data-sum-act="copy">复制本页链接</button>'
      + '<button type="button" class="ex-btn" data-sum-act="restart">从第一章重新参观</button>'
      + '<button type="button" class="ex-btn" data-sum-act="home">返回展览首页</button>'
      + '<button type="button" class="ex-btn" data-sum-act="clear">清除观展记录</button>'
      + '</div>';
    h += '<div class="ex-sum-note">进度提示：「已浏览章节」关联当前访客并保存在服务端，离线时暂存在本机。'
      + '换设备或清除访客Cookie后无法自动找回；访客身份有效期30天。</div>';
    h += '</div>';
    box.innerHTML = h;
  }

  /* ------------------------------------------------------------------------
   * AI 问答
   * ---------------------------------------------------------------------- */
  function askAi(q) {
    var c = chOf(state.chapter);
    if (!c || !q) return;
    var log = byId('exAiLog');
    if (!log) return;
    var input = byId('exAiInput');
    if (input) input.value = '';

    log.insertAdjacentHTML('beforeend',
      '<div class="ex-ai-msg"><div class="ex-ai-q">' + esc(q) + '</div></div>');
    var holder = document.createElement('div');
    holder.className = 'ex-ai-msg';
    holder.innerHTML = '<div class="ex-ai-a" style="color:var(--ink3)">正在检索本章史料……</div>';
    log.appendChild(holder);
    log.scrollTop = log.scrollHeight;

    var ok = false;
    try { ok = !!(b().serviceOk && b().serviceOk()); } catch (e) { ok = false; }
    if (!ok) {
      holder.innerHTML = '<div class="ex-ai-a"><span class="eng none">免费展示版</span>'
        + '在线 AI 问答尚未开放。请阅读本章展陈文字、史料与证据卡。</div>';
      log.scrollTop = log.scrollHeight;
      return;
    }

    state.aiHistory.push({ role: 'user', content: q });
    if (state.aiHistory.length > 6) state.aiHistory = state.aiHistory.slice(-6);

    var base = b().serviceBase || '';
    fetch(base + '/api/ai/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: q,
        chapter_id: c.id,
        node_id: c.primary_event_id,
        history: state.aiHistory.slice(-6)
      })
    })
      .then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; })
          .catch(function () { return { ok: false, status: r.status, d: {} }; });
      })
      .then(function (x) {
        if (!x.ok) {
          var msg = (x.d && x.d.answer) || (x.status === 429
            ? '提问过于频繁，请稍后再试。' : '服务暂时不可用，请稍后重试。');
          holder.innerHTML = '<div class="ex-ai-a"><span class="eng error">未完成</span>'
            + esc(msg) + '</div>';
        } else {
          holder.innerHTML = aiAnswerHtml(x.d || {});
          var ans = String((x.d && x.d.answer) || '');
          state.aiHistory.push({ role: 'assistant', content: ans.slice(0, 400) });
          if (state.aiHistory.length > 6) state.aiHistory = state.aiHistory.slice(-6);
        }
        log.scrollTop = log.scrollHeight;
      })
      .catch(function () {
        holder.innerHTML = '<div class="ex-ai-a"><span class="eng error">连接失败</span>'
          + '未能连接讲解服务，请检查网络或稍后重试。</div>';
        log.scrollTop = log.scrollHeight;
      });
  }

  function aiAnswerHtml(d) {
    var eng = d.engine || 'none';
    var label = eng === 'A' ? '引擎A · 史料直取'
      : eng === 'B' ? '引擎B · 大模型 · 已校验'
        : eng === 'C' ? '引擎C · 知识补充 · 未核验'
          : eng === 'error' ? '调用异常' : '史料未载';
    var cls = (eng === 'A' || eng === 'B') ? '' : (eng === 'C' ? 'C' : 'none');
    var h = '<div class="ex-ai-a"><span class="eng ' + cls + '">' + esc(label) + '</span>';
    if (d.unverified) {
      h += '<div class="ai-warn">⚠ ' + esc(d.note || '该回答由大模型生成，未经平台史料核验。') + '</div>';
    }
    h += '<div>' + esc(d.answer || '') + '</div>';

    var ctx = d.context || {};
    if (ctx.chapter_title || ctx.node_name) {
      h += '<div class="ai-ev">上下文：'
        + esc([ctx.chapter_title, ctx.node_name].filter(Boolean).join(' · ')) + '</div>';
    }
    if (d.evidence && d.evidence.length) {
      h += '<div class="ai-ev"><b>引用片段</b><br>' + d.evidence.slice(0, 4).map(function (e) {
        return '<code>' + esc(e.id) + '</code> ' + esc(trim(e.text || '', 58));
      }).join('<br>') + '</div>';
    }
    if (d.sources && d.sources.length) {
      h += '<div class="ai-src">' + d.sources.map(function (s) {
        return srcTag(s.id);
      }).join('') + '</div>';
    }
    h += '</div>';
    return h;
  }

  /* ------------------------------------------------------------------------
   * 语音朗读
   * ---------------------------------------------------------------------- */
  function ttsText(c) {
    var parts = [c.title + '。' + (c.narrative || '')];
    (c.key_facts || []).forEach(function (f, i) {
      parts.push('关键事实' + (i + 1) + '。' + (f.text || ''));
    });
    return parts.join('');
  }
  function splitSentences(t) {
    var out = [];
    var re = /[^。！？!?；;\n]+[。！？!?；;]?/g;
    var m;
    while ((m = re.exec(t))) {
      var s = m[0].trim();
      if (s) out.push(s);
    }
    return out;
  }
  function ttsNow(text) {
    var el = byId('exTtsNow');
    if (el) el.textContent = text;
  }
  function speakChapter() {
    var c = chOf(state.chapter);
    if (!c) return;
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      ttsNow('当前浏览器不支持语音合成，请直接阅读正文。');
      return;
    }
    stopTts(true);
    TTS.synth = window.speechSynthesis;
    TTS.text = ttsText(c);
    TTS.sentences = splitSentences(TTS.text);
    var u = new SpeechSynthesisUtterance(TTS.text);
    u.lang = 'zh-CN';
    u.rate = TTS.rate;
    u.pitch = 1;
    var boundarySeen = false;
    u.onstart = function () {
      TTS.active = true;
      TTS.paused = false;
      ttsNow('正在朗读：' + trim(TTS.sentences[0] || '', 44));
    };
    u.onboundary = function (ev) {
      if (typeof ev.charIndex !== 'number') return;
      boundarySeen = true;
      var ci = ev.charIndex, acc = 0, cur = '';
      for (var i = 0; i < TTS.sentences.length; i++) {
        acc += TTS.sentences[i].length;
        if (ci < acc) { cur = TTS.sentences[i]; break; }
      }
      ttsNow(cur ? ('正在朗读：' + trim(cur, 44)) : '正在朗读……');
    };
    u.onend = function () {
      TTS.active = false;
      TTS.paused = false;
      ttsNow('朗读结束');
      if (!boundarySeen) ttsNow('朗读结束（当前浏览器不支持逐句字幕）');
    };
    u.onerror = function () {
      TTS.active = false;
      TTS.paused = false;
      ttsNow('语音合成未能启动，请直接阅读正文。');
    };
    TTS.utt = u;
    try { TTS.synth.cancel(); TTS.synth.speak(u); }
    catch (e) { ttsNow('语音合成未能启动，请直接阅读正文。'); }
  }
  function pauseTts() {
    if (!TTS.synth) return;
    if (TTS.synth.speaking && !TTS.synth.paused) {
      TTS.synth.pause();
      TTS.paused = true;
      ttsNow('已暂停；点「暂停」继续。');
    } else if (TTS.synth.paused) {
      TTS.synth.resume();
      TTS.paused = false;
      ttsNow('继续朗读……');
    }
  }
  function stopTts(silent) {
    TTS.active = false;
    TTS.paused = false;
    if (TTS.synth && TTS.synth.speaking) {
      try { TTS.synth.cancel(); } catch (e) {}
    }
    TTS.utt = null;
    if (!silent) ttsNow('已停止。点「播放」重新朗读。');
    else {
      var el = byId('exTtsNow');
      if (el) el.textContent = '不自动播放；点「播放」朗读本章叙事与关键事实';
    }
  }

  /* ------------------------------------------------------------------------
   * 交互
   * ---------------------------------------------------------------------- */
  function closest(el, sel) {
    if (!el) return null;
    if (el.closest) return el.closest(sel);
    while (el && el !== document) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentNode;
    }
    return null;
  }
  function handle(el) {
    if (!el) return false;
    var d = el.dataset || {};
    if (d.exIntro) { showIntro(); return true; }
    if (d.exCover) { showCover(); return true; }
    if (d.exCh) { openChapter(d.exCh); return true; }
    if (d.exSummary) { openSummary(); return true; }
    if (d.exHome) { goHome(); return true; }
    if (d.exNode) {
      var go = b().goNode;
      if (typeof go === 'function') go(d.exNode);
      return true;
    }
    if (d.exAtlas) {
      var oa = b().openAtlas;
      if (typeof oa === 'function') oa(d.exAtlas);
      return true;
    }
    if (d.exMap) {
      var fm = b().focusMap;
      if (typeof fm === 'function') fm(d.exMap);
      return true;
    }
    if (d.exGraph) {
      var fg = b().focusGraph;
      if (typeof fg === 'function') fg(d.exGraph);
      return true;
    }
    if (d.exPerson) {
      var op = b().openPerson;
      if (typeof op === 'function') op(d.exPerson);
      return true;
    }
    if (d.exEvstory) {
      if (window.RgStory && typeof window.RgStory.openEvent === 'function') {
        window.RgStory.openEvent(d.exEvstory);
      }
      return true;
    }
    if (d.exGoto) {
      if (d.exGoto === 'sources') {
        var sh = b().showSources;
        if (typeof sh === 'function') sh(null);
      } else {
        var sv = b().setView;
        if (typeof sv === 'function') sv(d.exGoto);
      }
      return true;
    }
    if ('exStory' in d) {
      if (window.RgStory && typeof window.RgStory.open === 'function') window.RgStory.open();
      return true;
    }
    if ('exOverview' in d) {
      var so = b().showOverview;
      if (typeof so === 'function') so();
      return true;
    }
    if (d.tts) {
      if (d.tts === 'play') speakChapter();
      else if (d.tts === 'pause') pauseTts();
      else if (d.tts === 'stop') stopTts();
      return true;
    }
    if (d.exQ) { askAi(d.exQ); return true; }
    if (d.sumAct) { summaryAction(d.sumAct); return true; }
    return false;
  }
  function bindGlobal() {
    var home = byId('viewHome');
    var toc = byId('exToc');
    var art = byId('exArticle');
    var rail = byId('exRail');
    var tour = byId('viewTour');

    function wire(box) {
      if (!box) return;
      box.addEventListener('click', function (ev) {
        var el = closest(ev.target, '[data-ex-ch],[data-ex-summary],[data-ex-home],'
          + '[data-ex-intro],[data-ex-cover],'
          + '[data-ex-node],[data-ex-atlas],[data-ex-map],[data-ex-graph],[data-ex-goto],'
          + '[data-ex-person],[data-ex-evstory],[data-ex-story],[data-ex-overview],'
          + '[data-tts],[data-ex-q],[data-sum-act]');
        if (el && handle(el)) ev.preventDefault();
      });
    }
    wire(home); wire(toc); wire(art); wire(rail);

    if (tour) {
      tour.addEventListener('submit', function (ev) {
        if (ev.target && ev.target.id === 'exAiForm') {
          ev.preventDefault();
          var input = byId('exAiInput');
          askAi(input ? input.value.trim() : '');
        }
      });
      tour.addEventListener('keydown', function (ev) {
        if (ev.target && ev.target.id === 'exAiInput' && ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          askAi(ev.target.value.trim());
        }
      });
      tour.addEventListener('change', function (ev) {
        if (ev.target && ev.target.id === 'exTtsRate') {
          TTS.rate = Number(ev.target.value) || 1;
          if (TTS.active || (TTS.synth && TTS.synth.speaking)) speakChapter();
        }
      });
    }
    window.addEventListener('hashchange', onHashChange);
  }

  function summaryAction(act) {
    if (act === 'print') {
      setTimeout(function () { window.print(); }, 80);
    } else if (act === 'copy') {
      copyLink();
    } else if (act === 'restart') {
      openChapter(CH[0].id);
    } else if (act === 'home') {
      goHome();
    } else if (act === 'clear') {
      var yes = window.confirm('清除当前访客的观展记录？联网时会同步清除服务端记录，展览内容保持不变。');
      if (!yes) return;
      try { localStorage.removeItem(PROGRESS_KEY); } catch (e) {}
      toast('当前访客观展记录已清除');
      renderToc();
      renderSummary();
      renderSummaryRail();
    }
  }

  function copyLink() {
    var url = location.href;
    function fallback() {
      try {
        window.prompt('复制以下链接：', url);
        toast('请在弹窗中复制链接');
      } catch (e) {}
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        toast('链接已复制，可直接分享到当前章节/摘要');
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  function toast(msg) {
    var el = byId('exToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'exToast';
      el.className = 'ex-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /* ------------------------------------------------------------------------
   * 对外接口
   * ---------------------------------------------------------------------- */
  window.RgExhibit = {
    init: init,
    bootRoute: bootRoute,
    onView: onView,
    goHome: goHome,
    openChapter: openChapter,
    openSummary: openSummary,
    routeFromHash: routeFromHash
  };
})();
