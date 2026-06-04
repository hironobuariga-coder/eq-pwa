/**
 * collect.js
 * GitHub Actions から夜間に1時間ごとに実行される収集スクリプト。
 * NEXCO東/中/西のリアルタイム規制情報をスクレイピングし、
 * 東名阪の大動脈に絞ってdata/road-log.json に時系列で追記する。
 *
 * 依存: node-fetch@2, cheerio (package.json 参照)
 * 実行: node collect.js
 */

const fs   = require('fs');
const path = require('path');

// Node 18+ では fetch がビルトイン。それ以下は node-fetch を使う。
let fetch;
try {
  fetch = globalThis.fetch || require('node-fetch');
} catch (e) {
  fetch = require('node-fetch');
}

let cheerio;
try {
  cheerio = require('cheerio');
} catch (e) {
  console.error('cheerio が未インストールです。npm install cheerio を実行してください。');
  process.exit(1);
}

// ─── 監視対象路線（東名阪大動脈）────────────────────────────────
const TARGET_ROADS = [
  '東名', '名神', '新東名', '新名神',
  '伊勢湾岸', '東名阪', '西名阪', '名二環',
  '中央道', '関越', '東北道', '常磐道',
  '山陽', '近畿', '阪神'
];

// ─── スクレイピング対象 URL ─────────────────────────────────────
const SOURCES = [
  {
    name: 'NEXCO東日本',
    url:  'https://www.driveplaza.com/traffic/roadinfo/currentstatus/',
    parse: parseEast
  },
  {
    name: 'NEXCO中日本',
    url:  'https://www.c-nexco.co.jp/traffic/traffic_info.html',
    parse: parseCentral
  },
  {
    name: 'NEXCO西日本',
    url:  'https://www.w-nexco.co.jp/realtime/',
    parse: parseWest
  }
];

// ─── パーサー群 ──────────────────────────────────────────────────

/**
 * NEXCO東日本 の規制情報HTMLをパース
 * テーブル形式: 路線 | 区間 | 方向 | 規制種別 | 理由
 */
function parseEast(html) {
  const $ = cheerio.load(html);
  const results = [];
  // 規制情報テーブルの行を取得
  $('table').each((_, tbl) => {
    $(tbl).find('tr').each((_, tr) => {
      const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length >= 4) {
        const road    = cells[0] || '';
        const section = cells[1] || cells[2] || '';
        const dir     = cells[2] || '';
        const status  = cells[3] || '';
        if (road && isTargetRoad(road) && isClosureStatus(status)) {
          results.push({ road, section, direction: dir, status, source: 'NEXCO東日本' });
        }
      }
    });
  });
  return results;
}

/**
 * NEXCO中日本 の規制情報HTMLをパース
 */
function parseCentral(html) {
  const $ = cheerio.load(html);
  const results = [];
  // 通行止めリストのテキストから路線・区間を抽出
  $('tr, .regulation-row, .info-row').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const cells = $(el).find('td').map((_, td) => $(td).text().trim()).get();
    if (cells.length >= 3) {
      const road    = cells[0] || '';
      const section = cells[1] || '';
      const status  = cells[2] || cells[3] || '';
      if (road && isTargetRoad(road) && isClosureStatus(status)) {
        results.push({ road, section, direction: cells[2] || '', status, source: 'NEXCO中日本' });
      }
    }
  });
  return results;
}

/**
 * NEXCO西日本 の規制情報HTMLをパース
 */
function parseWest(html) {
  const $ = cheerio.load(html);
  const results = [];
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
    if (cells.length >= 3) {
      const road    = cells[0] || '';
      const section = cells[1] || '';
      const status  = cells[2] || cells[3] || '';
      if (road && isTargetRoad(road) && isClosureStatus(status)) {
        results.push({ road, section, direction: cells[2] || '', status, source: 'NEXCO西日本' });
      }
    }
  });
  return results;
}

// ─── ヘルパー ──────────────────────────────────────────────────────

/** 監視対象路線かどうかを判定 */
function isTargetRoad(text) {
  return TARGET_ROADS.some(r => text.includes(r));
}

/** 通行止め系のステータスかどうかを判定（車線規制は含まず）*/
function isClosureStatus(text) {
  return /通行止め|全面通行止|通行規制|通行止|チェーン規制/.test(text);
}

/** フォールバック：テキスト全体から通行止め情報を正規表現で抽出 */
function extractFromText(html, sourceName) {
  const $ = cheerio.load(html);
  const text = $('body').text();
  const results = [];
  // "東名 御殿場IC〜沼津IC 通行止め" のようなパターンを検出
  const pattern = /([東西南北新旧第\w]{2,12}(?:道|線|道路|自動車道))[\s　]+([^\n]{5,40}IC[^\n]{0,20})[\s　]*(通行止め|全面通行止)/g;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const road = m[1];
    if (isTargetRoad(road)) {
      results.push({ road, section: m[2].trim(), direction: '', status: m[3], source: sourceName });
    }
  }
  return results;
}

// ─── メイン処理 ────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  // JST で表示
  const jstOffset = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + jstOffset);
  const timestamp = jst.toISOString().replace('Z', '+09:00').slice(0, 19) + '+09:00';

  console.log(`[${timestamp}] 収集開始`);

  const allClosures = [];

  for (const source of SOURCES) {
    try {
      console.log(`  取得中: ${source.name} (${source.url})`);
      const res = await fetch(source.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RoadInfoCollector/1.0)',
          'Accept-Language': 'ja,en;q=0.9'
        },
        timeout: 15000
      });
      if (!res.ok) {
        console.warn(`  ⚠ ${source.name}: HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      let closures = source.parse(html);

      // パーサーで取れなかった場合はテキスト抽出にフォールバック
      if (closures.length === 0) {
        closures = extractFromText(html, source.name);
      }

      console.log(`  ✓ ${source.name}: ${closures.length}件の通行止め`);
      allClosures.push(...closures);
    } catch (e) {
      console.warn(`  ✗ ${source.name}: ${e.message}`);
    }
  }

  // 重複除去（同じ路線・区間は1つに）
  const seen = new Set();
  const deduped = allClosures.filter(c => {
    const key = `${c.road}|${c.section}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ─── road-log.json に追記 ────────────────────────────────────────
  const logPath = path.join(__dirname, 'data', 'road-log.json');
  let log = [];

  if (fs.existsSync(logPath)) {
    try {
      log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    } catch (e) {
      console.warn('road-log.json の読み込みに失敗、新規作成します');
      log = [];
    }
  }

  // 古いエントリを削除（7日以上前）
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  log = log.filter(entry => new Date(entry.ts) > cutoff);

  // 今回のエントリを追加
  log.push({ ts: timestamp, closures: deduped });

  // 時系列順に並べ替え
  log.sort((a, b) => a.ts.localeCompare(b.ts));

  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');
  console.log(`[${timestamp}] road-log.json 更新完了 (全${log.length}エントリ、今回${deduped.length}件)`);

  // ─── road-log-summary.json も生成（PWAが使いやすい形式）─────────
  const summary = buildSummary(log);
  const summaryPath = path.join(__dirname, 'data', 'road-log-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`road-log-summary.json 更新完了`);
}

/**
 * ログから「路線ごとの通行止め継続期間」を集計したサマリーを生成
 * {
 *   generated: "2026-06-04T06:00:00+09:00",
 *   periods: [                           // 通行止め期間の一覧
 *     {
 *       road: "東名",
 *       section: "御殿場IC〜沼津IC",
 *       direction: "上下線",
 *       start: "2026-06-03T22:00:00+09:00",
 *       end:   "2026-06-04T04:00:00+09:00",  // null = まだ継続中
 *       snapshots: ["22:00","23:00","0:00","1:00","2:00","3:00"]
 *     }
 *   ]
 * }
 */
function buildSummary(log) {
  if (log.length === 0) return { generated: new Date().toISOString(), periods: [] };

  // 各スナップショット時刻の通行止め区間セットを構築
  const snapshots = log.map(entry => ({
    ts: entry.ts,
    keys: new Set(entry.closures.map(c => `${c.road}|${c.section}`)),
    closures: entry.closures
  }));

  // 区間ごとの全スナップショット一覧を作る
  const allKeys = new Set(snapshots.flatMap(s => [...s.keys]));
  const periods = [];

  for (const key of allKeys) {
    const [road, section] = key.split('|');
    // この区間が登場するスナップショット一覧
    const appearances = snapshots.filter(s => s.keys.has(key));
    if (appearances.length === 0) continue;

    // 方向を最初の出現から取得
    const firstSnap = appearances[0];
    const firstClosure = firstSnap.closures.find(c => `${c.road}|${c.section}` === key);
    const direction = firstClosure?.direction || '';
    const source    = firstClosure?.source    || '';
    const status    = firstClosure?.status    || '通行止め';

    // 連続した期間にグルーピング
    // （1時間ごとの記録なので、2エントリ以上空白があれば別期間とみなす）
    let groupStart = null;
    let groupSnaps = [];
    let prevTs     = null;

    const flush = () => {
      if (!groupStart) return;
      const lastTs = groupSnaps[groupSnaps.length - 1];
      // その後のスナップショットに登場しなければ終了とみなす
      const nextIdx = snapshots.findIndex(s => s.ts > lastTs);
      const isOngoing = nextIdx === -1; // ログの末尾 = まだ記録中
      periods.push({
        road, section, direction, status, source,
        start: groupStart,
        end:   isOngoing ? null : lastTs,
        snapshots: groupSnaps.map(ts => {
          // HH:MM 形式に変換
          const d = new Date(ts);
          const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
          const h = jst.getUTCHours(), m = jst.getUTCMinutes();
          return `${h}:${String(m).padStart(2,'0')}`;
        })
      });
    };

    for (const snap of appearances) {
      if (!groupStart) {
        groupStart = snap.ts;
        groupSnaps = [snap.ts];
      } else {
        // 前のスナップショットから2時間以上空いていたら別期間
        const gap = (new Date(snap.ts) - new Date(prevTs)) / 3600000;
        if (gap > 2) {
          flush();
          groupStart = snap.ts;
          groupSnaps = [snap.ts];
        } else {
          groupSnaps.push(snap.ts);
        }
      }
      prevTs = snap.ts;
    }
    flush();
  }

  // 開始時刻でソート
  periods.sort((a, b) => a.start.localeCompare(b.start));

  return {
    generated: new Date().toISOString(),
    periods
  };
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
