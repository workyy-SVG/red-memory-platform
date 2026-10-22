/* ============================================================================
 * rg-graph.js —— 红色记忆平台 · 知识图谱可视化模块
 * ----------------------------------------------------------------------------
 * 设计取舍：
 *   市面常见做法是引入 ECharts / D3 等第三方库绘制关系图。本模块刻意不引入
 *   任何外部库，而是自绘 canvas 力导向图，原因是：
 *     1. 断网可用 —— 评审现场网络不可控，CDN 加载失败会导致核心功能全失；
 *     2. 零依赖 —— 整个平台只需一个 HTML + 两个 JS，复制即可运行；
 *     3. 布局算法完全可控，便于按"红色史实"的语义定制力场参数。
 *
 * 具备能力：
 *   · 力导向布局（斥力 + 边弹簧 + 向心力），预先迭代收敛
 *   · 六类实体按类型着色、按度数决定半径
 *   · 悬停高亮邻接子图，非邻接元素淡出
 *   · 点击实体 → 回调（用于与地图 / 详情面板联动）
 *   · 滚轮缩放、拖拽平移、拖拽实体手动微调位置
 *   · 类型开关过滤、关键词搜索定位
 * ========================================================================== */
(function () {
  'use strict';

  var TYPE_STYLE = {
    node:   { color: '#8C1F28', label: '平台节点', r: 17 },
    event:  { color: '#CD792D', label: '事件',     r: 14 },
    person: { color: '#2E6FA8', label: '人物',     r: 12 },
    place:  { color: '#1F6F5C', label: '地点/遗址', r: 11 },
    doc:    { color: '#7A5BA6', label: '文献',     r: 10 },
    org:    { color: '#8A6A2F', label: '机构',     r: 10 },
    image:  { color: '#6B7A8F', label: '影像',     r: 10 }
  };

  var G = {
    canvas: null,
    ctx: null,
    entities: [],
    relations: [],
    byId: {},
    adj: {},
    W: 0, H: 0, dpr: 1,
    scale: 1, ox: 0, oy: 0,
    hover: null,
    selected: null,
    focusSet: null,      // 聚焦模式的可见集合（id -> 'core' | 'hop'）
    dragNode: null,
    panning: false,
    lastMouse: null,
    visibleTypes: {},
    onPick: null,
    laidOut: false,
    bound: false,
    onResize: null
  };


  // Display policy is independent of the source graph: no historical edges are inferred.
  function visible(e) {
    return !!G.visibleTypes[e.type] && (G.mode === 'main' ? e.type === 'node'
      : G.mode === 'focus' ? !!(G.focusSet && G.focusSet[e.id]) : true);
  }
  function mainNodes() {
    // The curated source order also handles date ranges such as 四渡赤水.
    return G.entities.filter(function(e){return e.type === 'node';});
  }
  function narrativeLayout() {
    var nodes=mainNodes(), narrow=G.W < 620;
    nodes.forEach(function(e,i){e.gx=narrow ? 450 : 90+i*90;
      e.gy=narrow ? 55+i*90 : 280+(i%2)*65;});
    G.laidOut=true;
  }
  function fitVisible() {
    var set={};G.entities.forEach(function(e){if(visible(e))set[e.id]=true;});
    fitToFocus(set);
  }
  function updateNarrativeUI() {
    var bar=document.getElementById('rgGraphViews');if(!bar)return;
    Array.prototype.forEach.call(bar.querySelectorAll('[data-graph-view]'),function(b){
      b.setAttribute('aria-pressed',String(b.dataset.graphView===G.mode));
    });
    var status=bar.querySelector('[role="status"]');
    var count=G.entities.filter(visible).length;
    status.textContent=(G.mode==='main'?'主线':G.mode==='focus'?'聚焦':'全图')+' · '+count+' 个实体；勾选类型参与显示。红色箭头表示已有时序关系，橙色为包含，蓝色为参与/指挥，绿色为发生于。';
    var list=document.getElementById('rgGraphNodeList');list.textContent='';
    (G.mode==='main'?mainNodes():G.entities.filter(visible)).forEach(function(e){
      var b=document.createElement('button');b.type='button';b.className='btn xs';
      b.textContent=e.name;b.onclick=function(){pickNarrative(e);};list.appendChild(b);
    });
    list.style.display=G.W<620?'flex':'none';
  }
  function stopStory(){if(G.storyTimer)clearInterval(G.storyTimer);G.storyTimer=null;}
  function viewMode(mode,approved) {
    stopStory();
    if(mode==='main' && !mainNodes().length)mode='focus';
    if(mode==='all'){
      if(window.innerWidth<760){mode='focus';}
      else if(!approved && !window.confirm('全图包含 '+G.entities.length+' 个实体，关系较密。是否放大进入探索？'))return;
      else {
        var wrap=document.getElementById('gWrap');if(wrap)wrap.classList.add('expanded');
        var scrim=document.getElementById('gScrim');if(scrim)scrim.classList.add('show');
        var full=document.getElementById('gFull');if(full)full.textContent='退出放大';
      }
    }
    G.mode=mode;
    if(mode==='focus')return focusSubgraph(G.selected || (mainNodes()[0]||G.entities[0]||{}).id,2);
    G.focusSet=null;G.hover=null;
    if(mode==='main')narrativeLayout();else layout(180);
    resize();fitVisible();draw();updateNarrativeUI();
  }
  function pickNarrative(e){
    stopStory();G.selected=e.id;
    if(G.onPick)G.onPick(e);
    focusSubgraph(e.id,2);
  }
  function installNarrativeUI(){
    if(document.getElementById('rgGraphViews'))return;
    var bar=document.createElement('div');bar.id='rgGraphViews';
    bar.style.cssText='padding:10px;display:flex;gap:7px;flex-wrap:wrap;background:#fff9ef';
    [['main','主线'],['focus','聚焦'],['all','全图探索']].forEach(function(pair){
      var b=document.createElement('button');b.type='button';b.className='btn xs';
      b.dataset.graphView=pair[0];b.textContent=pair[1];b.onclick=function(){viewMode(pair[0]);};bar.appendChild(b);
    });
    var play=document.createElement('button');play.type='button';play.className='btn xs';play.textContent='播放叙事主线';
    play.onclick=function(){
      if(G.storyTimer){stopStory();return;}
      viewMode('main');var nodes=mainNodes(),i=0;
      function next(){if(i>=nodes.length){stopStory();return;}var e=nodes[i++];
        G.selected=e.id;if(G.onPick)G.onPick(e);G.mode='main';G.focusSet=null;narrativeLayout();fitVisible();draw();updateNarrativeUI();}
      next();G.storyTimer=setInterval(next,1600);
    };bar.appendChild(play);
    var status=document.createElement('span');status.setAttribute('role','status');status.style.cssText='width:100%;font-size:12px;color:#735c49';bar.appendChild(status);
    G.canvas.parentNode.parentNode.insertBefore(bar,G.canvas.parentNode);
    var list=document.createElement('div');list.id='rgGraphNodeList';list.setAttribute('aria-label','图谱实体列表');
    list.style.cssText='gap:6px;flex-wrap:wrap;max-height:180px;overflow:auto;padding:8px';
    bar.appendChild(list);
    ['gAll','gReset'].forEach(function(id){var b=document.getElementById(id);if(b)b.addEventListener('click',function(ev){ev.stopImmediatePropagation();viewMode('main');},true);});
    document.addEventListener('click',function(ev){var b=ev.target.closest && ev.target.closest('#gFull,#gScrim');
      if(b && G.mode==='all')setTimeout(function(){var w=document.getElementById('gWrap');if(w&&!w.classList.contains('expanded'))viewMode('main');},80);
    });
  }

  // ------------------------------------------------------------ 力导向布局
  function layout(iterations) {
    var n = G.entities.length;
    if (!n) return;
    var W = 900, H = 640;
    var k = Math.sqrt((W * H) / n) * 0.85;

    // 初始：按类型分层环形分布，避免完全随机导致收敛慢
    var groups = {};
    G.entities.forEach(function (e, i) {
      var g = e.type;
      groups[g] = groups[g] || [];
      groups[g].push(e);
    });
    var gi = 0, groupCount = Object.keys(groups).length;
    Object.keys(groups).forEach(function (g) {
      var arr = groups[g];
      var baseR = 120 + gi * 55;
      arr.forEach(function (e, j) {
        var a = (j / Math.max(arr.length, 1)) * Math.PI * 2 + gi * 0.6;
        e.x = W / 2 + Math.cos(a) * baseR + (Math.random() - 0.5) * 20;
        e.y = H / 2 + Math.sin(a) * baseR * 0.72 + (Math.random() - 0.5) * 20;
      });
      gi++;
    });

    var edges = G.relations.map(function (r) {
      return { s: G.byId[r.head], t: G.byId[r.tail], w: (r.relation === '时序衔接' || r.relation === '包含事件') ? 1.4 : 1 };
    }).filter(function (e) { return e.s && e.t; });

    for (var it = 0; it < iterations; it++) {
      var temp = 24 * (1 - it / iterations) + 0.6;

      // 斥力（全对，一次遍历内对称累加，避免重复计数）
      for (var i = 0; i < n; i++) {
        G.entities[i]._dx = 0;
        G.entities[i]._dy = 0;
      }
      for (var ia = 0; ia < n; ia++) {
        var a = G.entities[ia];
        for (var jb = ia + 1; jb < n; jb++) {
          var b = G.entities[jb];
          var dx = a.x - b.x, dy = a.y - b.y;
          var d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 0.01; }
          var d = Math.sqrt(d2);
          var rep = (k * k) / d;
          var ux = dx / d, uy = dy / d;
          a._dx += ux * rep; a._dy += uy * rep;
          b._dx -= ux * rep; b._dy -= uy * rep;
        }
      }

      // 边弹簧
      edges.forEach(function (e) {
        var dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var f = (d * d) / (k * e.w);
        var ux = dx / d, uy = dy / d;
        e.s._dx += ux * f * 0.02; e.s._dy += uy * f * 0.02;
        e.t._dx -= ux * f * 0.02; e.t._dy -= uy * f * 0.02;
      });

      // 向心 + 位移限制
      G.entities.forEach(function (e) {
        e._dx += (W / 2 - e.x) * 0.012;
        e._dy += (H / 2 - e.y) * 0.012;
        var d = Math.sqrt(e._dx * e._dx + e._dy * e._dy) || 0.01;
        var lim = Math.min(d, temp);
        e.x += (e._dx / d) * lim;
        e.y += (e._dy / d) * lim;
      });
    }

    // 归一化到画布坐标并留白
    var xs = G.entities.map(function (e) { return e.x; });
    var ys = G.entities.map(function (e) { return e.y; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var sx = (W - 160) / Math.max(maxX - minX, 1);
    var sy = (H - 120) / Math.max(maxY - minY, 1);
    var s = Math.min(sx, sy);
    G.entities.forEach(function (e) {
      e.gx = (e.x - minX) * s + 80;
      e.gy = (e.y - minY) * s + 60;
    });
    G.laidOut = true;
  }

  // ------------------------------------------------------------ 绘制
  function radiusOf(e) {
    var st = TYPE_STYLE[e.type] || TYPE_STYLE.event;
    // 只做部分补偿：全量图谱在侧栏里约缩到 0.45 倍，
    // 完全按 1/scale 放大会让圆点在布局坐标里互相挤占、糊成一团；
    // 取 0.35 次方，既让圆点在小视图下仍有 8px 左右，又保留间距。
    var inv = 1 / Math.min(G.scale || 1, 1);
    return st.r * Math.pow(inv, 0.35);
  }

  function degreeOf(e) {
    return Object.keys(G.adj[e.id] || {}).length;
  }

  function isDim(e) {
    if (!G.visibleTypes[e.type]) return true;
    // 聚焦模式：只保留焦点实体及其一跳邻居，其余淡出
    if (G.focusSet) return !G.focusSet[e.id];
    if (G.hover) {
      if (e.id === G.hover) return false;
      return !(G.adj[G.hover] || {})[e.id];
    }
    return false;
  }

  /** 标签降噪：全图只给"枢纽实体 + 关键类型"常显标签，其余按缩放显示 */
  function shouldShowLabel(e, dim) {
    if (!visible(e) || dim) return false;
    if (e.id === G.hover || e.id === G.selected) return true;
    // 悬停时把该实体的一跳邻居一并标名，便于顺着关系读图
    if (G.hover) return true;
    if (G.focusSet) return !!G.focusSet[e.id];   // 聚焦时只标焦点及其核心
    var deg = degreeOf(e);
    // 全量图谱在侧栏里空间有限，默认只标枢纽实体；
    // 放大后逐步放出更多标签，避免 196 个名字糊成一片。
    // 人物—事件模式只有 122 个实体，可比全图多放出一些标签
    var dense = G.entities.length > 160;
    if (e.type === 'node') return true;
    if (e.type === 'event') return G.scale > 0.85 || deg >= (dense ? 10 : 5);
    if (e.type === 'person' || e.type === 'place') {
      return G.scale > 0.95 || deg >= (dense ? 8 : 6);
    }
    if (e.type === 'doc' || e.type === 'org') return G.scale > 1.1 || deg >= 5;
    return G.scale > 1.2 || deg >= 3;
  }

  function draw() {
    var ctx = G.ctx;
    if (!ctx) return;
    var W = G.W, H = G.H;

    ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.translate(G.ox, G.oy);
    ctx.scale(G.scale, G.scale);

    var T = { x: -G.ox / G.scale, y: -G.oy / G.scale };
    var S = null;
    // 视图缩小时补偿线宽与字号，保证屏幕上的可读性。
    var inv = 1 / Math.min(G.scale || 1, 1);

    // 边
    G.relations.forEach(function (r) {
      var a = G.byId[r.head], b = G.byId[r.tail];
      if (!a || !b) return;
      if (!visible(a) || !visible(b)) return;
      if ((r.relation === '关联' || r.relation === '关联条目') && a.id !== G.hover && b.id !== G.hover && a.id !== G.selected && b.id !== G.selected) return;

      var dim = false;
      if (G.hover) {
        var involved = (a.id === G.hover || b.id === G.hover);
        dim = !involved;
      } else if (G.selected) {
        dim = !(a.id === G.selected || b.id === G.selected);
      }
      if (dim) {
        ctx.strokeStyle = 'rgba(140,31,40,0.07)';
        ctx.lineWidth = 0.6 * inv;
      } else if (r.relation === '时序衔接') {
        ctx.strokeStyle = 'rgba(140,31,40,0.72)';
        ctx.lineWidth = 2.1 * inv;
      } else {
        ctx.strokeStyle = r.relation === '包含事件' ? '#CD792D' : /参与|指挥/.test(r.relation) ? '#2E6FA8' : r.relation === '发生于' ? '#1F6F5C' : 'rgba(90,70,60,0.22)';
        ctx.lineWidth = 1.0 * inv;
      }

      ctx.beginPath();
      ctx.moveTo(a.gx, a.gy);
      ctx.lineTo(b.gx, b.gy);
      ctx.stroke();

      // 时序方向箭头
      if (r.relation === '时序衔接' && !dim) {
        var mx = (a.gx + b.gx) / 2, my = (a.gy + b.gy) / 2;
        var ang = Math.atan2(b.gy - a.gy, b.gx - a.gx);
        var rr = radiusOf(b) + 4;
        var ax = b.gx - Math.cos(ang) * rr, ay = b.gy - Math.sin(ang) * rr;
        ctx.fillStyle = 'rgba(140,31,40,0.85)';
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(ang - 0.42) * 9, ay - Math.sin(ang - 0.42) * 9);
        ctx.lineTo(ax - Math.cos(ang + 0.42) * 9, ay - Math.sin(ang + 0.42) * 9);
        ctx.closePath();
        ctx.fill();
      }
    });

    // 实体：类型被关闭时直接不画，避免留下一层灰点仍显得拥挤
    G.entities.forEach(function (e) {
      if (!visible(e)) return;
      var st = TYPE_STYLE[e.type] || TYPE_STYLE.event;
      var r = radiusOf(e);
      var dim = isDim(e);

      ctx.globalAlpha = dim ? 0.16 : 1;

      if (e.id === G.selected || e.id === G.hover) {
        ctx.beginPath();
        ctx.arc(e.gx, e.gy, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(140,31,40,0.14)';
        ctx.fill();
      }

      ctx.beginPath();
      if(e.type==='node'){ctx.moveTo(e.gx,e.gy-r);ctx.lineTo(e.gx+r,e.gy);ctx.lineTo(e.gx,e.gy+r);ctx.lineTo(e.gx-r,e.gy);ctx.closePath();}
      else ctx.arc(e.gx, e.gy, r, 0, Math.PI * 2);
      ctx.fillStyle = st.color;
      ctx.fill();
      ctx.lineWidth = 2 * inv;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // 标签单独一层：按连接数从高到低绘制，重叠时让位。
    // 这样既不会把 196 个标签糊成一片，又能优先看到事件、人物和地点。
    var labels = G.entities.filter(function (e) {
      return shouldShowLabel(e, isDim(e));
    }).sort(function (a, c) {
      return degreeOf(c) - degreeOf(a);
    });
    var placed = [];
    labels.forEach(function (e) {
      var r = radiusOf(e);
      var base = (e.type === 'node') ? 13 : 12;
      var fs = base * inv;
      ctx.font = (e.type === 'node' ? '600 ' : '') + fs.toFixed(2)
        + 'px "Microsoft YaHei","PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      var maxLen = G.focusSet ? 12 : 11;
      var label = e.name.length > maxLen ? e.name.slice(0, maxLen) + '…' : e.name;
      var tw = ctx.measureText(label).width;
      var pad = 3 * inv;
      var lh = 15 * inv;
      var lx = e.gx - tw / 2 - pad;
      var ly = e.gy + r + 3 * inv;
      var sx = G.ox + lx * G.scale;
      var sy = G.oy + ly * G.scale;
      var sw = (tw + pad * 2) * G.scale;
      var sh = lh * G.scale;
      for (var i = 0; i < placed.length; i++) {
        var q = placed[i];
        if (sx < q.x + q.w && sx + sw > q.x && sy < q.y + q.h && sy + sh > q.y) return;
      }
      placed.push({ x: sx, y: sy, w: sw, h: sh });
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillRect(lx, ly, tw + pad * 2, lh);
      ctx.fillStyle = e.type === 'node' ? '#7A1A22' : '#40372F';
      ctx.fillText(label, e.gx, ly + 1.5 * inv);
    });

    ctx.restore();
  }

  // ------------------------------------------------------------ 命中测试
  function hitTest(mx, my) {
    var x = (mx - G.ox) / G.scale;
    var y = (my - G.oy) / G.scale;
    var best = null, bestD = Infinity;
    G.entities.forEach(function (e) {
      if (!visible(e)) return;
      var dx = e.gx - x, dy = e.gy - y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d <= radiusOf(e) + 5 && d < bestD) { best = e; bestD = d; }
    });
    return best;
  }

  // ------------------------------------------------------------ 事件绑定
  function bind() {
    if (G.bound) return;       // 同一 canvas 重复 init 时不叠加事件
    G.bound = true;
    var c = G.canvas;

    c.addEventListener('mousemove', function (ev) {
      var rect = c.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;

      if (G.dragNode) {
        G.dragNode.gx = (mx - G.ox) / G.scale;
        G.dragNode.gy = (my - G.oy) / G.scale;
        draw();
        return;
      }
      if (G.panning && G.lastMouse) {
        G.ox += mx - G.lastMouse.x;
        G.oy += my - G.lastMouse.y;
        G.lastMouse = { x: mx, y: my };
        draw();
        return;
      }
      var hit = hitTest(mx, my);
      var id = hit ? hit.id : null;
      if (id !== G.hover) {
        G.hover = id;
        c.style.cursor = hit ? 'pointer' : 'grab';
        draw();
        if (window.RgOnGraphHover) window.RgOnGraphHover(hit);
      }
    });

    c.addEventListener('mousedown', function (ev) {
      var rect = c.getBoundingClientRect();
      var hit = hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
      if (hit) {
        G.dragNode = hit;
        G.selected = hit.id;
        pickNarrative(hit);
      } else {
        G.panning = true;
        G.lastMouse = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        c.style.cursor = 'grabbing';
      }
      draw();
    });

    window.addEventListener('mouseup', function () {
      G.dragNode = null;
      G.panning = false;
      if (G.canvas) G.canvas.style.cursor = 'grab';
    });

    c.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var rect = c.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      var before = { x: (mx - G.ox) / G.scale, y: (my - G.oy) / G.scale };
      var factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      G.scale = Math.max(0.2, Math.min(3.2, G.scale * factor));
      G.ox = mx - before.x * G.scale;
      G.oy = my - before.y * G.scale;
      draw();
    }, { passive: false });

    c.addEventListener('touchend',function(ev){if(!ev.changedTouches.length)return;var t=ev.changedTouches[0],rect=c.getBoundingClientRect();var hit=hitTest(t.clientX-rect.left,t.clientY-rect.top);if(hit){ev.preventDefault();pickNarrative(hit);}}, {passive:false});
    c.addEventListener('dblclick', function () { resetView(); });
  }

  function resize() {
    if (!G.canvas) return;
    var box = G.canvas.parentNode.getBoundingClientRect();
    G.dpr = window.devicePixelRatio || 1;
    G.W = Math.max(200, box.width);
    G.H = Math.max(200, box.height);
    G.canvas.width = G.W * G.dpr;
    G.canvas.height = G.H * G.dpr;
    G.canvas.style.width = G.W + 'px';
    G.canvas.style.height = G.H + 'px';
    if(G.mode==='all' && window.innerWidth<760){G.mode='main';G.focusSet=null;}
    if(G.mode==='main')narrativeLayout();
    if (G.laidOut) {fitVisible();draw();updateNarrativeUI();}
  }

  function centerView() {
    // 把布局坐标（以 900x640 为画布）映射到当前视口
    var bx = 900, by = 640;
    var s = Math.min((G.W - 40) / bx, (G.H - 40) / by);
    // 侧栏较窄时不把整张图压到 0.3 以下；宁可超出画布让用户拖拽，
    // 也要保证圆点和标签在屏幕上可读。
    G.scale = Math.max(0.45, Math.min(1.6, s));
    G.ox = (G.W - bx * G.scale) / 2;
    G.oy = (G.H - by * G.scale) / 2;
  }

  function resetView() {
    fitVisible();
    draw();
  }

  // ------------------------------------------------------------ 对外
  function init(canvasId, kg, onPick) {
    G.canvas = document.getElementById(canvasId);
    if (!G.canvas) return false;
    G.ctx = G.canvas.getContext('2d');
    G.onPick = onPick || null;

    if (!kg || !kg.entities) return false;
    G.entities = kg.entities.map(function (e) {
      return Object.assign({}, e);
    });
    G.relations = kg.relations || [];
    G.byId = {};
    G.entities.forEach(function (e) { G.byId[e.id] = e; });
    G.relations=G.relations.filter(function(r){return G.byId[r.head] && G.byId[r.tail];});

    // 邻接表
    G.adj = {};
    G.relations.forEach(function (r) {
      (G.adj[r.head] = G.adj[r.head] || {})[r.tail] = r.relation;
      (G.adj[r.tail] = G.adj[r.tail] || {})[r.head] = r.relation;
    });

    G.visibleTypes = {};
    Object.keys(TYPE_STYLE).forEach(function (t) {
      // 全量 196 个实体在侧栏里过于拥挤；默认先显示事件/人物/地点，
      // 文献与机构由用户按需勾选，关系边会随之自动过滤。
      G.visibleTypes[t] = (t !== 'image' && t !== 'org');
    });
    G.hover = null;
    G.selected = null;
    G.focusSet = null;
    G.dragNode = null;
    G.panning = false;
    G.lastMouse = null;
    G.laidOut = false;

    stopStory();G.mode='main';
    if(mainNodes().length)narrativeLayout();else {G.mode='all';layout(180);}
    installNarrativeUI();
    resize();
    fitVisible();
    draw();updateNarrativeUI();
    bind();
    if (!G.onResize) G.onResize = function () { resize(); draw(); };
    window.removeEventListener('resize', G.onResize);
    window.addEventListener('resize', G.onResize);
    if(!mainNodes().length && G.entities.length)focusSubgraph(G.entities[0].id,1);
    return true;
  }

  function setTypeVisible(type, on) {
    G.visibleTypes[type] = !!on;
    fitVisible();draw();updateNarrativeUI();
  }

  /**
   * 聚焦模式：只保留某实体的关系子图（焦点 + depth 跳邻居），其余淡出。
   * 196 个实体的全图确实难读，这是"看懂一个专题"最有效的入口。
   */
  function focusSubgraph(id, depth) {
    if (!G.byId[id]) { clearFocus(); return 0; }
    var d = (depth == null) ? 1 : depth;
    var set = {};
    set[id] = 'core';
    var frontier = [id];
    for (var step = 0; step < d; step++) {
      var next = [];
      frontier.forEach(function (nid) {
        var nb = G.adj[nid] || {};
        Object.keys(nb).forEach(function (mid) {
          if (/^关联/.test(nb[mid])) return;
          if (!set[mid]) { set[mid] = 'hop'; next.push(mid); }
        });
      });
      frontier = next;
      if (!next.length) break;
    }
    // Generic media links remain available in the evidence detail, not in the default focus rings.

    G.mode='focus';
    G.focusSet = set;
    G.visibleTypes[G.byId[id].type]=true;
    var rings=[[],[]];
    Object.keys(set).forEach(function(mid){if(mid===id)return;var e=G.byId[mid];rings[e.type==='event'?0:1].push(e);});
    G.byId[id].gx=450;G.byId[id].gy=320;
    rings.forEach(function(arr,ring){arr.sort(function(a,b){return a.name.localeCompare(b.name);});arr.forEach(function(e,i){var a=i/arr.length*Math.PI*2;var r=ring?270:140;e.gx=450+Math.cos(a)*r;e.gy=320+Math.sin(a)*r;});});
    G.selected = id;
    G.hover = null;
    fitToFocus(set);
    draw();updateNarrativeUI();
    return Object.keys(set).length;
  }

  /** 把聚焦范围内的实体缩放平移到画布中央，避免子图缩在一角 */
  function fitToFocus(set) {
    var xs = [], ys = [];
    G.entities.forEach(function (e) {
      if (!set[e.id]) return;
      xs.push(e.gx); ys.push(e.gy);
    });
    if (!xs.length) return;
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var pad = 70;
    var s = Math.min((G.W - pad * 2) / Math.max(maxX - minX, 1),
                     (G.H - pad * 2) / Math.max(maxY - minY, 1));
    // 上限 1.0：标签字号是按布局坐标画的，放大过多会变成巨大文字反而看不清
    G.scale = Math.max(0.15, Math.min(1.0, s));
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    G.ox = G.W / 2 - cx * G.scale;
    G.oy = G.H / 2 - cy * G.scale;
  }

  function clearFocus() { if(G.mode==='focus')viewMode('main'); }

  function focusByKeyword(kw) {
    if (!kw) { G.selected = null; G.hover = null; draw(); return null; }
    var k = kw.trim();
    var found = G.entities.filter(function (e) {
      return e.name.indexOf(k) >= 0;
    });
    if (!found.length) return null;
    // 优先精确匹配、再优先节点/事件
    found.sort(function (a, b) {
      var sa = (a.name === k ? 2 : 0) + (a.type === 'node' ? 1 : 0);
      var sb = (b.name === k ? 2 : 0) + (b.type === 'node' ? 1 : 0);
      return sb - sa;
    });
    var e = found[0];
    G.selected = e.id;
    G.hover = e.id;
    focusSubgraph(e.id,2);
    // 平移到该实体
    G.ox = G.W / 2 - e.gx * G.scale;
    G.oy = G.H / 2 - e.gy * G.scale;
    draw();
    return e;
  }

  function stats() {
    return {
      entities: G.entities.length,
      relations: G.relations.length,
      byType: G.entities.reduce(function (m, e) {
        m[e.type] = (m[e.type] || 0) + 1; return m;
      }, {})
    };
  }

  window.RgGraph = {
    init: init,
    setViewMode: viewMode,
    visibleEntities: function(){return G.entities.filter(visible).map(function(e){return e.id;});},
    currentView: function(){return G.mode;},
    draw: draw,
    resize: resize,
    resetView: resetView,
    setTypeVisible: setTypeVisible,
    focusByKeyword: focusByKeyword,
    focusSubgraph: focusSubgraph,
    clearFocus: clearFocus,
    stats: stats,
    TYPE_STYLE: TYPE_STYLE
  };
})();
