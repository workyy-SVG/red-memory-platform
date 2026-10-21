/* ============================================================================
 * rg-story.js —— 红色记忆平台 · 长征贵州段 9 事件快速纵览
 * ----------------------------------------------------------------------------
 * 设计边界：
 *   · 页面内动画，不导出视频，不合成历史影像；
 *   · 所有事件名、日期、地点、摘要、来源均取自 data/nodes.json 与
 *     data/exhibition.json 的审定字段，不新增史实；
 *   · 路线为“事件顺序示意”，不是实际行军路线；
 *   · 语音由浏览器语音合成朗读页面审定文案，不使用历史录音，也不调用外部音频；
 *   · 语音可随时关闭，关闭状态记在本机。
 * ========================================================================== */
(function () {
  'use strict';

  // 纵览只报“时间 + 事件名称”，每段约 5 秒；
  // 9 段 × 5 秒 + 3 秒标题 + 2 秒收束 = 50 秒。
  var INTRO = 3000;
  var STEP = 5000;
  var OUTRO = 2000;
  var TOTAL = INTRO + STEP * 9 + OUTRO;   // 50 秒

  // 单事件动画：2 秒标题 + 按“经过”文案长度分配的分镜 + 3 秒收束。
  // 不再固定 30 秒；文案多长就留多长，保证每句都能念完。
  var EV_INTRO = 2000;
  var EV_OUTRO = 3000;

  var state = {
    open: false,
    playing: false,
    elapsed: 0,
    raf: 0,
    lastTs: 0,
    step: -1,
    nodes: [],
    pathEl: null,
    pathLen: 0,
    lastFocus: null,
    reduced: false,
    mode: 'overview',   // overview | event
    evNode: null,
    beats: [],
    beatSpans: [],      // 每段分镜的实际时长（按文案字数分配）
    bodyMs: 0,
    total: TOTAL,
    sound: true
  };

  try {
    state.sound = window.localStorage.getItem('rg_story_sound') !== '0';
  } catch (e) { /* 无痕模式等 */ }

  function b() { return window.RgExhibitBridge || {}; }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    if (b().esc) return b().esc(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function cnNum(n) {
    return ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'][n] || String(n);
  }
  function data() { return b().data || {}; }

  /* ---------------- 浏览器语音合成（非历史录音） ---------------- */
  var voice = { token: 0, timer: 0 };

  function canSpeak() {
    return !!(window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function');
  }
  function stopVoice() {
    voice.token++;                       // 作废尚未开口与排队中的旧语音
    if (voice.timer) { clearTimeout(voice.timer); voice.timer = 0; }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
  }
  function pickVoice(synth) {
    try {
      var vs = synth.getVoices() || [];
      for (var i = 0; i < vs.length; i++) {
        if (/^zh([-_]|$)/i.test(vs[i].lang || '')
          || /Chinese|中文|普通话/i.test(vs[i].name || '')) return vs[i];
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }
  /* 按文本字数反推语速，让整句在分到的时长内读完；过快会听不清，上限 1.62 */
  function rateFor(text, seconds) {
    var n = String(text || '').replace(/[，。！？；：、,.!?;:\s]/g, '').length;
    var r = n / (Math.max(2.4, seconds) * 4.2);
    return Math.max(1.05, Math.min(1.62, r));
  }
  function narrate(text, seconds) {
    if (!state.sound || !text || !canSpeak() || !state.playing) return;
    var synth = window.speechSynthesis;
    var token = ++voice.token;
    if (voice.timer) { clearTimeout(voice.timer); voice.timer = 0; }
    var wasActive = false;
    try { wasActive = !!(synth.speaking || synth.pending); } catch (e) { wasActive = false; }
    if (wasActive) { try { synth.cancel(); } catch (e2) { /* 忽略 */ } }
    var rate = rateFor(text, seconds);
    function speakNow() {
      if (token !== voice.token || !state.sound || !state.playing) return;
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = rate;
      u.pitch = 1;
      var v = pickVoice(synth);
      if (v) { try { u.voice = v; } catch (e6) { /* 语音对象失效时用默认声音 */ } }
      u.onerror = function (ev) {
        // 停止、切段造成的 interrupted / canceled 属正常，不提示
        if (token !== voice.token) return;
        var e3 = ev && ev.error;
        if (e3 === 'interrupted' || e3 === 'canceled') return;
      };
      try { if (synth.paused) synth.resume(); } catch (e4) { /* 忽略 */ }
      try { synth.speak(u); } catch (e5) { /* 不支持时静默 */ }
    }
    // Chrome 在 cancel() 同一轮里 speak() 会被丢弃；有旧语音时延后一轮再开口
    if (wasActive) voice.timer = setTimeout(speakNow, 130);
    else speakNow();
  }
  function overviewLine(n) {
    if (!n) return '';
    // 用户要求：纵览只保留“时间 + 事件名称”，不再朗读概述。
    var date = String(n.date_label || '').replace(/[。；，,]+$/, '');
    return (date ? date + '，' : '') + (n.name || '') + '。';
  }
  function beatLine(bt, n) {
    if (!bt) return '';
    // “经过”按原文整段朗读，不截断
    return String(bt.text || '').replace(/\s+/g, '');
  }
  function narrateCurrent() {
    if (!state.open || !state.sound) return;
    if (state.mode === 'event') {
      var n = state.evNode || {};
      if (state.step >= 0 && state.beats[state.step]) {
        var span = (state.beatSpans[state.step] || 5000) / 1000;
        narrate(beatLine(state.beats[state.step], n), span - 0.35);
      } else {
        narrate((n.name || '') + '。', EV_INTRO / 1000 - 0.3);
      }
    } else if (state.step >= 0 && state.nodes[state.step]) {
      narrate(overviewLine(state.nodes[state.step]), STEP / 1000 - 0.5);
    } else {
      narrate('长征贵州段九个核心事件。', INTRO / 1000 - 0.6);
    }
  }
  function syncSoundBtn() {
    var btn = $('rgStorySound');
    if (!btn) return;
    if (!canSpeak()) {
      btn.disabled = true;
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', '当前浏览器不支持语音合成');
      btn.querySelector('.ic').textContent = '🔇';
      btn.querySelector('.tx').textContent = '无语音';
      return;
    }
    btn.setAttribute('aria-pressed', state.sound ? 'true' : 'false');
    btn.setAttribute('aria-label', state.sound ? '关闭语音' : '打开语音');
    btn.querySelector('.ic').textContent = state.sound ? '🔊' : '🔇';
    btn.querySelector('.tx').textContent = state.sound ? '声音开' : '声音关';
  }
  function setSound(on) {
    state.sound = !!on;
    try { window.localStorage.setItem('rg_story_sound', state.sound ? '1' : '0'); } catch (e) { /* 忽略 */ }
    if (!state.sound) stopVoice();
    syncSoundBtn();
    if (state.sound) narrateCurrent();
  }

  function sortedNodes() {
    var arr = [];
    try {
      arr = (b().nodes && b().nodes()) || ((data().nodes || {}).nodes || []);
    } catch (e) { arr = []; }
    return arr.slice().filter(function (n) {
      return n && n.id && n.lng != null && n.lat != null;
    }).sort(function (a, c) { return (a.order || 0) - (c.order || 0); });
  }

  function chapters() {
    var ex = data().exhibition || {};
    return ex.chapters || [];
  }

  function chapterOf(id) {
    var list = chapters();
    for (var i = 0; i < list.length; i++) {
      var ids = list[i].event_ids || [];
      for (var j = 0; j < ids.length; j++) {
        if (ids[j] === id) return list[i];
      }
    }
    return null;
  }

  function summary(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (s.length <= 46) return s;
    return s.slice(0, 46) + '…';
  }

  function project(n) {
    var x, y;
    try {
      x = b().mfX ? b().mfX(n.lng, 760) : 0;
      y = b().mfY ? b().mfY(n.lat, 400) : 0;
    } catch (e) { x = 0; y = 0; }
    return { x: 70 + x, y: 60 + y };
  }

  // 自动取景：只做等比缩放与平移，保持事件的相对方位不变；
  // 点位密集时把画面放大到舞台中部，避免标签互相压叠。
  function fitPoints(pts) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(function (p) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    var bw = Math.max(1, maxX - minX);
    var bh = Math.max(1, maxY - minY);
    var s = Math.min(660 / bw, 320 / bh, 2.4);
    if (s <= 1) return;
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    pts.forEach(function (p) {
      p.x = 450 + (p.x - cx) * s;
      p.y = 260 + (p.y - cy) * s;
    });
  }

  function build() {
    var nodes = sortedNodes();
    state.nodes = nodes;
    state.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    var ov = document.createElement('div');
    ov.className = 'rg-story-ov';
    ov.id = 'rgStory';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'rgStoryTitle');

    var pts = nodes.map(project);
    fitPoints(pts);
    var pathD = '';
    pts.forEach(function (p, i) {
      pathD += (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ';
    });

    var svg = '<svg class="story-svg" viewBox="0 0 900 520" preserveAspectRatio="xMidYMid meet" aria-hidden="true">'
      + '<defs>'
      + '<linearGradient id="storyBg" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#FBF6EC"/><stop offset="1" stop-color="#F3E9D8"/>'
      + '</linearGradient>'
      + '<filter id="storyGlow" x="-50%" y="-50%" width="200%" height="200%">'
      + '<feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/>'
      + '<feMergeNode in="SourceGraphic"/></feMerge></filter>'
      + '</defs>'
      + '<rect width="900" height="520" fill="url(#storyBg)"/>';

    // 淡网格：只做空间参照，不画任何虚构边界
    for (var gx = 60; gx < 900; gx += 60) {
      svg += '<line x1="' + gx + '" y1="30" x2="' + gx + '" y2="490" stroke="#DCCFBC" stroke-width=".6" opacity=".55"/>';
    }
    for (var gy = 40; gy < 520; gy += 40) {
      svg += '<line x1="30" y1="' + gy + '" x2="870" y2="' + gy + '" stroke="#DCCFBC" stroke-width=".6" opacity=".55"/>';
    }
    svg += '<text x="42" y="44" fill="#8B7A63" font-size="11" letter-spacing="1">黔北 · 黔东 · 黔中 事件顺序示意</text>';
    svg += '<text x="858" y="492" text-anchor="end" fill="#9B8B76" font-size="10.5">非实际行军路线</text>';

    // 底层路线 + 高亮路线
    svg += '<path id="rgStoryBase" d="' + pathD + '" fill="none" stroke="#B9A58C" '
      + 'stroke-width="2" stroke-dasharray="5 7" stroke-linecap="round" opacity=".75"/>';
    svg += '<path id="rgStoryPath" d="' + pathD + '" fill="none" stroke="#8C1F28" '
      + 'stroke-width="4" stroke-linecap="round" stroke-linejoin="round" filter="url(#storyGlow)"/>';

    // 标签避让：在右/左/下/上四个方位中选重叠最少且不出界的位置。
    function textWidth(s, fs) {
      var w = 0;
      for (var i = 0; i < s.length; i++) w += (s.charCodeAt(i) > 255 ? fs : fs * 0.56);
      return w;
    }
    var placed = [];
    var items = nodes.map(function (n, i) {
      var p = pts[i];
      var ch = chapterOf(n.id);
      var tag = ch ? ('第' + cnNum(ch.order) + '章') : '总库';
      var lw = Math.max(textWidth(n.name, 11.5), textWidth(tag, 9.5)) + 4;
      var cands = [
        { x: p.x + 15, y: p.y - 11, w: lw, h: 28, ax: 15, ay: 4, anchor: 'start', ty: 18 },
        { x: p.x - 15 - lw, y: p.y - 11, w: lw, h: 28, ax: -15, ay: 4, anchor: 'end', ty: 18 },
        { x: p.x - lw / 2, y: p.y + 11, w: lw, h: 29, ax: 0, ay: 24, anchor: 'middle', ty: 38 },
        { x: p.x - lw / 2, y: p.y - 40, w: lw, h: 29, ax: 0, ay: -30, anchor: 'middle', ty: -16 }
      ];
      var best = cands[0], bestScore = Infinity;
      cands.forEach(function (c) {
        var score = 0;
        if (c.x < 14 || c.x + c.w > 886 || c.y < 26 || c.y + c.h > 500) score += 10000;
        placed.forEach(function (q) {
          var ox = Math.min(c.x + c.w, q.x + q.w) - Math.max(c.x, q.x);
          var oy = Math.min(c.y + c.h, q.y + q.h) - Math.max(c.y, q.y);
          if (ox > 0 && oy > 0) score += (ox + 8) * (oy + 8);
        });
        pts.forEach(function (q, j) {
          if (j === i) return;
          if (q.x > c.x - 9 && q.x < c.x + c.w + 9 && q.y > c.y - 9 && q.y < c.y + c.h + 9) {
            score += 180;
          }
        });
        if (score < bestScore) { bestScore = score; best = c; }
      });
      placed.push(best);
      return { n: n, p: p, tag: tag, c: best };
    });

    items.forEach(function (it, i) {
      var p = it.p, c = it.c;
      svg += '<g class="story-dot" data-step="' + i + '" data-story-ev="' + esc(it.n.id) + '"'
        + ' role="button" tabindex="0" aria-label="播放' + esc(it.n.name) + '事件动画"'
        + ' transform="translate(' + p.x + ',' + p.y + ')">'
        + '<circle class="story-halo" r="17" fill="#8C1F28" opacity="0"/>'
        + '<circle class="story-ring" r="12" fill="#FBF6EC" stroke="#8C1F28" stroke-width="2"/>'
        + '<circle class="story-core" r="4.5" fill="#8C1F28"/>'
        + '<text class="story-num" x="0" y="4" text-anchor="middle" font-size="10" '
        + 'font-weight="700" fill="#8C1F28">' + (i + 1) + '</text>'
        + '<text class="story-label" x="' + c.ax + '" y="' + c.ay + '" text-anchor="' + c.anchor + '" '
        + 'font-size="11.5" fill="#4A3F35" paint-order="stroke" stroke="#FBF6EC" stroke-width="3.5">'
        + esc(it.n.name) + '</text>'
        + '<text class="story-tag" x="' + c.ax + '" y="' + c.ty + '" text-anchor="' + c.anchor + '" '
        + 'font-size="9.5" fill="#9B8B76" paint-order="stroke" stroke="#FBF6EC" stroke-width="3">'
        + esc(it.tag) + '</text>'
        + '</g>';
    });
    svg += '</svg>';

    var head = '<div class="story-head">'
      + '<div><div class="story-eyebrow">数字展陈 · 预展版 · 待第二人复核</div>'
      + '<h2 id="rgStoryTitle">长征贵州段 · 五十秒纵览</h2></div>'
      + '<button type="button" class="story-x" data-story-close aria-label="关闭动画">✕</button>'
      + '</div>';

    var intro = '<div class="story-intro" aria-hidden="true">'
      + '<div class="si-kicker">1934.10 — 1935.03</div>'
      + '<div class="si-title">九个核心事件</div>'
      + '<div class="si-sub">只报时间与事件名称 · 约 50 秒</div>'
      + '</div>';

    var cap = '<div class="story-cap" aria-live="polite">'
      + '<div class="cap-top"><span class="cap-date" id="rgStoryDate">—</span>'
      + '<span class="cap-tag" id="rgStoryTag">—</span></div>'
      + '<div class="cap-name" id="rgStoryName">准备播放</div>'
      + '<div class="cap-place" id="rgStoryPlace">—</div>'
      + '<p class="cap-sum" id="rgStorySum">点击播放，按事件顺序浏览长征贵州段 9 个核心节点；'
      + '点任一事件点位，或点下方「该事件动画」，可直接看该事件经过。</p>'
      + '<div class="cap-src" id="rgStorySrc"></div>'
      + '</div>';

    var foot = '<div class="story-foot">'
      + '<div class="story-progress"><span id="rgStoryBar"></span></div>'
      + '<div class="story-ctrls">'
      + '<button type="button" class="story-btn" id="rgStorySound" aria-label="关闭语音" aria-pressed="true">'
      + '<span class="ic">🔊</span><span class="tx">声音开</span></button>'
      + '<button type="button" class="story-btn" id="rgStoryPlay" aria-label="暂停">'
      + '<span class="ic">❚❚</span><span class="tx">暂停</span></button>'
      + '<button type="button" class="story-btn" id="rgStoryReplay" aria-label="重播">'
      + '<span class="ic">↻</span><span class="tx">重播</span></button>'
      + '<button type="button" class="story-btn" id="rgStoryEvBtn" aria-label="播放当前事件动画" disabled>'
      + '<span class="ic">▶</span><span class="tx">该事件动画</span></button>'
      + '<span class="story-time" id="rgStoryTime">00:00 / 00:50</span>'
      + '<span class="story-note">路线为事件顺序示意 · 语音由浏览器合成，非历史录音</span>'
      + '</div></div>';

    ov.innerHTML = '<div class="story-box' + (state.reduced ? ' reduced' : '') + '">'
      + head + '<div class="story-stage">' + svg + intro + '</div>' + cap + foot + '</div>';
    document.body.appendChild(ov);
    document.body.classList.add('rg-story-open');

    state.pathEl = $('rgStoryPath');
    state.pathLen = 1;
    try { state.pathLen = state.pathEl.getTotalLength() || 1; } catch (e) { /* old browser */ }
    state.pathEl.style.strokeDasharray = state.pathLen + ' ' + state.pathLen;
    state.pathEl.style.strokeDashoffset = state.pathLen;

    return ov;
  }

  // 单事件分镜：只讲事件经过，逐条朗读 facts 里的审定文本，
  // 不补写史实，也不生成历史影像。
  function eventBeats(n) {
    var beats = [];
    var facts = (n.facts || []).filter(function (f) { return f && f.text; });
    facts.forEach(function (f, i) {
      beats.push({
        tag: '经过 ' + (i + 1) + '/' + facts.length,
        title: n.name,
        text: f.text,
        src: (f.source_ids || []).join(' · ')
      });
    });
    // 个别事件没有 facts 时，用审定概述兜底，保证“经过”仍有内容
    if (!facts.length && n.summary) {
      beats.push({
        tag: '经过 1/1',
        title: n.name,
        text: n.summary,
        src: (n.source_ids || []).join(' · ')
      });
    }
    return beats;
  }

  /* 按朗读文案字数分配时长：每秒约 3.8 字，另加 1 秒余量。
     不再平均切 25 秒，句子长就延长动画，保证语音能念完。 */
  function layoutBeats(n) {
    return state.beats.map(function (bt) {
      var line = beatLine(bt, n);
      var len = line.replace(/[^一-龥A-Za-z0-9]/g, '').length;
      return Math.max(3500, Math.round(len / 3.8 * 1000) + 1000);
    });
  }

  function buildEvent(n) {
    var all = sortedNodes();
    state.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    var focus = -1;
    all.forEach(function (x, i) { if (x.id === n.id) focus = i; });
    var pts = all.map(project);
    fitPoints(pts);
    var fpt = focus >= 0 ? pts[focus] : { x: 450, y: 260 };
    if (focus < 0) pts.push(fpt);

    var pathD = '';
    pts.forEach(function (p, i) {
      pathD += (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ';
    });

    var svg = '<svg class="story-svg" viewBox="0 0 900 520" preserveAspectRatio="xMidYMid meet" aria-hidden="true">'
      + '<defs>'
      + '<linearGradient id="storyBg" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#FBF6EC"/><stop offset="1" stop-color="#F3E9D8"/>'
      + '</linearGradient>'
      + '<filter id="storyGlow" x="-50%" y="-50%" width="200%" height="200%">'
      + '<feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/>'
      + '<feMergeNode in="SourceGraphic"/></feMerge></filter>'
      + '</defs>'
      + '<rect width="900" height="520" fill="url(#storyBg)"/>';

    for (var gx = 60; gx < 900; gx += 60) {
      svg += '<line x1="' + gx + '" y1="30" x2="' + gx + '" y2="490" stroke="#DCCFBC" stroke-width=".6" opacity=".5"/>';
    }
    for (var gy = 40; gy < 520; gy += 40) {
      svg += '<line x1="30" y1="' + gy + '" x2="870" y2="' + gy + '" stroke="#DCCFBC" stroke-width=".6" opacity=".5"/>';
    }
    svg += '<text x="42" y="44" fill="#8B7A63" font-size="11" letter-spacing="1">长征贵州段 · 事件位置示意</text>';
    svg += '<text x="858" y="492" text-anchor="end" fill="#9B8B76" font-size="10.5">非实际行军路线</text>';

    svg += '<path d="' + pathD + '" fill="none" stroke="#B9A58C" stroke-width="2" '
      + 'stroke-dasharray="5 7" stroke-linecap="round" opacity=".55"/>';

    // 其余事件点：只作方位参照
    all.forEach(function (x, i) {
      if (x.id === n.id) return;
      var p = pts[i];
      svg += '<g opacity=".62">'
        + '<circle cx="' + p.x + '" cy="' + p.y + '" r="4" fill="#B9A58C"/>'
        + '<text x="' + p.x + '" y="' + (p.y + 17) + '" text-anchor="middle" font-size="9.5" '
        + 'fill="#8B7358" paint-order="stroke" stroke="#FBF6EC" stroke-width="3">'
        + esc(x.name) + '</text></g>';
    });

    // 当前事件：高亮 + 脉冲 + 日期标签
    svg += '<g class="ev-focus" transform="translate(' + fpt.x + ',' + fpt.y + ')">'
      + '<circle class="ev-halo" r="26" fill="#8C1F28" opacity=".12"/>'
      + '<circle r="13" fill="#8C1F28" stroke="#FFF6E8" stroke-width="2.5"/>'
      + '<circle r="4" fill="#FFF6E8"/>'
      + '<text x="0" y="4" text-anchor="middle" font-size="10" font-weight="700" fill="#FFF6E8">'
      + (focus >= 0 ? (focus + 1) : '·') + '</text>'
      + '<text x="0" y="-26" text-anchor="middle" font-size="12.5" font-weight="700" fill="#6E161D" '
      + 'paint-order="stroke" stroke="#FBF6EC" stroke-width="4">' + esc(n.name) + '</text>'
      + '<text x="0" y="34" text-anchor="middle" font-size="10" fill="#8C1F28" '
      + 'paint-order="stroke" stroke="#FBF6EC" stroke-width="3">' + esc(n.date_label || '') + '</text>'
      + '</g>';
    svg += '</svg>';

    var head = '<div class="story-head">'
      + '<div><div class="story-eyebrow">长征贵州段 · 事件动画 · 预展版 · 待第二人复核</div>'
      + '<h2 id="rgStoryTitle">' + esc(n.name) + ' · 事件动画</h2></div>'
      + '<button type="button" class="story-x" data-story-close aria-label="关闭动画">✕</button>'
      + '</div>';

    var intro = '<div class="story-intro" aria-hidden="true">'
      + '<div class="si-kicker">' + esc(n.date_label || '') + '</div>'
      + '<div class="si-title">' + esc(n.name) + '</div>'
      + '<div class="si-sub">' + esc(n.place || '') + ' · 按审定经过播放 · 约 '
      + Math.round(state.total / 1000) + ' 秒</div>'
      + '</div>';

    var rail = '<div class="ev-rail" aria-hidden="true">';
    state.beats.forEach(function (bt, i) {
      rail += '<span class="ev-rl' + (i === 0 ? ' on' : '') + '"><i></i>' + esc(bt.tag) + '</span>';
    });
    rail += '</div>';

    var cap = '<div class="story-cap">'
      + '<div class="cap-top"><span class="cap-date" id="rgStoryDate">' + esc(n.date_label || '—') + '</span>'
      + '<span class="cap-tag" id="rgStoryTag">事件动画</span></div>'
      + '<div class="cap-name" id="rgStoryName">' + esc(n.name) + '</div>'
      + '<div class="cap-place" id="rgStoryPlace">' + esc(n.place || '—') + '</div>'
      + '<p class="cap-sum" id="rgStorySum" aria-live="polite">'
      + esc(summary(n.summary || '')) + '</p>'
      + '<div class="cap-src" id="rgStorySrc"></div>'
      + '</div>';

    var foot = '<div class="story-foot">'
      + '<div class="story-progress"><span id="rgStoryBar"></span></div>'
      + '<div class="story-ctrls">'
      + '<button type="button" class="story-btn" id="rgStorySound" aria-label="关闭语音" aria-pressed="true">'
      + '<span class="ic">🔊</span><span class="tx">声音开</span></button>'
      + '<button type="button" class="story-btn" id="rgStoryPlay" aria-label="暂停">'
      + '<span class="ic">❚❚</span><span class="tx">暂停</span></button>'
      + '<button type="button" class="story-btn" id="rgStoryReplay" aria-label="重播">'
      + '<span class="ic">↻</span><span class="tx">重播</span></button>'
      + '<span class="story-time" id="rgStoryTime">00:00 / '
      + fmt(state.total) + '</span>'
      + '<span class="story-note">文案取自审定事件条目 · 语音由浏览器合成，非历史录音</span>'
      + '</div></div>';

    var ov = document.createElement('div');
    ov.className = 'rg-story-ov ev';
    ov.id = 'rgStory';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'rgStoryTitle');

    ov.innerHTML = '<div class="story-box ev-box' + (state.reduced ? ' reduced' : '') + '">'
      + head + '<div class="story-stage">' + svg + intro + rail + '</div>' + cap + foot + '</div>';
    document.body.appendChild(ov);
    document.body.classList.add('rg-story-open');
    return ov;
  }

  function fmt(ms) {
    var s = Math.max(0, Math.min(state.total, Math.round(ms / 1000)));
    var m = Math.floor(s / 60), r = s % 60;
    return (m < 10 ? '0' + m : m) + ':' + (r < 10 ? '0' + r : r);
  }

  function setStep(idx) {
    if (idx === state.step) return;
    state.step = idx;
    var box = $('rgStory');
    if (!box) return;
    box.setAttribute('data-step', String(idx));

    var dots = box.querySelectorAll('.story-dot');
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('on', i === idx);
      dots[i].classList.toggle('past', i < idx);
    }

    var n = state.nodes[idx];
    if (!n) return;
    var ch = chapterOf(n.id);
    $('rgStoryDate').textContent = n.date_label || '—';
    $('rgStoryName').textContent = n.name || '—';
    $('rgStoryPlace').textContent = n.place || '—';
    $('rgStoryTag').textContent = ch
      ? ('第' + cnNum(ch.order) + '章 · ' + (ch.title || ''))
      : '总库事件 · 不属于五章主题展';
    $('rgStorySum').textContent = summary(n.summary || (n.facts && n.facts[0] && n.facts[0].text) || '');
    var src = (n.source_ids || []);
    $('rgStorySrc').textContent = src.length ? ('来源 ' + src.join(' · ')) : '';
    syncEvBtn();
    if (state.playing) narrate(overviewLine(n), STEP / 1000 - 0.5);
  }

  function render() {
    if (state.mode === 'event') return renderEvent();
    var box = $('rgStory');
    if (!box) return;
    var t = state.elapsed;
    var idx = -1;
    var progress = 0;
    var phase = 'intro';

    if (t >= INTRO && t < INTRO + STEP * state.nodes.length) {
      phase = 'play';
      var local = t - INTRO;
      idx = Math.floor(local / STEP);
      var within = (local % STEP) / STEP;
      progress = (idx + within) / Math.max(state.nodes.length, 1);
      setStep(idx);
    } else if (t >= INTRO + STEP * state.nodes.length) {
      phase = 'outro';
      progress = 1;
      setStep(state.nodes.length - 1);
    } else {
      setStep(-1);
    }

    box.setAttribute('data-phase', phase);
    if (idx < 0 && phase === 'intro') {
      $('rgStoryDate').textContent = '1934.10 — 1935.03';
      $('rgStoryName').textContent = '长征贵州段 9 个核心事件';
      $('rgStoryPlace').textContent = '按事件顺序播放';
      $('rgStoryTag').textContent = '五十秒纵览';
      $('rgStorySum').textContent = '从困牛山战斗到苟坝会议，按平台审定的事件顺序串联。';
      $('rgStorySrc').textContent = '';
    }
    var bar = $('rgStoryBar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, progress * 100)) + '%';
    var time = $('rgStoryTime');
    if (time) time.textContent = fmt(t) + ' / ' + fmt(state.total);

    if (state.pathEl) {
      state.pathEl.style.strokeDashoffset = state.pathLen * (1 - progress);
      state.pathEl.style.opacity = progress > 0 ? '1' : '0';
    }
  }

  function setBeat(idx) {
    if (idx === state.step) return;
    state.step = idx;
    var box = $('rgStory');
    var bt = state.beats[idx];
    if (!box || !bt) return;
    box.setAttribute('data-beat', String(idx));
    var rls = box.querySelectorAll('.ev-rl');
    for (var i = 0; i < rls.length; i++) {
      rls[i].classList.toggle('on', i === idx);
      rls[i].classList.toggle('past', i < idx);
    }
    var n = state.evNode || {};
    $('rgStoryDate').textContent = n.date_label || '—';
    $('rgStoryTag').textContent = bt.tag;
    $('rgStoryName').textContent = bt.title;
    $('rgStoryPlace').textContent = n.place || '—';
    $('rgStorySum').textContent = bt.text;
    $('rgStorySrc').textContent = bt.src ? ('来源 ' + bt.src) : '';
    if (state.playing) {
      var span = (state.beatSpans[idx] || 5000) / 1000;
      narrate(beatLine(bt, n), span - 0.35);
    }
  }

  // 纵览里“当前事件”可直接跳到该事件的单事件动画
  function syncEvBtn() {
    var btn = $('rgStoryEvBtn');
    if (!btn) return;
    var n = state.nodes[state.step];
    if (!n) {
      btn.disabled = true;
      btn.removeAttribute('data-event-id');
      btn.setAttribute('aria-label', '播放当前事件动画');
      return;
    }
    btn.disabled = false;
    btn.setAttribute('data-event-id', n.id);
    btn.setAttribute('aria-label', '播放' + (n.name || '') + '事件动画');
  }

  function renderEvent() {
    var box = $('rgStory');
    if (!box || !state.evNode) return;
    var t = state.elapsed;
    var phase = 'intro';
    var idx = -1;
    if (t >= EV_INTRO + state.bodyMs) {
      phase = 'outro';
      idx = state.beats.length - 1;
    } else if (t >= EV_INTRO) {
      phase = 'play';
      var local = t - EV_INTRO, acc = 0;
      idx = state.beats.length - 1;
      for (var i = 0; i < state.beatSpans.length; i++) {
        if (local < acc + state.beatSpans[i]) { idx = i; break; }
        acc += state.beatSpans[i];
      }
    }
    box.setAttribute('data-phase', phase);

    if (idx >= 0) {
      setBeat(idx);
    } else {
      var n = state.evNode;
      $('rgStoryDate').textContent = n.date_label || '—';
      $('rgStoryTag').textContent = '事件动画';
      $('rgStoryName').textContent = n.name || '—';
      $('rgStoryPlace').textContent = n.place || '—';
      $('rgStorySum').textContent = summary(n.summary || '');
      $('rgStorySrc').textContent = (n.source_ids || []).length
        ? ('来源 ' + (n.source_ids || []).join(' · ')) : '';
    }

    var progress = Math.max(0, Math.min(1, t / state.total));
    var bar = $('rgStoryBar');
    if (bar) bar.style.width = (progress * 100) + '%';
    var time = $('rgStoryTime');
    if (time) time.textContent = fmt(t) + ' / ' + fmt(state.total);
  }

  function tick(ts) {
    if (!state.playing) return;
    if (!state.lastTs) state.lastTs = ts;
    state.elapsed += Math.max(0, ts - state.lastTs);
    state.lastTs = ts;
    if (state.elapsed >= state.total) {
      state.elapsed = state.total;
      render();
      pause();
      return;
    }
    render();
    state.raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!state.open) return;
    if (state.elapsed >= state.total) state.elapsed = 0;
    state.playing = true;
    state.lastTs = 0;
    var btn = $('rgStoryPlay');
    if (btn) {
      btn.querySelector('.ic').textContent = '❚❚';
      btn.querySelector('.tx').textContent = '暂停';
      btn.setAttribute('aria-label', '暂停');
    }
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(tick);
    syncSoundBtn();
    narrateCurrent();
  }

  function pause() {
    state.playing = false;
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.lastTs = 0;
    stopVoice();
    var btn = $('rgStoryPlay');
    if (btn) {
      btn.querySelector('.ic').textContent = '▶';
      btn.querySelector('.tx').textContent = '播放';
      btn.setAttribute('aria-label', '播放');
    }
  }

  function replay() {
    state.elapsed = 0;
    state.step = -1;
    render();
    play();
  }

  function open() {
    if (state.open) return;
    var nodes = sortedNodes();
    if (!nodes.length) {
      if (b().setView) b().setView('topic');
      return;
    }
    state.mode = 'overview';
    state.evNode = null;
    state.beats = [];
    state.beatSpans = [];
    state.total = TOTAL;
    state.open = true;
    state.lastFocus = document.activeElement;
    state.nodes = nodes;
    state.elapsed = 0;
    state.step = -1;
    build();
    render();
    bind();
    play();
    setTimeout(function () {
      var x = document.querySelector('#rgStory [data-story-close]');
      if (x) x.focus();
    }, 30);
  }

  function findNode(id) {
    var arr = sortedNodes();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) return arr[i];
    }
    var raw = (data().nodes || {}).nodes || [];
    for (var j = 0; j < raw.length; j++) {
      if (raw[j].id === id) return raw[j];
    }
    return null;
  }

  // 单事件动画：只讲经过，时长按文案长度计算，保证每句读完。
  function openEvent(id) {
    var n = findNode(id);
    if (!n) return;
    if (state.open && state.mode === 'event' && state.evNode && state.evNode.id === n.id) return;
    if (state.open) close();
    state.mode = 'event';
    state.evNode = n;
    state.beats = eventBeats(n);
    state.beatSpans = layoutBeats(n);
    state.bodyMs = state.beatSpans.reduce(function (a, c) { return a + c; }, 0);
    state.total = EV_INTRO + state.bodyMs + EV_OUTRO;
    state.open = true;
    state.lastFocus = document.activeElement;
    state.elapsed = 0;
    state.step = -1;
    buildEvent(n);
    render();
    bind();
    play();
    setTimeout(function () {
      var x = document.querySelector('#rgStory [data-story-close]');
      if (x) x.focus();
    }, 30);
  }

  function close() {
    if (!state.open) return;
    pause();
    stopVoice();
    state.open = false;
    var box = $('rgStory');
    if (box && box.parentNode) box.parentNode.removeChild(box);
    document.body.classList.remove('rg-story-open');
    if (state.lastFocus && state.lastFocus.focus) {
      try { state.lastFocus.focus(); } catch (e) { /* 忽略 */ }
    }
    state.lastFocus = null;
  }

  function bind() {
    var ov = $('rgStory');
    if (!ov) return;
    ov.addEventListener('click', function (ev) {
      // 点纵览里的任一事件点位，直接播该事件动画
      var dot = ev.target.closest ? ev.target.closest('[data-story-ev]') : null;
      if (dot && state.mode === 'overview') {
        ev.preventDefault();
        ev.stopPropagation();
        openEvent(dot.getAttribute('data-story-ev'));
        return;
      }
      if (ev.target === ov) close();
      var el = ev.target.closest ? ev.target.closest('[data-story-close]') : null;
      if (el) close();
    });
    var evBtn = $('rgStoryEvBtn');
    if (evBtn) evBtn.addEventListener('click', function () {
      if (evBtn.disabled) return;
      var id = evBtn.getAttribute('data-event-id');
      if (id) openEvent(id);
    });
    ov.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var dot = ev.target.closest ? ev.target.closest('[data-story-ev]') : null;
      if (!dot) return;
      ev.preventDefault();
      ev.stopPropagation();
      openEvent(dot.getAttribute('data-story-ev'));
    });
    var playBtn = $('rgStoryPlay');
    if (playBtn) playBtn.addEventListener('click', function () {
      if (state.playing) pause(); else play();
    });
    var sndBtn = $('rgStorySound');
    if (sndBtn) sndBtn.addEventListener('click', function () {
      if (!sndBtn.disabled) setSound(!state.sound);
    });
    var replayBtn = $('rgStoryReplay');
    if (replayBtn) replayBtn.addEventListener('click', replay);
    syncSoundBtn();
    // 点击进度条跳转（按当前动画总时长）
    var prog = ov.querySelector('.story-progress');
    if (prog) prog.addEventListener('click', function (ev) {
      var r = prog.getBoundingClientRect();
      if (!r.width) return;
      var p = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      state.elapsed = p * state.total;
      state.step = -1;
      // render() 里的 setStep 会按新位置重新朗读，这里不要再读一遍
      render();
    });
  }

  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented) return;
    var el = ev.target.closest
      ? ev.target.closest('[data-ex-story],[data-ev-story],[data-ex-evstory]') : null;
    if (!el) return;
    ev.preventDefault();
    var nid = el.getAttribute('data-ev-story') || el.getAttribute('data-ex-evstory');
    if (nid) openEvent(nid); else open();
  });

  document.addEventListener('keydown', function (ev) {
    if (!state.open) return;
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    else if (ev.key === ' ' && !/INPUT|TEXTAREA|SELECT/.test((ev.target && ev.target.tagName) || '')) {
      ev.preventDefault();
      if (state.playing) pause(); else play();
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.open && state.playing) pause();
  });

  window.RgStory = {
    open: open,
    openEvent: openEvent,
    close: close,
    isOpen: function () { return state.open; },
    // 供回归测试核对“只报时间与事件名称”的朗读文案
    textForStep: function (i) { return overviewLine(state.nodes[i]); },
    info: function () {
      return {
        mode: state.mode,
        eventId: state.evNode ? state.evNode.id : null,
        total: state.total,
        steps: state.mode === 'event' ? state.beats.length : (state.nodes.length || 9),
        step: state.step,
        playing: state.playing,
        sound: state.sound,
        elapsed: state.elapsed
      };
    }
  };
})();
