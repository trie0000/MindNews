const express = require('express');
const axios   = require('axios');
const path    = require('path');
const crypto  = require('crypto');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const OLLAMA_BASE    = process.env.OLLAMA_URL    || 'http://localhost:11435'; // SSHトンネル経由でWSL GPU
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL  || 'qwen2.5:7b';
const CLUSTER_BASE   = process.env.CLUSTER_URL   || 'http://localhost:11436'; // Python HDBSCAN クラスタリングAPI

// ---- フォールバック用キーワード分類 ----
const CATEGORY_KEYWORDS = {
  'スポーツ': [
    'WBC', '野球', 'サッカー', 'バレー', 'バスケ', 'テニス', '競馬', '試合', '優勝', '決勝',
    '選手', 'ゴルフ', '柔道', '体操', '陸上', '水泳', '甲子園', 'J1', 'J2', 'プロ野球',
    'カーリング', 'スキー', 'スノボ', 'ボクシング', '格闘技', 'F1', 'レース', '監督', 'コーチ',
    'リーグ', 'チャンピオン', '得点', 'ホームラン', 'ゴール', 'ドラフト',
  ],
  'エンタメ': [
    '俳優', '女優', '歌手', 'アイドル', '映画', 'ドラマ', '音楽', 'アーティスト', 'コンサート',
    'ライブ', 'アニメ', 'デビュー', '結婚', '離婚', '死去', '引退', '芸人', 'バンド', '声優',
    'モデル', 'ファッション', '賞', 'アカデミー', '受賞', 'グラビア', 'お笑い', 'タレント',
    'YouTube', 'SNS', 'インスタ', 'TikTok',
  ],
  '政治・社会': [
    '首相', '政府', '国会', '選挙', '政党', '法案', '条例', '警察', '逮捕', '裁判', '事件',
    '事故', '火災', '地震', '原発', '税金', '補助金', '大臣', '知事', '市長', '議員',
    '自民党', '公明党', '立憲', '維新', '共産党', '裁判所', '検察', '被告', '詐欺',
    '強盗', '殺人', '行方不明', '救助',
  ],
  '国際': [
    'アメリカ', '米国', '中国', 'ロシア', 'ウクライナ', 'イスラエル', 'NATO', '国連',
    '外交', '制裁', '戦争', '軍事', '大統領', 'EU', '韓国', '北朝鮮', 'イラン', 'パレスチナ',
    'ガザ', 'フランス', 'ドイツ', '英国', 'イギリス', 'インド', '台湾', '香港',
    '国際', 'グローバル', '海外', '外国',
  ],
  'テクノロジー': [
    'AI', 'IT', 'スマホ', 'アプリ', 'テスラ', 'Apple', 'Google', 'Microsoft', '半導体',
    'EV', '電気自動車', 'ロボット', 'ChatGPT', 'メタ', 'OpenAI', 'Anthropic',
    'データ', 'クラウド', 'サイバー', 'ハッキング', '5G', '量子', 'ドローン',
    '宇宙', 'NASA', 'JAXA', 'ソフトウェア', 'プログラム',
  ],
  '経済・ビジネス': [
    '株', '円', 'GDP', '経済', '企業', '会社', '投資', '銀行', '金融', '物価',
    'インフレ', '円安', '円高', '貿易', '輸出', '輸入', '上場', 'IPO', '決算',
    '赤字', '黒字', '倒産', 'M&A', '合併', '買収', 'スタートアップ', '起業',
    '雇用', '賃金', '給料', 'ボーナス', 'リストラ', '求人',
  ],
};

function classifyArticleKeyword(title) {
  const scores = {};
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    scores[category] = keywords.filter(kw => title.includes(kw)).length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'その他';
}

// ---- Stage 1: バッチ要約（5件ずつ） ----
const BATCH_SIZE = 5;

// JSONから配列を再帰的に探す
function extractArray(val, depth = 0) {
  if (depth > 4) return null;
  if (Array.isArray(val)) return val;
  if (val && typeof val === 'object') {
    for (const v of Object.values(val)) {
      const found = extractArray(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function llmSummarizeBatch(articles, globalOffset) {
  // グローバルインデックスでLLMに渡す
  const list = articles.map((a, i) => `[${globalOffset + i}] ${a.title}`).join('\n');

  const prompt = `以下の日本語ニュース記事を全て分析してください。必ず日本語で回答してください。

記事:
${list}

全記事を分析して以下の形式のJSONオブジェクトを返してください:
{
  "results": [
    {"idx": インデックス番号, "label": "10文字以内のラベル", "summary": "20文字以内の要約", "category": "カテゴリ名"},
    ...
  ]
}

カテゴリは スポーツ/政治/国際/経済/芸能/テクノロジー/社会/文化/健康/その他 から選択。
ラベルと要約は必ず日本語で記述。ラベルは元の記事タイトルの主要語を漢字・カタカナで使うこと。ひらがなのみのラベルは禁止。`;

  const response = await axios.post(
    `${OLLAMA_BASE}/api/chat`,
    {
      model:  OLLAMA_MODEL,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: '必ず日本語のみで回答する。指定のJSONオブジェクト形式で返す。' },
        { role: 'user',   content: prompt },
      ],
    },
    { timeout: 90000 }
  );

  const raw = response.data?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`Batch ${globalOffset}: JSON parse error, raw=${raw.slice(0, 100)}`);
    return [];
  }
  // 再帰的に配列を探索（{"results":[...]} or {"articles":[...]} 等）
  const arr = extractArray(parsed);
  if (!arr) {
    // シングルオブジェクト（1件だけ返した）の場合は配列に包む
    if (parsed && typeof parsed === 'object' && 'idx' in parsed) {
      console.log(`Batch ${globalOffset}: single object, wrapping`);
      return [parsed];
    }
    console.warn(`Batch ${globalOffset}: no array found, keys=${Object.keys(parsed || {}).join(',')}`);
    return [];
  }
  return arr;
}

// ---- ラベルが日本語として有効か判定 ----
function isValidJapaneseLabel(label) {
  if (!label || label.length < 2) return false;
  // 日本語文字（ひらがな・カタカナ・漢字）を含む
  if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(label)) return false;
  // 3文字以上の英字連続はNG（コードや英語混入）
  if (/[a-zA-Z]{3,}/.test(label)) return false;
  // 3文字以上のひらがなのみラベルは読み仮名を誤出力しているとみなし無効
  // （qwen2.5 が漢字→読み仮名に変換してしまう問題への対処）
  if (label.length >= 3 && /^[\u3040-\u309f\s・]+$/.test(label)) return false;
  return true;
}

// ---- Stage 2: HDBSCAN クラスタリングAPI → LLMでラベル生成 ----
async function clusterAndLabel(articles, summaryMap) {
  // Step A: Python クラスタリングAPIで動的階層化
  const clusterResp = await axios.post(
    `${CLUSTER_BASE}/cluster`,
    { articles: articles.map(a => ({ id: a.id, title: a.title })) },
    { timeout: 60000 }
  );

  const { clusters, depth } = clusterResp.data;
  console.log(`Clustering done: ${clusters.length} clusters, depth=${depth}`);

  // 葉ノード用ラベル取得（日本語品質チェック付き）
  function getLeafLabel(id) {
    const s = summaryMap[id];
    if (s?.label && isValidJapaneseLabel(s.label)) return s.label;
    return articles.find(a => a.id === id)?.title?.slice(0, 12) || id;
  }

  // クラスター代表タイトル（最大5件）
  function clusterTitles(ids) {
    return ids
      .map(id => getLeafLabel(id))
      .slice(0, 5)
      .join(' / ');
  }

  // Step B: 全クラスターを1回のLLMコールで一括ラベリング（重複防止）
  async function labelAllClusters(clusterList) {
    const lines = clusterList.map((cl, i) =>
      `グループ${i + 1}: ${clusterTitles(cl.article_ids)}`
    ).join('\n');

    const prompt = `以下の${clusterList.length}つのニュース記事グループに、それぞれ異なる8文字以内の日本語カテゴリ名を付けてください。同じ名前を使ってはいけません。スポーツの場合は「WBC」「野球」「サッカー」など具体的に。

${lines}

JSONで返してください:
{"labels": ["カテゴリ1", "カテゴリ2", ...]}`;

    try {
      const resp = await axios.post(`${OLLAMA_BASE}/api/chat`, {
        model:  OLLAMA_MODEL,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: '必ず日本語のみで回答する。JSONのみ返す。各グループに異なるラベルをつける。' },
          { role: 'user',   content: prompt },
        ],
      }, { timeout: 60000 });

      const raw    = resp.data?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      const arr    = parsed.labels || extractArray(parsed);
      if (Array.isArray(arr) && arr.length === clusterList.length) {
        return arr.map((l, i) =>
          isValidJapaneseLabel(String(l)) ? String(l) : (clusterList[i].keywords?.[0] || `トピック${i + 1}`)
        );
      }
    } catch (e) {
      console.warn('labelAllClusters error:', e.message);
    }
    return clusterList.map((cl, i) => cl.keywords?.[0] || `トピック${i + 1}`);
  }

  // Step C: クラスターをツリーノードに変換
  const topLabels    = await labelAllClusters(clusters);
  const children     = [];

  for (let ci = 0; ci < clusters.length; ci++) {
    const cl      = clusters[ci];
    const catId   = `t${ci + 1}`;
    const catLabel = topLabels[ci];

    const makeLeaves = (ids) => ids.map(id => ({
      id,
      label:   getLeafLabel(id),
      summary: summaryMap[id]?.summary || '',
    }));

    // サブクラスターがある場合は3階層（サブも一括ラベリング）
    if (cl.subclusters && cl.subclusters.length >= 2) {
      const subLabels = await labelAllClusters(cl.subclusters);
      const subNodes  = cl.subclusters.map((sub, si) => ({
        id:       `${catId}-s${si + 1}`,
        label:    subLabels[si],
        children: makeLeaves(sub.article_ids),
      }));
      children.push({ id: catId, label: catLabel, children: subNodes });
    } else {
      children.push({ id: catId, label: catLabel, children: makeLeaves(cl.article_ids) });
    }
  }

  return { children, depth };
}

// ---- キーワードベースのツリー生成（フォールバック） ----
function keywordBuildTree(articles) {
  const byCategory = {};
  for (const a of articles) {
    const cat = classifyArticleKeyword(a.title);
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(a);
  }

  const children = Object.entries(byCategory).map(([catName, arts], i) => ({
    id: `t${i + 1}`,
    label: catName,
    children: arts.map(a => ({
      id:    a.id,
      label: a.title.slice(0, 12),
      summary: '',
    })),
  }));

  return { children };
}

// ---- 葉ノードに記事データを付与 ----
function attachArticleData(node, articleMap, seenIds) {
  const isLeaf = !node.children || node.children.length === 0;

  if (isLeaf) {
    const article = articleMap[node.id];
    if (article) {
      node.url   = article.url;
      node.title = article.title;
      node.llm   = true;
      seenIds.add(node.id);
    } else {
      node.url = null; // LLM が存在しない ID を生成した場合
    }
    return;
  }

  for (const child of node.children) {
    attachArticleData(child, articleMap, seenIds);
  }
}

// ---- SmartNews スクレイピング ----
async function fetchSmartNews() {
  const { data: html } = await axios.get('https://www.smartnews.com/', {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'ja,en;q=0.9',
    },
    timeout: 15000,
  });

  const pattern = /href="(\/news\/article\/([^"]+))"/g;
  const seen    = new Set();
  const articles = [];
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const slug    = match[2];
    const decoded = decodeURIComponent(slug);
    const dashIdx = decoded.indexOf('-');
    if (dashIdx === -1) continue;

    const id    = decoded.slice(0, dashIdx);
    const title = decoded.slice(dashIdx + 1);
    if (!title || seen.has(id)) continue;
    seen.add(id);

    articles.push({ id, title, url: `https://www.smartnews.com${match[1]}` });
  }

  return articles;
}

// ---- 記事解析キャッシュ（永続化） ----
const ARTICLE_CACHE_PATH = path.join(__dirname, 'article_cache.json');
let articleHashCache = {};  // { hash -> {label, summary, category} }

function loadArticleCache() {
  try {
    if (fs.existsSync(ARTICLE_CACHE_PATH)) {
      articleHashCache = JSON.parse(fs.readFileSync(ARTICLE_CACHE_PATH, 'utf8'));
      console.log(`Article cache loaded: ${Object.keys(articleHashCache).length} entries`);
    }
  } catch (e) {
    console.warn('Article cache load error:', e.message);
    articleHashCache = {};
  }
}

function saveArticleCache() {
  try {
    fs.writeFileSync(ARTICLE_CACHE_PATH, JSON.stringify(articleHashCache), 'utf8');
  } catch (e) {
    console.warn('Article cache save error:', e.message);
  }
}

function hashArticle(article) {
  return crypto.createHash('sha256').update(`${article.id}:${article.title}`).digest('hex').slice(0, 16);
}

loadArticleCache();

// ---- キャッシュ（5分間） ----
let cache    = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

// ---- 処理中の重複リクエスト防止 ----
let processingPromise = null; // LLM処理中は共有Promiseを返す

app.use(express.static(path.join(__dirname, 'public')));

// ---- SSE エンドポイント ----
app.get('/api/news/stream', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => {
    try { res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`); } catch (_) {}
  };

  try {
    const now = Date.now();
    if (cache && now - cacheTime < CACHE_TTL) {
      send('result', { data: cache });
      res.end();
      return;
    }

    // 処理中の重複リクエストは完了まで待機して結果を共有
    if (processingPromise) {
      send('progress', { message: 'AI処理中... 完了まで待機しています' });
      const result = await processingPromise;
      send('result', { data: result });
      res.end();
      return;
    }

    // ステップ1: スクレイピング
    send('progress', { message: 'SmartNews を取得中...' });
    const articles = await fetchSmartNews();
    send('progress', { message: `${articles.length}件の記事を取得しました` });

    // ステップ2: 2段階LLM処理（全件） — 重複実行防止でPromiseを共有
    const targetArticles = articles;
    const idxToId        = targetArticles.map(a => a.id);
    let treeData         = null;
    let llmEnabled       = false;
    let newArticleIds    = [];

    // LLM処理をPromiseにラップし、並行リクエストが来ても1回だけ実行
    processingPromise = (async () => {
      try {
        // --- Stage 1: バッチ要約 ---
        const batches = [];
        for (let i = 0; i < targetArticles.length; i += BATCH_SIZE) {
          batches.push(targetArticles.slice(i, i + BATCH_SIZE));
        }

        const allSummaries  = [];
        const newArticleSet = new Set(); // 今回初めて出現した記事ID
        let cacheHits = 0;
        for (let bi = 0; bi < batches.length; bi++) {
          const offset  = bi * BATCH_SIZE;
          const batch   = batches[bi];

          // キャッシュ済み記事を先に処理
          const uncachedArticles = [];
          const uncachedOffsets  = [];
          for (let j = 0; j < batch.length; j++) {
            const article = batch[j];
            const hash    = hashArticle(article);
            const cached  = articleHashCache[hash];
            if (cached) {
              allSummaries.push({ ...cached, idx: offset + j });
              cacheHits++;
            } else {
              newArticleSet.add(article.id); // 新着としてマーク
              uncachedArticles.push(article);
              uncachedOffsets.push(offset + j);
            }
          }

          if (uncachedArticles.length === 0) {
            console.log(`Batch ${bi + 1}/${batches.length}: 全件キャッシュ済みスキップ`);
            continue;
          }

          send('progress', { message: `記事を要約中... バッチ ${bi + 1}/${batches.length} (${uncachedArticles.length}件, キャッシュ済み${batch.length - uncachedArticles.length}件)` });

          // uncachedArticlesのみLLMへ送る（インデックスはローカル0-basedで渡す）
          const results = await llmSummarizeBatch(uncachedArticles, 0);
          for (const r of results) {
            const localIdx = parseInt(r.idx, 10);
            if (!isNaN(localIdx) && localIdx >= 0 && localIdx < uncachedArticles.length) {
              const globalIdx = uncachedOffsets[localIdx];
              const article   = uncachedArticles[localIdx];
              const hash      = hashArticle(article);
              const entry     = { ...r, idx: globalIdx };
              allSummaries.push(entry);
              // キャッシュに保存
              articleHashCache[hash] = { label: r.label, summary: r.summary, category: r.category };
            }
          }
          console.log(`Batch ${bi + 1}/${batches.length}: ${results.length}件要約完了`);
        }
        console.log(`Article cache hits: ${cacheHits}件スキップ, 新着: ${newArticleSet.size}件`);
        newArticleIds = Array.from(newArticleSet);
        saveArticleCache();

        // 要約されなかった記事をキーワード分類で補完
        const summarizedIdxs = new Set(allSummaries.map(s => s.idx));
        for (let i = 0; i < targetArticles.length; i++) {
          if (!summarizedIdxs.has(i)) {
            const a = targetArticles[i];
            allSummaries.push({
              idx:      i,
              label:    a.title.slice(0, 10),
              summary:  a.title.slice(0, 20),
              category: classifyArticleKeyword(a.title),
            });
          }
        }
        allSummaries.sort((a, b) => a.idx - b.idx);

        // --- Stage 2: HDBSCAN クラスタリング + LLMラベル付け ---
        send('progress', { message: `クラスタリング中... (HDBSCAN + sentence-transformers)` });
        const summaryMap = {};
        for (const s of allSummaries) summaryMap[idxToId[s.idx]] = s;

        send('progress', { message: `クラスターにラベルを付与中... (${OLLAMA_MODEL})` });
        const clusterResult = await clusterAndLabel(targetArticles, summaryMap);
        treeData   = { children: clusterResult.children };
        llmEnabled = true;
        console.log(`Cluster depth: ${clusterResult.depth}`);

      } catch (err) {
        console.warn('Ollama error, fallback to keyword tree:', err.message);
        send('progress', { message: 'AI未接続 — キーワード分類でツリーを構築中...' });
        treeData = keywordBuildTree(targetArticles);
      }

      // treeDataが未設定の場合の安全対策
      if (!treeData) treeData = keywordBuildTree(targetArticles);

      // ステップ3: 葉ノードに記事データを付与
      const articleMap = {};
      for (const a of targetArticles) articleMap[a.id] = a;

      const seenIds = new Set();
      for (const child of treeData.children) {
        attachArticleData(child, articleMap, seenIds);
      }

      // 未配置記事をその他ノードへ
      const missing = targetArticles.filter(a => !seenIds.has(a.id));
      if (missing.length > 0) {
        treeData.children.push({
          id:    'tX',
          label: 'その他',
          children: missing.map(a => ({
            id:      a.id,
            label:   a.title.slice(0, 12),
            summary: '',
            url:     a.url,
            title:   a.title,
            llm:     false,
          })),
        });
      }

      const result = {
        fetchedAt:     new Date().toISOString(),
        totalArticles: articles.length,
        llmEnabled,
        newArticleIds,
        tree:          treeData,
      };
      cache             = result;
      cacheTime         = Date.now();
      processingPromise = null;
      console.log(`Pipeline done: llmEnabled=${llmEnabled}, articles=${articles.length}, categories=${treeData.children.length}`);
      return result;
    })().catch(err => {
      // 万が一IIFEが例外を投げた場合のセーフティネット
      console.error('processingPromise unexpected error:', err.message);
      processingPromise = null;
      const fallback = {
        fetchedAt:     new Date().toISOString(),
        totalArticles: articles.length,
        llmEnabled:    false,
        tree:          keywordBuildTree(articles),
      };
      cache     = fallback;
      cacheTime = Date.now();
      return fallback;
    });

    const result = await processingPromise;
    send('result', { data: result });
  } catch (err) {
    console.error('Stream error:', err.message);
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

// ---- 通常 JSON エンドポイント（後方互換） ----
app.get('/api/news', async (req, res) => {
  try {
    const now = Date.now();
    if (cache && now - cacheTime < CACHE_TTL) {
      return res.json(cache);
    }
    const articles = await fetchSmartNews();
    const treeData = keywordBuildTree(articles);

    const articleMap = {};
    for (const a of articles) articleMap[a.id] = a;
    const seenIds = new Set();
    for (const child of treeData.children) {
      attachArticleData(child, articleMap, seenIds);
    }

    const result = {
      fetchedAt:    new Date().toISOString(),
      totalArticles: articles.length,
      llmEnabled:   false,
      tree:         treeData,
    };
    cache     = result;
    cacheTime = now;
    res.json(result);
  } catch (err) {
    console.error('API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MindNews server running at http://localhost:${PORT}`);
  console.log(`Ollama: ${OLLAMA_BASE}  model: ${OLLAMA_MODEL}`);
  // ウォームアップはキューを占有するため廃止
  // Ollamaはモデルをロード後VRAMに保持するため不要
});
