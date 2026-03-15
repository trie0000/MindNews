// カラーパレット（LLM が動的に決めたカテゴリに順番に割り当て）
const PALETTE = [
  '#58a6ff', '#f78166', '#ffa657', '#d2a8ff',
  '#56d364', '#e3b341', '#8b949e', '#ff7b9c',
];

const CENTER_COLOR    = '#ffffff';
const CENTER_RADIUS   = 38;
const TOPIC_RADIUS    = 22;   // 深さ1（トップカテゴリ）
const SUBTOPIC_RADIUS = 15;   // 深さ2（サブカテゴリ中間ノード）
const ARTICLE_RADIUS  = 6;    // 葉（記事）

let svg, width, height, g, zoomBehavior;
let currentData      = null;
let newArticleIdsSet = new Set(); // 今回初出の記事ID

// ---- 既読管理（localStorage） ----
const VIEWED_KEY = 'mindnews-viewed-v1';
function loadViewedIds()  { try { return new Set(JSON.parse(localStorage.getItem(VIEWED_KEY) || '[]')); } catch { return new Set(); } }
function saveViewedId(id) { try { const s = loadViewedIds(); s.add(id); localStorage.setItem(VIEWED_KEY, JSON.stringify([...s])); } catch {} }

// ノードマップ { id → node } と リスト
let allNodes = [];
let allLinks = [];
let nodeMap  = {};

// 展開状態 { nodeId: boolean }  ※ 内部ノードのみ
const expandedState = {};

// ---- エントリーポイント ----
async function init() {
  setupSVG();
  await loadNews();
}

function setupSVG() {
  const container = document.getElementById('map-container');
  width  = container.clientWidth;
  height = container.clientHeight || window.innerHeight - 60;

  svg = d3.select('#mindmap').attr('width', width).attr('height', height);

  zoomBehavior = d3.zoom()
    .scaleExtent([0.2, 4])
    .on('zoom', (e) => { g.attr('transform', e.transform); schedulePositionLabels(); });

  svg.call(zoomBehavior);
  g = svg.append('g');
}

// ---- ニュース読み込み ----
async function loadNews() {
  const loading    = document.getElementById('loading');
  const loadingMsg = document.getElementById('loading-msg');
  const errorMsg   = document.getElementById('error-msg');
  const mapCont    = document.getElementById('map-container');
  const btn        = document.getElementById('refresh-btn');

  loading.style.display  = 'flex';
  mapCont.style.display  = 'none';
  errorMsg.style.display = 'none';
  btn.disabled = true;

  try {
    const data = await fetchWithSSE((msg) => {
      if (loadingMsg) loadingMsg.textContent = msg;
    });

    if (data.error) throw new Error(data.error);
    currentData      = data;
    newArticleIdsSet = new Set(data.newArticleIds || []);
    // 既読済みのIDを新着から除外
    const viewedIds = loadViewedIds();
    viewedIds.forEach(id => newArticleIdsSet.delete(id));

    const fetchedAt = new Date(data.fetchedAt).toLocaleString('ja-JP');
    const newBadge  = newArticleIdsSet.size > 0 ? `  🆕 ${newArticleIdsSet.size}件新着` : '';
    const llmBadge  = data.llmEnabled ? '  🤖 AI生成ツリー' : '  📋 キーワードツリー';
    document.getElementById('meta').textContent =
      `取得: ${fetchedAt}  |  記事数: ${data.totalArticles}件${llmBadge}${newBadge}`;

    loading.style.display = 'none';
    mapCont.style.display = 'block';

    await new Promise(resolve => requestAnimationFrame(resolve));
    width  = mapCont.clientWidth  || window.innerWidth;
    height = mapCont.clientHeight || (window.innerHeight - 60);
    svg.attr('width', width).attr('height', height);

    g.selectAll('*').remove();
    Object.keys(expandedState).forEach(k => delete expandedState[k]);

    buildGraph(data.tree);
    renderInitial();
  } catch (err) {
    loading.style.display  = 'none';
    errorMsg.style.display = 'flex';
    errorMsg.textContent   = `取得エラー: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// SSE でデータを取得し、進捗コールバックを呼ぶ
function fetchWithSSE(onProgress) {
  return new Promise((resolve, reject) => {
    const es = new EventSource('/api/news/stream');

    es.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'progress') {
        onProgress(msg.message);
      } else if (msg.type === 'result') {
        es.close();
        resolve(msg.data);
      } else if (msg.type === 'error') {
        es.close();
        reject(new Error(msg.message));
      }
    };

    es.onerror = () => {
      es.close();
      fetch('/api/news').then(r => r.json()).then(resolve).catch(reject);
    };
  });
}

// ---- グラフ構築（ツリー → ラジアル配置） ----
function buildGraph(tree) {
  allNodes = [];
  allLinks = [];
  nodeMap  = {};

  const cx = width  / 2;
  const cy = height / 2;
  const md = Math.min(width, height);

  // 各深さのリング半径
  const RADII = [0, md * 0.24, md * 0.42, md * 0.60];

  // サブツリーの葉数（角度配分に使用）
  function countLeaves(node) {
    if (!node.children || node.children.length === 0) return 1;
    return node.children.reduce((s, c) => s + countLeaves(c), 0);
  }

  // 深さ1ノードにパレット色を割り当て、子孫に継承
  function assignColors(node, color) {
    node._color = color;
    if (node.children) node.children.forEach(c => assignColors(c, color));
  }
  if (tree.children) {
    tree.children.forEach((child, i) => assignColors(child, PALETTE[i % PALETTE.length]));
  }

  // 再帰的にノード・リンクを生成
  function processNode(node, depth, startAngle, endAngle, parentId) {
    const angle  = (startAngle + endAngle) / 2;
    const r      = RADII[Math.min(depth, RADII.length - 1)];
    const x      = cx + r * Math.cos(angle);
    const y      = cy + r * Math.sin(angle);
    const isLeaf = !node.children || node.children.length === 0;

    const type =
      depth === 0 ? 'center'
      : isLeaf    ? 'article'
      : depth === 1 ? 'topic'
      : 'subtopic';

    const nd = {
      id:         node.id,
      type,
      depth,
      x, y, angle,
      label:      node.label || node.title || '',
      shortLabel: (node.label || node.title || '').slice(0, 14),
      summary:    node.summary || '',
      url:        node.url  || null,
      color:      node._color || PALETTE[0],
      hasChildren: !isLeaf,
      parentId,
      childCount: node.children ? countLeaves(node) : 0,
      isLlm:     node.llm !== false,
      isNew:     isLeaf && newArticleIdsSet.has(node.id),
      hasNew:    false, // 後で伝播
    };

    allNodes.push(nd);
    nodeMap[nd.id] = nd;

    if (parentId !== null) {
      allLinks.push({
        id:      `lnk-${nd.id}`,
        source:  nodeMap[parentId],
        target:  nd,
        color:   nd.color,
        depth,
      });
    }

    // 内部ノードは初期状態で折りたたみ
    if (nd.hasChildren && depth > 0) {
      expandedState[nd.id] = false;
    }

    // 子ノードを再帰処理（葉数比例で角度分配）
    if (!isLeaf) {
      const totalLeaves = countLeaves(node);
      let cur = startAngle;
      for (const child of node.children) {
        const span = (endAngle - startAngle) * countLeaves(child) / totalLeaves;
        processNode(child, depth + 1, cur, cur + span, nd.id);
        cur += span;
      }
    }
  }

  const rootData = {
    id:       'center',
    label:    '今日の\nSmartNews',
    _color:   CENTER_COLOR,
    children: tree.children,
  };

  // 全周（-90° 〜 270°）をルートに割り当て
  processNode(rootData, 0, -Math.PI / 2, 3 * Math.PI / 2, null);

  // 記事ノードに兄弟内ランクを付与（テキスト上下交互配置用）
  const articlesByParent = new Map();
  allNodes.filter(n => n.type === 'article').forEach(n => {
    if (!articlesByParent.has(n.parentId)) articlesByParent.set(n.parentId, []);
    articlesByParent.get(n.parentId).push(n);
  });
  articlesByParent.forEach(siblings => {
    siblings.sort((a, b) => a.angle - b.angle); // 角度順でソート
    siblings.forEach((n, i) => { n.siblingRank = i; });
  });

  // isNew を祖先ノードへ伝播（hasNew フラグを立てる）
  allNodes.filter(n => n.isNew).forEach(n => {
    let pid = n.parentId;
    while (pid) {
      const pnd = nodeMap[pid];
      if (!pnd) break;
      pnd.hasNew = true;
      pid = pnd.parentId;
    }
  });
}

// ---- 可視性判定 ----
function isNodeVisible(nodeId) {
  const nd = nodeMap[nodeId];
  if (!nd) return false;
  if (nd.depth <= 1) return true;                    // center + topic は常時表示
  const parent = nodeMap[nd.parentId];
  if (!parent) return false;
  return !!expandedState[parent.id] && isNodeVisible(parent.id);
}

// ---- 可視性を全ノード・リンクに適用 ----

// ---- 記事ラベル同心円配置 ----
// 各ラベルを「親サブトピックノード中心の同心円」上に配置する。
// 半径 R は隣接ラベルが重ならない最小値を幾何計算で求める（斥力反復なし）。
let _labelTimer = null;
function schedulePositionLabels() {
  if (_labelTimer) clearTimeout(_labelTimer);
  _labelTimer = setTimeout(positionArticleLabels, 360);
}

function positionArticleLabels() {
  const GAP = 3; // SVG units — ラベル間の最小隙間

  // dx/dy をリセット
  document.querySelectorAll('.node.article text').forEach(el => {
    el.setAttribute('dx', '0');
    el.setAttribute('dy', '0');
  });

  // 表示中の記事ラベルのみ
  const textEls = Array.from(document.querySelectorAll('.node.article text')).filter(el => {
    const nd = el.closest('.node.article');
    return nd && parseFloat(nd.style.opacity || '0') > 0.5;
  });
  if (!textEls.length) return;

  const k = d3.zoomTransform(svg.node()).k; // zoom scale（screen px → SVG unit 変換用）

  // ラベルデータ収集（サイズは SVG unit 換算）
  const labels = textEls.map(el => {
    const nid = el.closest('.node.article').getAttribute('data-nid');
    const nd  = nodeMap[nid];
    const lr  = el.getBoundingClientRect();
    const w   = lr.width  / k;
    const h   = lr.height / k;
    return {
      el, nd,
      ax: nd.x, ay: nd.y,
      parentId: nd.parentId,
      w, h,
      halfDiag: Math.sqrt(w * w + h * h) / 2,
      lx: nd.x, ly: nd.y,  // 最終配置座標（後続で更新）
    };
  });

  // ── Phase 1: グループ内の R を幾何計算で決定 ──
  const parentGroups = new Map();
  labels.forEach(lb => {
    if (!parentGroups.has(lb.parentId)) parentGroups.set(lb.parentId, []);
    parentGroups.get(lb.parentId).push(lb);
  });

  // グループデータ: parentId → { px, py, grp, R }
  const groupData = new Map();

  parentGroups.forEach((grp, parentId) => {
    const parent = nodeMap[parentId];
    if (!parent) return;
    const px = parent.x, py = parent.y;

    grp.forEach(lb => {
      lb.angle = Math.atan2(lb.ay - py, lb.ax - px);
    });
    grp.sort((a, b) => a.angle - b.angle);

    const n = grp.length;

    // 1) ノード外周 + GAP を確保する最小 R
    let R = 0;
    grp.forEach(lb => {
      const dist = Math.sqrt((lb.ax - px) ** 2 + (lb.ay - py) ** 2);
      R = Math.max(R, dist + ARTICLE_RADIUS + GAP);
    });

    // 2) 隣接ラベルが重ならない弦長制約
    //    ただし R_CAP を超えない範囲でのみ適用（密集グループで R が爆発しないよう）
    const R_CAP_P1 = 120;
    for (let i = 0; i < n; i++) {
      const a = grp[i], b = grp[(i + 1) % n];
      let dAngle = b.angle - a.angle;
      if (dAngle <= 0) dAngle += 2 * Math.PI;
      const sinHalf = Math.sin(Math.max(dAngle, 0.05) / 2);
      const minChord = a.halfDiag + b.halfDiag + GAP;
      R = Math.max(R, minChord / (2 * sinHalf));
    }
    R = Math.min(R, R_CAP_P1); // Phase 1 での上限キャップ（必須）

    groupData.set(parentId, { px, py, grp, R });
  });

  // グループ内ラベルを現在の R で配置し lx/ly を更新するヘルパー
  // edgeOffset: ラベル矩形の「親方向の端面」を R 上に揃える補正
  function placeGroup(gd) {
    const { px, py, grp, R } = gd;
    grp.forEach(lb => {
      const cosA = Math.cos(lb.angle), sinA = Math.sin(lb.angle);
      const edgeOffset = Math.abs(cosA) * lb.w / 2 + Math.abs(sinA) * lb.h / 2;
      lb.lx = px + (R + edgeOffset) * cosA;
      lb.ly = py + (R + edgeOffset) * sinA;
    });
  }

  // 全グループを初期配置
  groupData.forEach(gd => placeGroup(gd));

  // ── Phase 2: グループ間の重なりを反復解消 ──
  // 異なるグループのラベル AABB が重なっている場合、
  // 両グループの R を拡大して再配置する。最大 10 回反復。
  const MAX_ITER = 10;
  const R_CAP = 120;
  const gdList = Array.from(groupData.values());

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let changed = false;

    for (let gi = 0; gi < gdList.length; gi++) {
      for (let gj = gi + 1; gj < gdList.length; gj++) {
        const gdA = gdList[gi], gdB = gdList[gj];

        for (const lbA of gdA.grp) {
          for (const lbB of gdB.grp) {
            // AABB 重なり判定（text-anchor="middle" なので中心が lx/ly）
            const overlapX = (lbA.w + lbB.w) / 2 + GAP - Math.abs(lbA.lx - lbB.lx);
            const overlapY = (lbA.h + lbB.h) / 2 + GAP - Math.abs(lbA.ly - lbB.ly);

            if (overlapX > 0 && overlapY > 0) {
              // 重なり量の小さい軸方向へ両グループを押し広げる
              const push = Math.min(overlapX, overlapY) / 2 + 1;
              // R を上げるのみ（下げない）
              if (gdA.R < R_CAP) gdA.R = Math.min(gdA.R + push, R_CAP);
              if (gdB.R < R_CAP) gdB.R = Math.min(gdB.R + push, R_CAP);
              placeGroup(gdA);
              placeGroup(gdB);
              changed = true;
            }
          }
        }
      }
    }

    if (!changed) break;
  }

  // ── Phase 3: dx/dy を SVG 属性に反映 ──
  groupData.forEach(gd => {
    gd.grp.forEach(lb => {
      lb.el.setAttribute('dx', (lb.lx - lb.ax).toFixed(2));
      lb.el.setAttribute('dy', (lb.ly - lb.ay).toFixed(2));
    });
  });
}

function updateVisibility() {
  allNodes.forEach(nd => {
    const el = document.querySelector(`[data-nid="${CSS.escape(nd.id)}"]`);
    if (!el) return;
    const vis = isNodeVisible(nd.id);
    el.style.transition    = 'opacity 0.3s';
    el.style.opacity       = vis ? '1' : '0';
    el.style.pointerEvents = (vis && (nd.hasChildren || nd.url)) ? 'auto' : 'none';
  });

  allLinks.forEach(lnk => {
    const el = document.querySelector(`[data-lid="${CSS.escape(lnk.id)}"]`);
    if (!el) return;
    const vis = isNodeVisible(lnk.target.id);
    el.style.transition    = 'stroke-opacity 0.3s';
    el.style.strokeOpacity = vis ? (lnk.depth === 1 ? '0.55' : '0.45') : '0';
  });

  // 表示変化後にラベル位置を再計算
  schedulePositionLabels();
}

// ---- 子孫を再帰的に折りたたむ ----
function collapseDescendants(id) {
  allNodes.filter(n => n.parentId === id && n.hasChildren).forEach(child => {
    expandedState[child.id] = false;
    collapseDescendants(child.id);
  });
}

// ---- 指定ノード以外を全て折りたたむ（アコーディオン用） ----
function collapseAllExcept(excludeId) {
  // excludeId の祖先は閉じない（親チェーンを保持）
  const ancestors = new Set();
  let pid = nodeMap[excludeId]?.parentId;
  while (pid) {
    ancestors.add(pid);
    pid = nodeMap[pid]?.parentId;
  }

  Object.keys(expandedState).forEach(id => {
    if (id !== excludeId && !ancestors.has(id) && expandedState[id]) {
      expandedState[id] = false;
      collapseDescendants(id);
    }
  });
}

// ---- 展開 / 折りたたみ ----
function toggleNode(ndData) {
  if (!ndData.hasChildren) return;

  const wasExpanded = !!expandedState[ndData.id];

  if (wasExpanded) {
    expandedState[ndData.id] = false;
    collapseDescendants(ndData.id);
  } else {
    expandedState[ndData.id] = true;
  }

  // 展開状態に応じてノード円をハイライト
  d3.selectAll('.node.topic, .node.subtopic')
    .filter(d => d.id === ndData.id)
    .select('circle')
    .style('fill',         expandedState[ndData.id] ? ndData.color + '55' : ndData.color + '30')
    .style('stroke-width', expandedState[ndData.id] ? '2.5px' : '1.5px');

  updateVisibility();
}

// ---- 新着状態を解除（リンク参照時） ----
function isDescendantOf(nodeId, ancestorId) {
  const nd = nodeMap[nodeId];
  if (!nd?.parentId) return false;
  if (nd.parentId === ancestorId) return true;
  return isDescendantOf(nd.parentId, ancestorId);
}

function markArticleViewed(articleId) {
  if (!newArticleIdsSet.has(articleId)) return;
  newArticleIdsSet.delete(articleId);
  saveViewedId(articleId);

  // 記事ノードのデータ更新 + CSSクラス削除
  const nd = nodeMap[articleId];
  if (nd) nd.isNew = false;
  document.querySelector(`[data-nid="${CSS.escape(articleId)}"]`)?.classList.remove('new-article');

  // 祖先の hasNew を再評価
  let pid = nd?.parentId;
  while (pid) {
    const pnd = nodeMap[pid];
    if (!pnd) break;
    const stillHasNew = allNodes.some(n => n.isNew && isDescendantOf(n.id, pid));
    pnd.hasNew = stillHasNew;
    const parentEl = document.querySelector(`[data-nid="${CSS.escape(pid)}"]`);
    if (parentEl && !stillHasNew) {
      parentEl.classList.remove('has-new');
      parentEl.querySelector('.new-dot')?.remove();
    }
    pid = pnd.parentId;
  }
}

// ---- 詳細パネル ----
function showDetailPanel(d) {
  const panel    = document.getElementById('detail-panel');
  const catEl    = document.getElementById('detail-category');
  const titleEl  = document.getElementById('detail-title');
  const summaryEl= document.getElementById('detail-summary');
  const linkEl   = document.getElementById('detail-link');

  // カテゴリ名: 親ノードのラベルを探す
  const parentNode = nodeMap[d.parentId];
  const grandNode  = parentNode ? nodeMap[parentNode.parentId] : null;
  const catName    = (grandNode?.label || parentNode?.label || '').slice(0, 12);

  catEl.textContent    = catName;
  catEl.style.color    = d.color;
  titleEl.textContent  = d.label || d.id;
  summaryEl.textContent= d.summary || '（要約なし）';
  linkEl.href          = d.url || '#';
  linkEl.style.display = d.url ? 'inline-block' : 'none';
  // リンクを開いたら新着解除
  linkEl.onclick = () => markArticleViewed(d.id);

  panel.classList.add('open');
}

function hideDetailPanel() {
  document.getElementById('detail-panel').classList.remove('open');
}

document.getElementById('detail-close').addEventListener('click', hideDetailPanel);

// ---- 初回描画 ----
function renderInitial() {
  const tooltip = document.getElementById('tooltip');

  // ── リンク ──
  g.selectAll('.link')
    .data(allLinks, d => d.id)
    .enter().append('path')
    .attr('class',      d => `link lnk-d${d.depth}`)
    .attr('data-lid',   d => d.id)
    .attr('d',          d => linkPath(d))
    .attr('stroke',     d => d.color)
    .attr('stroke-width', d => d.depth === 1 ? 2 : 1.5)
    .style('stroke-opacity', 0)
    .style('fill', 'none');

  // 深さ1リンクをアニメーション表示（native DOM — D3 transition は非表示タブで失速するため）
  document.querySelectorAll('.lnk-d1').forEach((el, i) => {
    setTimeout(() => {
      el.style.transition    = 'stroke-opacity 0.4s';
      el.style.strokeOpacity = '0.55';
    }, i * 80);
  });

  // ── ノード ──
  const nodeG = g.selectAll('.node')
    .data(allNodes, d => d.id)
    .enter().append('g')
    .attr('class',     d => {
      let cls = `node ${d.type}`;
      if (d.isNew)  cls += ' new-article';
      if (d.hasNew) cls += ' has-new';
      return cls;
    })
    .attr('data-nid',  d => d.id)
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .style('opacity', 0)
    .style('pointer-events', d =>
      (d.depth <= 1 && (d.hasChildren || d.url)) ? 'auto' : 'none'
    );

  // 円
  nodeG.append('circle')
    .attr('r', d => {
      if (d.type === 'center')   return CENTER_RADIUS;
      if (d.type === 'article')  return ARTICLE_RADIUS;
      if (d.type === 'topic')    return TOPIC_RADIUS;
      return SUBTOPIC_RADIUS;
    })
    .attr('fill', d => {
      if (d.type === 'center')  return '#1a2332';
      if (d.type === 'article') return d.isNew ? d.color : d.color + 'cc';
      return d.color + '30';
    })
    .attr('stroke',       d => d.type === 'center' ? CENTER_COLOR : d.color)
    .attr('stroke-width', 1.5);

  // 中央テキスト（改行対応）
  nodeG.filter(d => d.type === 'center')
    .selectAll('text')
    .data(d => d.label.split('\n'))
    .enter().append('text')
    .text(d => d)
    .attr('text-anchor', 'middle')
    .attr('dy', (d, i, arr) => `${(i - (arr.length - 1) / 2) * 1.25}em`)
    .attr('font-size', '11px')
    .attr('fill', CENTER_COLOR)
    .attr('font-weight', '600')
    .style('pointer-events', 'none');

  // トピック（深さ1）テキスト
  nodeG.filter(d => d.type === 'topic')
    .append('text')
    .text(d => d.label)
    .attr('text-anchor', 'middle')
    .attr('dy', '-0.3em')
    .attr('font-size', '10px')
    .attr('font-weight', '700')
    .attr('fill', d => d.color)
    .style('pointer-events', 'none');

  // トピック 件数バッジ
  nodeG.filter(d => d.type === 'topic')
    .append('text').attr('class', 'badge')
    .text(d => `${d.childCount}件`)
    .attr('text-anchor', 'middle')
    .attr('dy', '1.1em')
    .attr('font-size', '8px')
    .attr('fill', d => d.color + 'aa')
    .style('pointer-events', 'none');

  // サブトピック（深さ2+、内部ノード）テキスト
  nodeG.filter(d => d.type === 'subtopic')
    .append('text')
    .text(d => d.label)
    .attr('text-anchor', 'middle')
    .attr('dy', '-0.3em')
    .attr('font-size', '9px')
    .attr('font-weight', '600')
    .attr('fill', d => d.color)
    .style('pointer-events', 'none');

  // サブトピック 件数バッジ
  nodeG.filter(d => d.type === 'subtopic')
    .append('text').attr('class', 'badge')
    .text(d => `${d.childCount}件`)
    .attr('text-anchor', 'middle')
    .attr('dy', '1.1em')
    .attr('font-size', '7px')
    .attr('fill', d => d.color + 'aa')
    .style('pointer-events', 'none');

  // 新着ドットバッジ（topic / subtopic で hasNew のみ）
  nodeG.filter(d => (d.type === 'topic' || d.type === 'subtopic') && d.hasNew)
    .append('circle')
    .attr('class', 'new-dot')
    .attr('r', d => d.type === 'topic' ? 5 : 4)
    .attr('cx', d => d.type === 'topic' ? TOPIC_RADIUS * 0.72 : SUBTOPIC_RADIUS * 0.72)
    .attr('cy', d => d.type === 'topic' ? -TOPIC_RADIUS * 0.72 : -SUBTOPIC_RADIUS * 0.72)
    .attr('fill', '#f0b429')
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 1.5)
    .style('pointer-events', 'none');

  // 記事（葉）テキスト — positionArticleLabels() で同心円上に配置
  nodeG.filter(d => d.type === 'article')
    .append('text')
    .text(d => d.shortLabel)
    .attr('text-anchor', 'middle')
    .attr('dx', '0')
    .attr('dy', '0')
    .attr('font-size', '8px')
    .attr('fill', d => d.isLlm ? '#c9d1d9' : '#8b949e')
    .style('pointer-events', 'none');

  // center + topic をアニメーション表示（native DOM — D3 transition は非表示タブで失速するため）
  document.querySelectorAll('.node.center, .node.topic').forEach((el, i) => {
    setTimeout(() => {
      el.style.transition = 'opacity 0.35s';
      el.style.opacity    = '1';
    }, i * 60);
  });

  // ── インタラクション ──

  // トピック・サブトピック → シングルクリック展開 / ダブルクリックフォーカス
  let clickTimer = null;
  g.selectAll('.node.topic, .node.subtopic')
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      event.stopPropagation();
      const isShift = event.shiftKey;
      if (clickTimer) {
        // ダブルクリック → フォーカスズーム
        clearTimeout(clickTimer);
        clickTimer = null;
        focusCluster(d);
      } else {
        clickTimer = setTimeout(() => {
          clickTimer = null;
          // Shift なし → アコーディオン（他を閉じてから展開）
          if (!isShift) collapseAllExcept(d.id);
          toggleNode(d);
          const expanded = expandedState[d.id];
          const scale    = d.depth === 1 ? (expanded ? 1.1 : 0.85) : 1.25;
          centerOnNode(d.x, d.y, scale);
        }, 220);
      }
    })
    .on('mouseenter', (event, d) => {
      const label = expandedState[d.id]
        ? 'クリック: 折りたたむ  Shift+クリック: 同時展開  ダブルクリック: フォーカス'
        : `クリック: ${d.childCount}件展開  Shift+クリック: 同時展開  ダブルクリック: フォーカス`;
      showTooltip(tooltip, label);
    })
    .on('mousemove', (event) => moveTooltip(tooltip, event))
    .on('mouseleave', () => hideTooltip(tooltip));

  // 記事（葉）→ シングルクリックで詳細パネル表示
  g.selectAll('.node.article')
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      event.stopPropagation();
      centerOnNode(d.x, d.y, 1.6);
      showDetailPanel(d);
    })
    .on('mouseenter', (event, d) => {
      const tip = d.summary
        ? `${d.label}\n${d.summary}`
        : d.label;
      showTooltip(tooltip, tip);
    })
    .on('mousemove', (event) => moveTooltip(tooltip, event))
    .on('mouseleave', () => hideTooltip(tooltip));

  // マップ背景クリックで詳細パネルを閉じる
  svg.on('click', () => hideDetailPanel());
}

// ---- ノードをビューの中心に寄せる ----
function centerOnNode(nodeX, nodeY, scale = 1.2) {
  const tx = width  / 2 - nodeX * scale;
  const ty = height / 2 - nodeY * scale;
  svg.transition()
    .duration(500)
    .ease(d3.easeCubicInOut)
    .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

// ---- フォーカスズーム（クラスター全体をフィット） ----
function focusCluster(d) {
  // クラスターに属する全ノードを収集
  function collectDescendants(id) {
    const result = [nodeMap[id]];
    allNodes.filter(n => n.parentId === id).forEach(child => {
      result.push(...collectDescendants(child.id));
    });
    return result;
  }
  const nodes = collectDescendants(d.id).filter(Boolean);

  // バウンディングボックス
  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  const xMin = Math.min(...xs) - 60;
  const xMax = Math.max(...xs) + 60;
  const yMin = Math.min(...ys) - 60;
  const yMax = Math.max(...ys) + 60;

  const scaleX = width  / (xMax - xMin);
  const scaleY = height / (yMax - yMin);
  const scale  = Math.min(scaleX, scaleY, 2.5) * 0.85;
  const tx = width  / 2 - ((xMin + xMax) / 2) * scale;
  const ty = height / 2 - ((yMin + yMax) / 2) * scale;

  // 子孫を展開してからズーム
  if (!expandedState[d.id]) toggleNode(d);

  svg.transition()
    .duration(600)
    .ease(d3.easeCubicInOut)
    .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));

  document.getElementById('back-btn').style.display = 'block';
}

// 全体に戻る
document.getElementById('back-btn').addEventListener('click', () => {
  centerOnNode(width / 2, height / 2, 1);
  svg.transition().duration(600).ease(d3.easeCubicInOut)
    .call(zoomBehavior.transform, d3.zoomIdentity);
  document.getElementById('back-btn').style.display = 'none';
});

// ---- ユーティリティ ----
function linkPath(d) {
  const s  = d.source;
  const t  = d.target;
  const mx = (s.x + t.x) / 2;
  const my = (s.y + t.y) / 2;
  return `M${s.x},${s.y} Q${mx},${my} ${t.x},${t.y}`;
}

function showTooltip(el, text) {
  el.textContent = text;
  el.classList.add('visible');
}
function moveTooltip(el, event) {
  el.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 300)}px`;
  el.style.top  = `${event.clientY - 10}px`;
}
function hideTooltip(el) {
  el.classList.remove('visible');
}

// ---- 検索・ハイライト ----
let searchQuery = '';

function applySearch(query) {
  searchQuery = query.trim().toLowerCase();
  const clearBtn = document.getElementById('search-clear');
  clearBtn.classList.toggle('visible', searchQuery.length > 0);

  // 全ノードのsearch-match / search-dimクラスをリセット
  document.querySelectorAll('.node').forEach(el => {
    el.classList.remove('search-match', 'search-dim');
  });

  if (!searchQuery) return;

  let matchCount = 0;
  allNodes.forEach(nd => {
    const text = (nd.label + ' ' + nd.summary).toLowerCase();
    const el   = document.querySelector(`[data-nid="${CSS.escape(nd.id)}"]`);
    if (!el) return;

    if (text.includes(searchQuery)) {
      el.classList.add('search-match');
      matchCount++;
      // マッチしたノードの祖先を自動展開
      let pid = nd.parentId;
      while (pid) {
        const pnd = nodeMap[pid];
        if (pnd?.hasChildren && !expandedState[pid]) {
          expandedState[pid] = true;
        }
        pid = pnd?.parentId;
      }
    } else {
      el.classList.add('search-dim');
    }
  });

  if (matchCount > 0) updateVisibility();
}

const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', (e) => applySearch(e.target.value));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    applySearch('');
  }
});
document.getElementById('search-clear').addEventListener('click', () => {
  searchInput.value = '';
  applySearch('');
  searchInput.focus();
});

// ---- イベント ----
document.getElementById('refresh-btn').addEventListener('click', () => {
  // キャッシュをサーバー側でクリアしてから再取得
  cache = null;
  g.selectAll('*').remove();
  loadNews();
});

window.addEventListener('resize', () => {
  if (!currentData) return;
  const c = document.getElementById('map-container');
  width  = c.clientWidth;
  height = c.clientHeight;
  svg.attr('width', width).attr('height', height);
  g.selectAll('*').remove();
  Object.keys(expandedState).forEach(k => delete expandedState[k]);
  buildGraph(currentData.tree);
  renderInitial();
});

init();
