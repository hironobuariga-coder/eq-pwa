/**
 * collect-disaster.js
 *
 * 気象庁防災情報XMLフィードを15分ごとにチェックし、
 * 以下の条件に合致した場合に data/disaster-trigger.json を更新する。
 *
 * 【トリガー条件】
 *   地震 : 最大震度 >= AUTO_SHINDO_THRESHOLD（disaster-config.json で設定可）
 *   台風 : 全般台風情報に「発生」または日本近海への進路言及が含まれる
 *   大雨 : 大雨警報（レベル3相当）または土砂災害警戒情報の発表
 *   大雪 : 大雪警報（レベル3相当）の発表
 *
 * 【無料運用ポイント】
 *   - データソース：気象庁防災情報XML（完全無料・商用利用可）
 *   - 実行環境：GitHub Actions（publicリポジトリなら完全無料）
 *   - 追加API不要（Node.js組み込みfetchのみ）
 *
 * 【タイムラグ】
 *   最大約15分（地震は気象庁発表から+15分以内で検知）
 */

const fs   = require('fs');
const path = require('path');

let fetchFn;
try { fetchFn = globalThis.fetch || require('node-fetch'); }
catch(e) { fetchFn = require('node-fetch'); }

// ─── 気象庁XMLフィードURL ─────────────────────────────────────────
const JMA_FEEDS = {
  // 地震火山情報（高頻度：毎分更新、直近10分分）
  eqvol: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml',
  // 随時情報（台風・警報など）
  extra: 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml',
};

// ─── 設定読み込み ─────────────────────────────────────────────────
const CONFIG_PATH  = path.join(__dirname, 'data', 'disaster-config.json');
const TRIGGER_PATH = path.join(__dirname, 'data', 'disaster-trigger.json');

function loadConfig() {
  var defaults = {
    // 地震自動発動の最低震度（数値：3=震度3, 4=震度4, 4.5=震度5弱, 5=震度5強）
    auto_shindo: 4,
    // 台風自動発動（true=有効）
    auto_typhoon: true,
    // 大雨自動発動（true=有効）
    auto_rain: true,
    // 大雪自動発動（true=有効）
    auto_snow: true,
  };
  if (!fs.existsSync(CONFIG_PATH)) return defaults;
  try {
    return Object.assign(defaults, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  } catch(e) { return defaults; }
}

// ─── 既処理IDの管理（重複発動防止）─────────────────────────────
function loadProcessed() {
  if (!fs.existsSync(TRIGGER_PATH)) return { triggers: [], processed_ids: [] };
  try { return JSON.parse(fs.readFileSync(TRIGGER_PATH, 'utf-8')); }
  catch(e) { return { triggers: [], processed_ids: [] }; }
}

// ─── フェッチヘルパー ────────────────────────────────────────────
async function fetchXML(url) {
  try {
    var opt = {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DisasterBot/1.0; +https://github.com)' }
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      opt.signal = AbortSignal.timeout(15000);
    }
    var res = await fetchFn(url, opt);
    if (!res.ok) { console.warn('HTTP', res.status, url); return null; }
    return await res.text();
  } catch(e) {
    console.warn('fetch error:', e.message, url);
    return null;
  }
}

// ─── AtomフィードからエントリーURLを抽出 ───────────────────────
function parseFeedEntries(xml) {
  if (!xml) return [];
  var entries = [];
  var blocks = xml.split(/<entry[\s>]/).slice(1);
  blocks.forEach(function(block) {
    var titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    var linkM  = block.match(/href="([^"]+)"/);
    var idM    = block.match(/<id[^>]*>([\s\S]*?)<\/id>/i);
    var updM   = block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);
    if (titleM && linkM) {
      entries.push({
        title:   titleM[1].trim(),
        url:     linkM[1].trim(),
        id:      idM  ? idM[1].trim()  : linkM[1].trim(),
        updated: updM ? updM[1].trim() : '',
      });
    }
  });
  return entries;
}

// ─── 震度文字列→数値変換 ────────────────────────────────────────
function shindoToNum(s) {
  if (!s) return 0;
  var m = { '1':1,'2':2,'3':3,'4':4,'5弱':4.5,'5強':5,'6弱':5.5,'6強':6,'7':7 };
  // 「震度X」形式 or 直接「X」形式
  var clean = s.replace(/震度|階級/g, '').trim();
  return m[clean] || parseFloat(clean) || 0;
}

// ─── 地震エントリーから震度を抽出（電文本文を取得）──────────────
async function fetchEqLevel(url) {
  var xml = await fetchXML(url);
  if (!xml) return 0;
  // 最大震度の抽出: <MaxInt>震度5強</MaxInt> or <jmx_eb:Intensity>
  var m = xml.match(/<MaxInt>([\s\S]*?)<\/MaxInt>/i)
          || xml.match(/<jmx_eb:Intensity>([\s\S]*?)<\/jmx_eb:Intensity>/i);
  if (m) return shindoToNum(m[1].trim());
  // フィードタイトルから推定（例：「最大震度５弱」）
  var tm = url.match(/震度([^<\s]+)/);
  return tm ? shindoToNum(tm[1]) : 0;
}

// ─── メイン ─────────────────────────────────────────────────────
async function main() {
  var now = new Date();
  var jst = new Date(now.getTime() + 9 * 3600000);
  var ts  = jst.toISOString().slice(0, 19).replace('T', ' ') + '+09:00';
  console.log('[' + ts + '] 災害トリガーチェック開始');

  var cfg  = loadConfig();
  var data = loadProcessed();
  var processedIds = new Set(data.processed_ids || []);
  var newTriggers  = [];

  // ─── 地震チェック（eqvol.xml）─────────────────────────────────
  if (cfg.auto_shindo !== false) {
    var eqXml = await fetchXML(JMA_FEEDS.eqvol);
    var eqEntries = parseFeedEntries(eqXml);
    console.log('  地震フィード:', eqEntries.length, 'エントリー');

    // 「震源・震度に関する情報」のみ対象（震度速報は速報なので除外しない）
    var eqInfoEntries = eqEntries.filter(function(e) {
      return e.title.indexOf('震源・震度') >= 0
          || e.title.indexOf('震度速報') >= 0;
    });

    for (var i = 0; i < eqInfoEntries.length; i++) {
      var entry = eqInfoEntries[i];
      if (processedIds.has(entry.id)) continue;

      // タイトルから震度を素早く判定（電文取得は閾値超え候補のみ）
      var titleShindo = 0;
      var sm = entry.title.match(/震度([0-9０-９]+[弱強]?)/);
      if (sm) titleShindo = shindoToNum(sm[1]);

      // 閾値以上の可能性がある場合だけ電文を取得
      if (titleShindo >= cfg.auto_shindo - 0.5) {
        var level = await fetchEqLevel(entry.url);
        console.log('  [地震]', entry.title, '→ 震度', level, '(閾値:', cfg.auto_shindo, ')');

        if (level >= cfg.auto_shindo) {
          // タイトルから震源地・時刻を抽出
          var epicenter = '';
          var em = entry.title.match(/震源地?[はが]?([^\s　（）()、。]+地|[^\s　（）()、。]+地方|[^\s　（）()、。]+沖|[^\s　（）()、。]+半島)/);
          if (em) epicenter = em[1];

          newTriggers.push({
            id:       entry.id,
            type:     'quake',
            dtype:    'quake',
            level:    level,
            title:    entry.title,
            epicenter: epicenter,
            maxShindo: level,
            detected: ts,
            url:      entry.url,
          });
        }
      }
      processedIds.add(entry.id);
    }
  }

  // ─── 台風・大雨・大雪チェック（extra.xml）────────────────────
  var exXml = await fetchXML(JMA_FEEDS.extra);
  var exEntries = parseFeedEntries(exXml);
  console.log('  随時フィード:', exEntries.length, 'エントリー');

  exEntries.forEach(function(entry) {
    if (processedIds.has(entry.id)) return;
    var t = entry.title;

    // 台風
    if (cfg.auto_typhoon &&
        (t.indexOf('台風') >= 0) &&
        (t.indexOf('発生') >= 0 || t.indexOf('接近') >= 0 ||
         t.indexOf('上陸') >= 0 || t.indexOf('進路') >= 0 ||
         t.indexOf('暴風') >= 0 || t.indexOf('全般台風') >= 0)) {
      console.log('  [台風]', t);
      if (!processedIds.has(entry.id)) {
        newTriggers.push({
          id: entry.id, type: 'typhoon', dtype: 'typhoon',
          title: t, detected: ts, url: entry.url,
        });
      }
    }

    // 大雨：大雨警報 / 土砂災害警戒情報 / 記録的短時間大雨情報
    if (cfg.auto_rain &&
        (t.indexOf('大雨警報') >= 0     ||
         t.indexOf('大雨特別警報') >= 0  ||
         t.indexOf('土砂災害警戒情報') >= 0 ||
         t.indexOf('記録的短時間大雨') >= 0 ||
         t.indexOf('指定河川洪水予報') >= 0) &&
        t.indexOf('解除') < 0) {
      console.log('  [大雨]', t);
      newTriggers.push({
        id: entry.id, type: 'rain', dtype: 'rain',
        title: t, detected: ts, url: entry.url,
      });
    }

    // 大雪：大雪警報
    if (cfg.auto_snow &&
        (t.indexOf('大雪警報') >= 0 || t.indexOf('大雪特別警報') >= 0) &&
        t.indexOf('解除') < 0) {
      console.log('  [大雪]', t);
      newTriggers.push({
        id: entry.id, type: 'snow', dtype: 'snow',
        title: t, detected: ts, url: entry.url,
      });
    }

    processedIds.add(entry.id);
  });

  // ─── 結果保存 ─────────────────────────────────────────────────
  // 直近24時間のトリガーのみ保持
  var cutoff = new Date(now.getTime() - 24 * 3600000);
  var existingTriggers = (data.triggers || []).filter(function(t) {
    return new Date(t.detected.replace('+09:00','Z').replace(' ','T')) > cutoff;
  });

  // 同一災害種別の重複排除（直近にすでに同種トリガーがあれば追加しない）
  newTriggers = newTriggers.filter(function(nt) {
    var recentSameType = existingTriggers.some(function(et) {
      return et.dtype === nt.dtype;
    });
    return !recentSameType;
  });

  var allTriggers = existingTriggers.concat(newTriggers);

  // processed_ids も24時間分に絞る（無制限増加防止）
  var processedArr = Array.from(processedIds).slice(-2000);

  var output = {
    generated: ts,
    triggers:  allTriggers,
    processed_ids: processedArr,
  };

  fs.writeFileSync(TRIGGER_PATH, JSON.stringify(output, null, 2), 'utf-8');

  if (newTriggers.length > 0) {
    console.log('[' + ts + '] 新規トリガー:', newTriggers.length, '件');
    newTriggers.forEach(function(t) {
      console.log('  >', t.type, '|', t.title);
    });
  } else {
    console.log('[' + ts + '] 新規トリガーなし');
  }
}

main().catch(function(e) { console.error('Fatal:', e); process.exit(1); });
