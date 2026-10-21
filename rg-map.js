/* ============================================================================
 * rg-map.js —— 红色记忆平台 · GIS 时空地图模块
 * ----------------------------------------------------------------------------
 * 职责：
 *   1. 高德地图底图（普通图 / 卫星影像切换）
 *   2. 长征贵州段节点落点（按事件类型着色、按序号编号）
 *   3. 行军路径动画（按时间顺序连线 + 逐段推进动画）
 *   4. 研学路线的真实路径规划（驾车 / 骑行 / 步行 三种方式）
 *   5. 遗址 / 纪念馆点位聚合
 *   6. 未配置密钥时提示并显示点位示意（不再使用免费瓦片底图）
 *
 * 设计说明：
 *   本模块为独立 IIFE，不依赖任何前端框架；对外只暴露 window.RgMap。
 *   密钥可写在 rg-map-config.js，也可由用户在工具栏保存到浏览器 localStorage；
 *   本模块不上传任何密钥。未配置高德 Key 时不发起任何第三方地图请求。
 * ========================================================================== */
(function () {
  'use strict';

  var KEY_LS = 'rg_amap_key';
  var SEC_LS = 'rg_amap_sec';

  var MODE_META = {
    driving: { label: '驾车', color: '#8C1F28', speed: 60 },
    riding:  { label: '骑行', color: '#1F6F5C', speed: 14 },
    walking: { label: '步行', color: '#B57A1B', speed: 4.5 }
  };

  var TYPE_META = {
    core: { color: '#8C1F28', label: '重大转折', r: 15 },
    sub:  { color: '#A9542F', label: '重要事件', r: 12 }
  };

  // 总库点位（遗址 / 博物馆纪念馆）配色
  var PLACE_META = {
    site:   { color: '#B3483F', label: '革命遗址',     r: 7 },
    museum: { color: '#C08A2E', label: '博物馆·纪念馆', r: 7 }
  };

  var state = {
    key: '',
    sec: '',
    map: null,
    AMap: null,
    markers: [],
    placeMarkers: [],
    routeLines: [],
    marchLine: null,
    marchTimer: null,
    mode: 'driving',
    satellite: false,
    nodes: [],
    nodeById: {},
    infoWin: null,
    lastNodes: null,
    lastPlaces: [],
    clusterOn: false,
    cluster: null,
    clusterMarkers: []
  };

  // ---------------------------------------------------------------- 工具
  function $(id) { return document.getElementById(id); }

  function getKey() {
    try {
      state.key = localStorage.getItem(KEY_LS) || (window.RG_AMAP_KEY || '').trim();
      state.sec = localStorage.getItem(SEC_LS) || (window.RG_AMAP_SEC || '').trim();
    } catch (e) {
      // 隐私模式下 localStorage 可能不可用，仍允许使用配置文件
      state.key = (window.RG_AMAP_KEY || '').trim();
      state.sec = (window.RG_AMAP_SEC || '').trim();
    }
    return state.key;
  }

  function getSec() {
    getKey();
    return state.sec;
  }

  function setKey(k, s) {
    state.key = (k || '').trim();
    state.sec = (s || '').trim();
    try {
      localStorage.setItem(KEY_LS, state.key);
      localStorage.setItem(SEC_LS, state.sec);
    } catch (e) { /* 忽略 */ }
  }

  function fmtDist(m) {
    if (m == null || isNaN(m)) return '—';
    if (m < 1000) return Math.round(m) + ' 米';
    return (m / 1000).toFixed(1) + ' 公里';
  }

  function fmtDur(sec) {
    if (sec == null || isNaN(sec)) return '—';
    var m = Math.round(sec / 60);
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }

  // ---------------------------------------------------------------- 加载 SDK
  function ensureSdk(cb) {
    if (window.AMap && window.AMap.Map) { state.AMap = window.AMap; cb(null); return; }
    if (!state.key) { cb('nokey'); return; }

    if (state.sec) {
      window._AMapSecurityConfig = { securityJsCode: state.sec };
    }
    var old = document.getElementById('rg-amap-sdk');
    if (old) { old.parentNode.removeChild(old); }

    var s = document.createElement('script');
    s.id = 'rg-amap-sdk';
    s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(state.key)
      + '&plugin=AMap.MarkerCluster';
    s.onerror = function () { cb('sdkfail'); };
    s.onload = function () {
      if (window.AMap && window.AMap.Map) { state.AMap = window.AMap; cb(null); }
      else cb('sdkinvalid');
    };
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- 初始化
  function init(containerId) {
    var el = $(containerId);
    if (!el) return;
    if (!getKey()) {
      // 用户要求只使用高德底图：未配置 Key 时不加载任何免费瓦片，
      // 页面会通过 ready() 为假自动切到经纬度点位示意。
      state.backend = 'none';
      notify('nokey');
      return;
    }
    state.backend = 'amap';

    ensureSdk(function (err) {
      if (err) { notify(err); return; }

      var A = state.AMap;
      state.map = new A.Map(containerId, {
        zoom: 7.4,
        center: [106.85, 27.35],
        viewMode: '2D',
        mapStyle: 'amap://styles/whitesmoke',
        features: ['bg', 'road', 'building', 'point']
      });

      state.infoWin = new A.InfoWindow({
        offset: new A.Pixel(0, -18),
        isCustom: false
      });

      notify('ok');
      if (state.lastNodes) { renderNodes(state.lastNodes); }
      if (state.lastPlaces && state.lastPlaces.length) { renderPlaces(state.lastPlaces); }
    });
  }

  // ---------------------------------------------------------------- 提示
  function notify(code, extra) {
    var box = $('mapTip');
    if (!box) return;
    var html = '';
    if (code === 'ok') {
      box.style.display = 'none';
      return;
    }
    if (code === 'nokey') {
      html = '<b>尚未配置高德地图 Key</b><br>'
        + '请填写 <code>rg-map-config.js</code>，或点「配置地图密钥」填入 Web端(JS API) Key 与安全密钥。'
        + '<br><span style="opacity:.72">未配置时不加载任何免费瓦片，仅显示经纬度点位示意；史实、证据、图谱与 AI 讲解不受影响。</span>';
    } else if (code === 'clusterfail') {
      html = '<b>遗址聚合暂不可用</b><br>高德聚合插件未能加载，已改回普通点位显示；地图其他功能不受影响。';
    } else if (code === 'sdkfail') {
      html = '<b>地图脚本加载失败</b><br>请检查网络连接（高德地图 SDK 需要联网加载），或稍后重试。';
    } else if (code === 'sdkinvalid') {
      html = '<b>地图密钥无效</b><br>请确认高德 Key 类型为「Web端(JS API)」，并已正确配置安全密钥。';
    } else {
      html = '<b>地图初始化异常</b>' + (extra ? '<br>' + extra : '');
    }
    box.innerHTML = html;
    box.style.display = 'block';
  }

  // ---------------------------------------------------------------- 总库点位渲染
  /**
   * 渲染总库中的地理点位（革命遗址 / 博物馆纪念馆）。
   * 与 renderNodes 分开管理标记，两类图层可独立开关，互不影响。
   * @param {Array} places [{id, name, cat, lng, lat, place}]
   */
  function renderPlaces(places) {
    state.lastPlaces = places || [];
    if (!state.map) return;
    if (state.clusterOn) return renderPlacesCluster(state.lastPlaces);
    destroyCluster();
    var A = state.AMap;

    state.placeMarkers.forEach(function (m) { m.setMap(null); });
    state.placeMarkers = [];

    state.lastPlaces.forEach(function (p) {
      if (p.lng == null || p.lat == null || !p.lng || !p.lat) return;
      var meta = PLACE_META[p.cat] || PLACE_META.site;
      var r = meta.r;
      var content = '<div class="rg-dot" style="width:' + (r * 2) + 'px;height:' + (r * 2)
        + 'px;background:' + meta.color + ';"></div>';

      var mk = new A.Marker({
        position: [p.lng, p.lat],
        content: content,
        offset: new A.Pixel(-r, -r),
        zIndex: 40,
        title: (meta.label || '') + '：' + (p.name || '')
      });
      mk.on('click', function () {
        if (window.RgOnPlaceClick) window.RgOnPlaceClick(p.id, p.cat);
      });
      mk.setMap(state.map);
      state.placeMarkers.push(mk);
    });

    if (state.placeMarkers.length || state.markers.length) {
      setTimeout(function () {
        state.map.setFitView(null, false, [60, 60, 60, 60]);
      }, 120);
    }
  }

  function destroyCluster() {
    if (state.cluster) {
      try { state.cluster.setMap(null); } catch (e) { /* 插件版本差异 */ }
      try { if (state.cluster.setData) state.cluster.setData([]); } catch (e) { /* 忽略 */ }
      state.cluster = null;
    }
    state.clusterMarkers = [];
  }

  /**
   * 聚合渲染：26 处遗址 + 32 家场馆。
   * 高德 MarkerCluster 负责聚合与散开；单点点击仍打开总库详情。
   */
  function renderPlacesCluster(places) {
    var A = state.AMap;
    if (!A || !A.MarkerCluster) {
      state.clusterOn = false;
      notify('clusterfail');
      return renderPlaces(places);
    }

    state.placeMarkers.forEach(function (m) { m.setMap(null); });
    state.placeMarkers = [];
    destroyCluster();

    var markers = [];
    (places || []).forEach(function (p) {
      if (p.lng == null || p.lat == null || !p.lng || !p.lat) return;
      var meta = PLACE_META[p.cat] || PLACE_META.site;
      var r = meta.r;
      var content = '<div class="rg-dot" style="width:' + (r * 2) + 'px;height:' + (r * 2)
        + 'px;background:' + meta.color + ';"></div>';
      var mk = new A.Marker({
        position: [p.lng, p.lat],
        content: content,
        offset: new A.Pixel(-r, -r),
        zIndex: 40,
        title: (meta.label || '') + '：' + (p.name || '')
      });
      mk.on('click', function () {
        if (window.RgOnPlaceClick) window.RgOnPlaceClick(p.id, p.cat);
      });
      markers.push(mk);
    });

    if (!markers.length) return;
    state.clusterMarkers = markers;

    try {
      state.cluster = new A.MarkerCluster(state.map, markers, {
        gridSize: 60,
        maxZoom: 16,
        renderClusterMarker: function (context) {
          var count = context.count || 0;
          var size = count >= 20 ? 54 : (count >= 10 ? 46 : 38);
          context.marker.setContent(
            '<div class="rg-cluster" style="width:' + size + 'px;height:' + size
            + 'px;line-height:' + size + 'px;">' + count + '</div>'
          );
          context.marker.setOffset(new A.Pixel(-size / 2, -size / 2));
        }
      });
    } catch (e) {
      state.cluster = null;
      state.clusterOn = false;
      notify('clusterfail');
      return renderPlaces(places);
    }

    setTimeout(function () {
      if (state.map && state.clusterMarkers.length) {
        state.map.setFitView(state.clusterMarkers, false, [60, 60, 60, 60]);
      }
    }, 160);
  }

  function clearPlaces() {
    destroyCluster();
    state.placeMarkers.forEach(function (m) { m.setMap(null); });
    state.placeMarkers = [];
    state.lastPlaces = [];
  }

  // ---------------------------------------------------------------- 节点渲染
  function renderNodes(nodes) {
    state.lastNodes = nodes || [];
    if (!state.map) return;
    var A = state.AMap;

    state.markers.forEach(function (m) { m.setMap(null); });
    state.markers = [];

    state.nodes = state.lastNodes.slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0);
    });
    state.nodeById = {};
    state.nodes.forEach(function (n) { state.nodeById[n.id] = n; });

    state.nodes.forEach(function (n, i) {
      var meta = TYPE_META[n.level] || TYPE_META.sub;
      var size = meta.r;
      var content = '<div class="rg-mk" style="width:' + (size * 2) + 'px;height:' + (size * 2) + 'px;'
        + 'background:' + meta.color + ';border-color:#fff;">'
        + '<span>' + (n.order || (i + 1)) + '</span></div>';

      var mk = new A.Marker({
        position: [n.lng, n.lat],
        content: content,
        offset: new A.Pixel(-size, -size),
        zIndex: 100 + (n.order || i),
        title: n.name
      });
      mk.on('click', function () {
        focusNode(n.id);
        if (window.RgOnNodeClick) window.RgOnNodeClick(n.id);
      });
      mk.setMap(state.map);
      state.markers.push(mk);
    });

    // 自适应视野
    if (state.nodes.length) {
      var pts = state.nodes.map(function (n) { return [n.lng, n.lat]; });
      state.map.setFitView(null, false, [60, 60, 60, 60]);
      setTimeout(function () { state.map.setFitView(null, false, [60, 60, 60, 60]); }, 320);
    }
  }

  // ---------------------------------------------------------------- 行军路径动画
  function clearMarch() {
    if (state.marchTimer) { clearInterval(state.marchTimer); state.marchTimer = null; }
    state.routeLines.forEach(function (l) { l.setMap(null); });
    state.routeLines = [];
    if (state.marchLine) { state.marchLine.setMap(null); state.marchLine = null; }
  }

  /**
   * 按时间顺序绘制行军路径。
   * @param {Array} nodes 已按 order 排序的节点
   * @param {Object} opt { animate: true, upto: index, speed: 每段毫秒, onStep, onDone }
   */
  function drawMarch(nodes, opt) {
    if (!state.map) return;
    opt = opt || {};
    var A = state.AMap;
    var list = (nodes || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

    state.routeLines.forEach(function (l) { l.setMap(null); });
    state.routeLines = [];
    if (state.marchTimer) { clearInterval(state.marchTimer); state.marchTimer = null; }

    var path = list.map(function (n) { return [n.lng, n.lat]; });
    if (path.length < 2) return;

    // 底层虚线（虚线表现"行军路径"的意象，与真实路网区分开）
    var base = new A.Polyline({
      path: path,
      strokeColor: '#8C1F28',
      strokeWeight: 3,
      strokeOpacity: 0.30,
      strokeStyle: 'dashed',
      lineJoin: 'round',
      zIndex: 60
    });
    base.setMap(state.map);
    state.routeLines.push(base);

    // 推进动画线
    var upto = (opt.upto == null) ? path.length : opt.upto;
    var animPath = path.slice(0, Math.max(2, upto));

    if (opt.animate === false) {
      var solid = new A.Polyline({
        path: animPath, strokeColor: '#8C1F28', strokeWeight: 4,
        strokeOpacity: 0.9, lineJoin: 'round', zIndex: 61
      });
      solid.setMap(state.map);
      state.routeLines.push(solid);
      if (opt.onDone) opt.onDone();
      return;
    }

    // 逐段点亮：默认每段 900ms（原为 200ms，一秒就跑完，看不清行军顺序）
    var cur = 2;
    var seg = new A.Polyline({
      path: animPath.slice(0, 2), strokeColor: '#B33A2B', strokeWeight: 4.5,
      strokeOpacity: 0.95, lineJoin: 'round', zIndex: 62
    });
    seg.setMap(state.map);
    state.routeLines.push(seg);

    // 当前推进位置的小圆点，视觉上像"行军当前位置"
    var head = new A.CircleMarker({
      position: animPath[1], radius: 7, strokeColor: '#fff', strokeWeight: 2,
      fillColor: '#B33A2B', fillOpacity: 0.95, zIndex: 70
    });
    head.setMap(state.map);
    state.routeLines.push(head);
    if (opt.onStep) opt.onStep(2, list[1]);

    var per = Math.max(120, Number(opt.speed) || 900);
    state.marchTimer = setInterval(function () {
      cur++;
      if (cur > animPath.length) {
        clearInterval(state.marchTimer);
        state.marchTimer = null;
        if (opt.onDone) opt.onDone();
        return;
      }
      seg.setPath(animPath.slice(0, cur));
      head.setPosition(animPath[cur - 1]);
      if (opt.onStep) opt.onStep(cur, list[cur - 1]);
    }, per);
  }

  // ---------------------------------------------------------------- 聚焦
  function focusNode(id) {
    if (!state.map) return;
    var n = state.nodeById[id];
    if (!n) return;
    state.map.setZoomAndCenter(11.5, [n.lng, n.lat], false, 420);
    var html = '<div class="rg-iw">'
      + '<div class="rg-iw-h">' + n.name + '</div>'
      + '<div class="rg-iw-d">' + (n.date_label || '') + '</div>'
      + '<div class="rg-iw-p">' + (n.place || '') + '</div>'
      + '</div>';
    state.infoWin.setContent(html);
    state.infoWin.open(state.map, [n.lng, n.lat]);
  }

  function closeInfo() {
    if (state.infoWin && state.map) state.infoWin.close();
  }

  // ---------------------------------------------------------------- 真实路径规划
  function clearRoute() {
    state.routeLines.forEach(function (l) { l.setMap(null); });
    state.routeLines = [];
  }

  function planSegment(A, from, to, mode, cb) {
    var svc;
    if (mode === 'riding') svc = new A.Riding({ policy: 1 });
    else if (mode === 'walking') svc = new A.Walking({});
    else svc = new A.Driving({ policy: 0, extensions: 'base' });

    var done = false;
    var finish = function (res) { if (!done) { done = true; cb(res); } };

    try {
      svc.search(new A.LngLat(from.lng, from.lat), new A.LngLat(to.lng, to.lat),
        function (status, result) {
          if (status === 'complete' && result && result.routes && result.routes.length) {
            finish({ ok: true, raw: result });
          } else {
            finish({ ok: false, reason: (result && result.info) || status });
          }
        });
    } catch (e) {
      finish({ ok: false, reason: String(e) });
    }
    setTimeout(function () { finish({ ok: false, reason: 'timeout' }); }, 9000);
  }

  function straightFallback(A, from, to, mode, cb) {
    var dx = from.lng - to.lng, dy = from.lat - to.lat;
    var dist = Math.sqrt(dx * dx + dy * dy) * 111000;   // 粗略换算
    var speed = (MODE_META[mode] || MODE_META.driving).speed;
    cb({
      ok: true, fallback: true,
      distance: dist, duration: dist / (speed * 1000 / 3600),
      path: [[from.lng, from.lat], [to.lng, to.lat]]
    });
  }

  /**
   * 渲染一条研学路线（真实路网）。
   * @param {Object} route routes.json 中的一条
   * @param {Array} stepDone 每段完成后回调 (index, meta)
   */
  function renderRoute(route, onEach) {
    if (!state.map) return;
    var A = state.AMap;
    clearRoute();

    var legs = route.legs || [];
    var byId = state.nodeById;
    var metas = [];

    legs.forEach(function (leg, i) {
      var from = byId[leg.from], to = byId[leg.to];
      if (!from || !to) return;
      var mode = state.modeOverride || leg.mode || state.mode;
      var meta = MODE_META[mode] || MODE_META.driving;

      planSegment(A, from, to, mode, function (res) {
        var line, dist, dur, fb = false;
        if (res.ok && !res.fallback) {
          var r = res.raw.routes[0];
          var path = [];
          (r.steps || []).forEach(function (st) {
            (st.path || []).forEach(function (p) { path.push([p.lng, p.lat]); });
          });
          if (!path.length && r.path) path = r.path.map(function (p) { return [p.lng, p.lat]; });
          dist = r.distance; dur = r.time;
          line = new A.Polyline({
            path: path, strokeColor: meta.color, strokeWeight: 5,
            strokeOpacity: 0.85, lineJoin: 'round', zIndex: 70
          });
        } else {
          fb = true;
          straightFallback(A, from, to, mode, function (f) {
            dist = f.distance; dur = f.duration;
            line = new A.Polyline({
              path: f.path, strokeColor: meta.color, strokeWeight: 3,
              strokeOpacity: 0.7, strokeStyle: 'dashed', zIndex: 70
            });
            line.setMap(state.map);
            state.routeLines.push(line);
            pushMeta(i, from, to, mode, dist, dur, fb, leg.note);
          });
          return;
        }
        line.setMap(state.map);
        state.routeLines.push(line);
        pushMeta(i, from, to, mode, dist, dur, fb, leg.note);
      });
    });

    function pushMeta(i, from, to, mode, dist, dur, fb, note) {
      metas[i] = {
        index: i, from: from.name, to: to.name, mode: mode,
        modeLabel: (MODE_META[mode] || {}).label || mode,
        color: (MODE_META[mode] || {}).color || '#8C1F28',
        distance: dist, duration: dur, fallback: !!fb, note: note || '',
        distText: fmtDist(dist), durText: fmtDur(dur)
      };
      if (onEach) onEach(i, metas[i]);
      var list = metas.filter(Boolean);
      if (window.OnRgRouteUpdate) window.OnRgRouteUpdate(list);
    }
  }

  // ---------------------------------------------------------------- 模式与卫星
  function switchMode(mode) {
    state.mode = mode;
    // 用户在工具栏选定的交通方式应作用于整条路线各段，
    // 否则点「步行」还是按 routes.json 里写死的 driving 规划，看着像没反应。
    state.modeOverride = mode;
    if (window.RgOnModeChange) window.RgOnModeChange(mode);
  }

  function toggleSatellite(on) {
    if (!state.map) return false;
    state.satellite = (on == null) ? !state.satellite : !!on;
    if (state.satellite) {
      if (!state._sat) state._sat = new state.AMap.TileLayer.Satellite({ zIndex: 5 });
      state.map.add(state._sat);
    } else if (state._sat) {
      state.map.remove(state._sat);
    }
    return state.satellite;
  }

  // ---------------------------------------------------------------- 聚合 / 尺寸
  function setPlaceCluster(on) {
    if (!state.map || state.backend !== 'amap') return false;
    var want = !!on;
    if (want && (!state.AMap || !state.AMap.MarkerCluster)) {
      notify('clusterfail');
      return false;
    }
    state.clusterOn = want;
    renderPlaces(state.lastPlaces);
    return true;
  }

  function resize() {
    if (state.map && typeof state.map.resize === 'function') {
      try { state.map.resize(); } catch (e) { /* 部分版本无此方法 */ }
    }
  }

  // ---------------------------------------------------------------- 对外接口
  window.RgMap = {
    init: init,
    notify: notify,
    setKey: setKey,
    getKey: getKey,
    getSec: getSec,
    hasKey: function () { return !!getKey(); },
    ready: function () { return !!state.map; },
    renderNodes: renderNodes,
    renderPlaces: renderPlaces,
    clearPlaces: clearPlaces,
    setPlaceCluster: setPlaceCluster,
    resize: resize,
    drawMarch: drawMarch,
    clearMarch: clearMarch,
    clearRoute: clearRoute,
    focusNode: focusNode,
    closeInfo: closeInfo,
    renderRoute: renderRoute,
    switchMode: switchMode,
    currentMode: function () { return state.mode; },
    toggleSatellite: toggleSatellite,
    MODE_META: MODE_META,
    TYPE_META: TYPE_META,
    fmtDist: fmtDist,
    fmtDur: fmtDur
  };
})();
