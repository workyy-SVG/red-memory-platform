/* rg-offline-ai.js —— 离线检索式 AI 讲解（引擎 A 的前端实现）
 *
 * 与后端 red_ai.py 的检索口径保持一致，供 GitHub Pages 等纯静态部署使用。
 * 数据取自 index.html 内嵌的 <script id="rgEmbeddedData" type="application/json">。
 *
 * 只实现「引擎 A（规则检索）」：检索命中则直接由审定史料拼装答案、附出处；
 * 未命中则明确回答「现有史料未载此内容」。不调用大模型，零联网、零密钥、永不幻觉。
 *
 * 暴露：window.RgOfflineAi.ask(question, chapterId, nodeId) -> 与后端 /api/ai/ask 同构的响应
 */
(function () {
  'use strict';

  var HIT_THRESHOLD = 12.0;
  var REGISTERED_Q_SIM = 0.36;
  var USABLE_TIERS = { A: 1, B: 1, C: 1 };
  var GENERIC_TERMS = {
    '红军': 1, '贵州': 1, '长征': 1, '中央': 1, '中国': 1, '革命': 1, '烈士': 1,
    '遗址': 1, '纪念馆': 1, '会议': 1, '战斗': 1, '会址': 1, '什么': 1, '怎么': 1,
    '哪些': 1, '多少': 1, '介绍': 1, '故事': 1, '历史': 1, '时间': 1, '地点': 1,
    '人物': 1, '事件': 1, '意义': 1, '作用': 1, '情况': 1, '经过': 1
  };

  var C = null;   // 语料对象（build 后填充）

  /* ---------------- 归一化与二元组（与 red_ai.py 口径一致） ---------------- */
  function normalize(s) {
    return String(s == null ? '' : s)
      .replace(/[\s，。、；：？！“”‘’（）《》〈〉·,.!?;:"'()\[\]{}—－\-~～]+/g, '')
      .toLowerCase();
  }
  function bigrams(s) {
    s = normalize(s);
    var out = {};
    if (s.length < 2) { if (s) out[s] = 1; return out; }
    for (var i = 0; i < s.length - 1; i++) out[s.substr(i, 2)] = 1;
    return out;
  }
  function interGrams(a, b) { var o = {}; for (var g in a) if (b[g]) o[g] = 1; return o; }
  function unionGrams(a, b) { var o = {}; for (var g in a) o[g] = 1; for (var g2 in b) o[g2] = 1; return o; }
  function sumIdf(o, idf) { var s = 0; for (var g in o) s += (idf[g] != null ? idf[g] : 1.0); return s; }

  /* ---------------- 数据加载 ---------------- */
  function loadData() {
    var el = document.getElementById('rgEmbeddedData');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  function usable(sids) {
    var out = [];
    (sids || []).forEach(function (sid) {
      var s = C.sources[sid];
      if (s && USABLE_TIERS[s.tier]) out.push(sid);
    });
    return out;
  }

  /* ---------------- 语料构建（镜像 red_ai.py Corpus._build） ---------------- */
  function build(data) {
    C = {
      nodes: (data.nodes && data.nodes.nodes) || [],
      atlas_items: (data.atlas && data.atlas.items) || [],
      sources: {},
      chapters: {},
      node_by_id: {},
      passages: [],
      by_id: {},
      idf: {},
      anchors: {}
    };

    ((data.sources && data.sources.sources) || []).forEach(function (s) { C.sources[s.id] = s; });
    C.nodes.forEach(function (n) { C.node_by_id[n.id] = n; });
    ((data.exhibition && data.exhibition.chapters) || []).forEach(function (c) { if (c.id) C.chapters[c.id] = c; });

    // 1) 节点层：摘要 / 史实条目 / 问答对
    C.nodes.forEach(function (n) {
      var kw = (n.keywords || []).slice();
      kw.push(n.name);
      kw.push(n.subtitle || '');
      C.passages.push({
        id: 'node:' + n.id + ':summary', kind: 'summary',
        node_id: n.id, node_name: n.name, text: n.summary || '',
        source_ids: usable(n.source_ids), keywords: kw
      });
      (n.facts || []).forEach(function (f, i) {
        C.passages.push({
          id: 'node:' + n.id + ':fact:' + i, kind: 'fact',
          node_id: n.id, node_name: n.name, text: f.text || '',
          source_ids: usable(f.source_ids), keywords: kw
        });
      });
      (n.qa || []).forEach(function (qa, i) {
        C.passages.push({
          id: 'node:' + n.id + ':qa:' + i, kind: 'qa',
          node_id: n.id, node_name: n.name, question: qa.q, text: qa.a || '',
          source_ids: usable(qa.source_ids), keywords: kw
        });
      });
    });

    // 2) 总库层：条目摘要 + 要点片段
    C.atlas_items.forEach(function (it) {
      if (!it.name) return;
      var kw = [it.name, it.subtitle || ''].concat(it.tags || []);
      var common = {
        kind: 'atlas', cat: it.cat, item_id: it.id, node_id: it.id,
        node_name: it.name, verify: it.verify || '', keywords: kw,
        source_ids: usable(it.source_ids)
      };
      C.passages.push(Object.assign({ id: 'atlas:' + it.id + ':summary', text: it.summary || '' }, common));
      (it.points || []).forEach(function (pt, i) {
        C.passages.push(Object.assign({ id: 'atlas:' + it.id + ':point:' + i, text: pt }, common));
      });
    });

    // 3) 索引类问答（nodes.json 与 atlas.json 的 meta.index_qa）
    var idx = 0;
    [
      [((data.nodes && data.nodes.meta && data.nodes.meta.index_qa) || []), '长征贵州段'],
      [((data.atlas && data.atlas.meta && data.atlas.meta.index_qa) || []), '红色记忆总库']
    ].forEach(function (pair) {
      pair[0].forEach(function (qa) {
        C.passages.push({
          id: 'index:' + idx, kind: 'qa', node_id: '_index', node_name: '平台总览',
          question: qa.q, text: qa.a || '', source_ids: usable(qa.source_ids),
          keywords: (qa.keywords || []).concat([pair[1]])
        });
        idx++;
      });
    });

    // 4) IDF（罕见词权重大）
    var df = {};
    C.passages.forEach(function (p) {
      var tb = bigrams(p.text);
      for (var g in tb) df[g] = (df[g] || 0) + 1;
      if (p.question) {
        var qb = bigrams(p.question);
        for (var g2 in qb) df[g2] = (df[g2] || 0) + 1;
      }
    });
    var n = Math.max(C.passages.length, 1);
    C.idf = {};
    for (var g in df) C.idf[g] = Math.log((n + 1) / (df[g] + 1)) + 1.0;

    // 5) 锚点词表（节点名/关键词/人物 + 总库名称/副题/标签 + 知识图谱实体，剔除泛化词）
    var s = {};
    C.nodes.forEach(function (n) {
      s[n.name] = 1;
      (n.keywords || []).forEach(function (k) { s[k] = 1; });
      (n.people || []).forEach(function (k) { s[k] = 1; });
    });
    C.atlas_items.forEach(function (it) {
      if (it.name) s[it.name] = 1;
      if (it.subtitle) s[it.subtitle] = 1;
      (it.tags || []).forEach(function (k) { s[k] = 1; });
    });
    if (data.kg && data.kg.entities) {
      data.kg.entities.forEach(function (e) { if (e.name) s[e.name] = 1; });
    }
    C.anchors = {};
    for (var a in s) {
      var na = normalize(a);
      if (na && na.length >= 2 && !GENERIC_TERMS[na]) C.anchors[a] = 1;
    }

    // 6) 片段 id 索引
    C.passages.forEach(function (p) { if (p.id) C.by_id[p.id] = p; });

    return true;
  }

  /* ---------------- 锚点识别 ---------------- */
  function findAnchors(q) {
    var qn = normalize(q);
    var hits = [];
    for (var a in C.anchors) {
      var na = normalize(a);
      if (na && qn.indexOf(na) >= 0) hits.push(a);
    }
    hits.sort(function (x, y) { return normalize(y).length - normalize(x).length; });
    var out = [];
    for (var i = 0; i < hits.length; i++) {
      var na = normalize(hits[i]);
      var contained = false;
      for (var j = 0; j < out.length; j++) {
        if (normalize(out[j]).indexOf(na) >= 0) { contained = true; break; }
      }
      if (!contained) out.push(hits[i]);
    }
    return out;
  }

  /* ---------------- 片段打分（镜像 red_ai.py score_passage） ---------------- */
  function scorePassage(q, p, anchors, idf) {
    var qn = normalize(q);
    var qb = bigrams(q);
    var nodeNameNorm = normalize(p.node_name);
    var textNorm = normalize(p.text);

    var hitAnchor = [];
    anchors.forEach(function (a) {
      var na = normalize(a);
      if (qn.indexOf(na) < 0) return;
      var inNode = nodeNameNorm.indexOf(na) >= 0;
      var inKw = (p.keywords || []).some(function (k) { return normalize(k) === na; });
      var inText = textNorm.indexOf(na) >= 0;
      if (inNode || inKw || inText) hitAnchor.push(a);
    });
    var anchorScore = Math.min(hitAnchor.length, 3) * 9.0;

    var target = (p.kind === 'qa' && p.question) ? p.question : p.text;
    var tb = bigrams(target);
    var num = 0, denom = 0;
    if (p.kind === 'qa' && p.question) {
      num = sumIdf(interGrams(qb, tb), idf);
      denom = sumIdf(unionGrams(qb, tb), idf) || 1.0;
    } else {
      num = sumIdf(interGrams(qb, tb), idf);
      denom = sumIdf(qb, idf) || 1.0;
    }
    var jacScore = (num / denom) * 20.0;

    var nodeBonus = (nodeNameNorm && qn.indexOf(nodeNameNorm) >= 0) ? 12.0 : 0.0;
    var titleBonus = anchors.some(function (a) { return nodeNameNorm.indexOf(normalize(a)) >= 0; }) ? 10.0 : 0.0;
    var catPenalty = p.cat === 'image' ? 3.0 : 0.0;

    var focusBonus = 0.0;
    if (/(多少|几人|几个|几名|人数|共多少)/.test(qn)) {
      if (/\d[\d,]*\s*(?:余)?\s*(?:人|名|处|件|套|支|个|所|座|次|篇|条|余)/.test(p.text)) focusBonus += 9.0;
    }
    if (/(什么时候|哪一年|哪年|何时|时间|日期)/.test(qn)) {
      if (/(?:1[89]|20)\d{2}\s*年/.test(p.text)) focusBonus += 9.0;
    }

    var kindBonus = p.kind === 'qa' ? 4.0 : 0.0;

    if (!p.source_ids || !p.source_ids.length) return 0.0;

    return anchorScore + jacScore + nodeBonus + titleBonus + focusBonus + kindBonus - catPenalty;
  }

  /* ---------------- 已注册问句相似度（镜像 question_similarity） ---------------- */
  function questionSimilarity(q) {
    var qb = bigrams(q);
    var has = false;
    for (var g in qb) { has = true; break; }
    if (!has) return { sim: 0, reg: null };
    var best = 0, bestp = null;
    C.passages.forEach(function (p) {
      if (p.kind !== 'qa' || !p.question) return;
      var tb = bigrams(p.question);
      var inter = interGrams(qb, tb);
      var any = false;
      for (var g in inter) { any = true; break; }
      if (!any) return;
      var num = sumIdf(inter, C.idf);
      var denom = sumIdf(unionGrams(qb, tb), C.idf) || 1.0;
      var sim = num / denom;
      if (sim > best) { best = sim; bestp = p; }
    });
    return { sim: best, reg: bestp };
  }

  /* ---------------- 检索（镜像 retrieve：两道闸 + 打分排序） ---------------- */
  function retrieve(q, scopeNodes, anchorQ) {
    var searchQ = anchorQ || q;
    var anchors = findAnchors(searchQ);
    var sim = 0;
    if (!anchors.length) {
      var rs = questionSimilarity(searchQ);
      sim = rs.sim;
      if (!rs.reg || sim < REGISTERED_Q_SIM) return { hits: [], anchors: [], sim: sim };
      anchors = [rs.reg.node_name];
      (rs.reg.keywords || []).slice(0, 3).forEach(function (k) { if (k) anchors.push(k); });
    }
    var scored = [];
    C.passages.forEach(function (p) {
      if (scopeNodes && !scopeNodes[p.node_id]) return;
      var s = scorePassage(searchQ, p, anchors, C.idf);
      if (s > 0) scored.push({ s: s, p: p });
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    return { hits: scored.slice(0, 4), anchors: anchors, sim: sim };
  }

  /* ---------------- 引擎 A：拼装答案（镜像 engine_a） ---------------- */
  function engineA(q, scopeNodes, anchorQ) {
    var r = retrieve(q, scopeNodes, anchorQ);
    if (!r.hits.length || r.hits[0].s < HIT_THRESHOLD) {
      return { result: null, hits: r.hits, anchors: r.anchors, sim: r.sim };
    }
    var bestScore = r.hits[0].s;
    var best = r.hits[0].p;

    // 高置信度问答对 → 直接返回原答案
    if (best.kind === 'qa' && bestScore >= 10) {
      return {
        result: {
          answer: best.text, basis: [best.text],
          node_id: best.node_id, node_name: best.node_name,
          used_evidence_ids: [best.id]
        }, hits: r.hits, anchors: r.anchors, sim: r.sim
      };
    }

    // 总库条目 → 摘要 + 最相关要点（最多 3 段）
    if (best.kind === 'atlas') {
      var itemId = best.item_id;
      var own = C.passages.filter(function (p) { return p.item_id === itemId; });
      if (!own.length) own = [best];
      var summaryP = own[0];
      var scoredOwn = own.map(function (p) {
        return { s: scorePassage(q, p, r.anchors, C.idf), p: p };
      }).sort(function (a, b) { return b.s - a.s; });
      var picked = [summaryP], used = bigrams(summaryP.text);
      scoredOwn.forEach(function (x) {
        if (picked.length >= 3) return;
        if (x.p === summaryP || x.s <= 0) return;
        var tb = bigrams(x.p.text);
        var overlap = 0, total = 0;
        for (var g in tb) { total++; if (used[g]) overlap++; }
        if (total && overlap / total > 0.55) return;
        picked.push(x.p);
        for (var g2 in tb) used[g2] = 1;
      });
      var answer = picked.map(function (p) { return p.text; }).join('');
      if (answer.length > 320) {
        var cut = answer.lastIndexOf('。', 319);
        answer = cut > 120 ? answer.slice(0, cut + 1) : answer.slice(0, 320);
      }
      return {
        result: {
          answer: answer,
          basis: picked.map(function (p) { return p.text; }),
          node_id: best.node_id, item_id: itemId,
          cat: best.cat, verify: best.verify || '', node_name: best.node_name,
          used_evidence_ids: picked.map(function (p) { return p.id; })
        }, hits: r.hits, anchors: r.anchors, sim: r.sim
      };
    }

    // 节点史实拼装（最多 3 条；高置信度问答对优先）
    var nodeId = best.node_id;
    var facts = r.hits.map(function (x) { return x.p; })
      .filter(function (p) { return p.node_id === nodeId && p.kind === 'fact'; });
    if (!facts.length) {
      facts = C.passages.filter(function (p) {
        return p.node_id === nodeId && p.kind === 'fact' && (!scopeNodes || scopeNodes[p.node_id]);
      });
    }
    var selected = facts.slice(0, 3);
    if (!selected.length) selected = [best];
    var qaHit = null;
    r.hits.forEach(function (x) {
      if (!qaHit && x.p.node_id === nodeId && x.p.kind === 'qa') qaHit = x.p;
    });
    if (qaHit) selected = [qaHit];

    return {
      result: {
        answer: selected.map(function (p) { return p.text; }).join(''),
        basis: selected.map(function (p) { return p.text; }),
        node_id: nodeId, node_name: best.node_name,
        used_evidence_ids: selected.map(function (p) { return p.id; })
      }, hits: r.hits, anchors: r.anchors, sim: r.sim
    };
  }

  /* ---------------- 详情 ---------------- */
  function evidenceDetail(pid) {
    var p = C.by_id[pid];
    if (!p) return null;
    return {
      id: pid, text: p.text || '', source_ids: p.source_ids || [],
      node_id: p.node_id, node_name: p.node_name || '', kind: p.kind || ''
    };
  }
  function sourceDetail(sid) {
    var s = C.sources[sid] || {};
    return {
      id: sid, tier: s.tier || '?', title: s.title || '（来源信息缺失）',
      author: s.author || '', publisher: s.publisher || '', year: s.year || '',
      page: s.page || '', ref_no: s.ref_no || '', type: s.type || '', url: s.url || ''
    };
  }

  /* ---------------- 主入口（镜像 red_ai.py ask 的引擎 A 部分） ---------------- */
  function ask(question, chapterId, nodeId) {
    question = String(question || '').trim();
    if (!question) return { engine: 'none', answer: '请先输入您的问题。', context: {}, evidence: [], sources: [] };
    if (question.length > 200) question = question.slice(0, 200);

    var chapter = C.chapters[chapterId] || null;
    var focusId = nodeId || (chapter && chapter.primary_event_id) || null;
    var focusNode = focusId ? C.node_by_id[focusId] : null;

    var scope = null;
    if (chapter) { scope = {}; (chapter.event_ids || []).forEach(function (id) { scope[id] = 1; }); }
    else if (focusNode) { scope = {}; scope[focusNode.id] = 1; }

    var ctx = {
      chapter_id: (chapter && chapter.id) || chapterId || '',
      chapter_title: (chapter && chapter.title) || '',
      node_id: focusNode ? focusNode.id : '',
      node_name: focusNode ? focusNode.name : ''
    };

    function finish(res, evidenceIds) {
      var ids = [];
      (evidenceIds || []).forEach(function (pid) { if (pid && ids.indexOf(pid) < 0) ids.push(pid); });
      res.context = ctx;
      res.evidence = ids.slice(0, 5).map(evidenceDetail).filter(Boolean);
      return res;
    }

    // 指代不明且无上下文：先请选择
    if (!focusNode && /他|她|它|这次|该|此|这个|这里|那里/.test(question)) {
      return finish({
        engine: 'none',
        answer: '请先选择具体章节或事件，我再回答“它”指的是哪一件事。',
        sources: [],
        suggest: ['可先打开一个章节，或在提问中点明事件名称。']
      }, []);
    }

    // 地点问句：直接用当前事件的地点字段回答（零幻觉）
    if (focusNode && /在哪里|在哪|地点|位置|地址|什么地方/.test(question)) {
      var n = focusNode;
      var site = n.site || {};
      var ans = n.name + '发生在' + (n.place || '（地点待补）') + '。';
      if (site.name) ans += '相关纪念地：' + site.name + '（' + (site.status || '') + '）。';
      var sids = usable(n.source_ids);
      return finish({
        engine: 'A', answer: ans, basis: [n.summary || ''],
        node_id: n.id, node_name: n.name,
        sources: sids.map(sourceDetail)
      }, ['node:' + n.id + ':summary', 'node:' + n.id + ':fact:0']);
    }

    // 无锚点/含指代词时，用当前事件名补全检索问句
    var anchorQ = question;
    if (focusNode && (!findAnchors(question).length || /它|这次|该|此|这个|这里|那里/.test(question))) {
      anchorQ = question + ' ' + [focusNode.name].concat((focusNode.keywords || []).slice(0, 4)).join(' ');
    }

    var ea = engineA(question, scope, anchorQ);
    if (ea.result) {
      var srcIds = [];
      ea.hits.forEach(function (x) {
        if (x.s < HIT_THRESHOLD * 0.6) return;
        (x.p.source_ids || []).forEach(function (sid) { if (srcIds.indexOf(sid) < 0) srcIds.push(sid); });
      });
      return finish({
        engine: 'A', answer: ea.result.answer, basis: ea.result.basis || [],
        node_id: ea.result.node_id || ctx.node_id,
        node_name: ea.result.node_name || ctx.node_name,
        item_id: ea.result.item_id, cat: ea.result.cat, verify: ea.result.verify || '',
        sources: srcIds.map(sourceDetail)
      }, ea.result.used_evidence_ids);
    }

    // 兜底：史料未载
    var near = [];
    ea.hits.forEach(function (x) { if (near.indexOf(x.p.node_name) < 0) near.push(x.p.node_name); });
    var suggest = near.length
      ? ['本平台已收录的条目包括：' + near.slice(0, 5).join('、') + '，可尝试围绕这些内容提问。']
      : ['本平台收录长征贵州段 9 个核心节点，以及红色记忆总库 ' + C.atlas_items.length +
         ' 条资料。可尝试提问：遵义会议是什么时候召开的？邓恩铭是谁？息烽集中营是怎么回事？'];
    return finish({
      engine: 'none', answer: '现有史料未载此内容。', sources: [], suggest: suggest
    }, []);
  }

  function init() {
    var data = loadData();
    if (data) { build(data); return true; }
    return false;
  }

  window.RgOfflineAi = {
    init: init,
    ready: function () { return !!C; },
    ask: function (q, chapterId, nodeId) {
      if (!C && !init()) {
        return { engine: 'error', answer: '离线语料未加载，请刷新页面后重试。', context: {}, evidence: [], sources: [] };
      }
      return ask(q, chapterId, nodeId);
    }
  };
})();
