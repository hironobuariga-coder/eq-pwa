/**
 * collect-disaster.js  v2
 *
 * 気象庁防災情報XML + 特務機関NERV（Mastodon）フィードを10分ごとにチェックし、
 * ① data/disaster-trigger.json  — 自動収集トリガー（既存・変更なし）
 * ② data/earthquake-info.json   — 地震情報の完全構造化データ（Phase3新規）
 * を更新する。
 *
 * earthquake-info.json により、index.html の地震情報取得でAPIを呼ばずに
 * JSONポーリングのみで表示できるようになる（9円/回 削減）。
 *
 * 【地震電文（VXSE53 震源・震度に関する情報）の主要タグ】
 *   <OriginTime>          発生時刻
 *   <Name>                震源地名（Body/Earthquake/Hypocenter/Area/Name）
 *   <jmx_eb:Coordinate>   緯度経度深さ（Lat/Long/Dep形式）
 *   <jmx_eb:Magnitude>    マグニチュード
 *   <MaxInt>              最大震度（全体）
 *   <Pref> - <Area>       都道府県別震度エリア
 *   TsunamiComment        津波コメント
 */

'use strict';

const fs   = require('fs');
const path = require('path');

if (typeof globalThis.fetch === 'undefined') {
  console.error('fetch が利用できません。Node.js 18以上が必要です。');
  process.exit(1);
}
const fetchFn = globalThis.fetch.bind(globalThis);

// ─── パス定義 ─────────────────────────────────────────────────────
const CONFIG_PATH   = path.join(__dirname, 'data', 'disaster-config.json');
const TRIGGER_PATH  = path.join(__dirname, 'data', 'disaster-trigger.json');
const EQ_INFO_PATH  = path.join(__dirname, 'data', 'earthquake-info.json');

// ─── 気象庁XMLフィードURL ─────────────────────────────────────────
const JMA_FEEDS = {
  eqvol: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml',
  extra: 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml',
};

// ─── 特務機関NERV Mastodon RSSフィード ──────────────────────────
const NERV_FEEDS = {
  all:     'https://unnerv.jp/@UN_NERV.rss',
  quake:   'https://unnerv.jp/@earthquake.rss',
  typhoon: 'https://unnerv.jp/@typhoon.rss',
};

// ─── JST タイムスタンプ ───────────────────────────────────────────
function nowJST() {
  var jst = new Date(Date.now() + 9 * 3600000);
  return jst.toISOString().slice(0, 19).replace('T', ' ') + '+09:00';
}

// ─── 設定読み込み ─────────────────────────────────────────────────
function loadConfig() {
  var defaults = { auto_shindo: 4, auto_typhoon: true, auto_rain: true, auto_snow: true };
  if (!fs.existsSync(CONFIG_PATH)) return defaults;
  try { return Object.assign(defaults, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))); }
  catch(e) { return defaults; }
}

// ─── 既処理IDの管理 ──────────────────────────────────────────────
function loadProcessed() {
  if (!fs.existsSync(TRIGGER_PATH)) return { triggers: [], processed_ids: [] };
  try { return JSON.parse(fs.readFileSync(TRIGGER_PATH, 'utf-8')); }
  catch(e) { return { triggers: [], processed_ids: [] }; }
}

// ─── フェッチヘルパー ────────────────────────────────────────────
async function fetchXML(url) {
  try {
    var res = await fetchFn(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DisasterBot/2.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { console.warn('HTTP', res.status, url); return null; }
    return await res.text();
  } catch(e) {
    console.warn('fetch error:', e.message, url);
    return null;
  }
}

// ─── Atom フィードパーサー ───────────────────────────────────────
function parseFeedEntries(xml) {
  if (!xml) return [];
  var entries = [];
  xml.split(/<entry[\s>]/).slice(1).forEach(function(block) {
    var titleM = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    var linkM  = block.match(/href="([^"]+)"/);
    var idM    = block.match(/<id[^>]*>([\s\S]*?)<\/id>/i);
    var updM   = block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);
    if (titleM && linkM) {
      entries.push({
        title:   titleM[1].trim(),
        url:     linkM[1].trim(),
        id:      idM ? idM[1].trim() : linkM[1].trim(),
        updated: updM ? updM[1].trim() : '',
      });
    }
  });
  return entries;
}

// ─── RSS フィードパーサー（NERV Mastodon用）────────────────────
function parseRSSItems(xml) {
  if (!xml) return [];
  var items = [];
  xml.split(/<item[\s>]/).slice(1).forEach(function(block) {
    var titleM = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    var descM  = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
    var linkM  = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    var pubM   = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    var guidM  = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    var title  = titleM ? titleM[1].replace(/<[^>]+>/g,'').trim() : '';
    var desc   = descM  ? descM[1].replace(/<[^>]+>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim() : '';
    var text   = (title + ' ' + desc).trim();
    var id     = guidM ? guidM[1].trim() : (linkM ? linkM[1].trim() : text.slice(0,60));
    if (text) items.push({ title, text, id, url: linkM ? linkM[1].trim() : '', pubDate: pubM ? pubM[1].trim() : '' });
  });
  return items;
}

// ─── 震度文字列→数値 ─────────────────────────────────────────────
function shindoToNum(s) {
  if (!s) return 0;
  var m = { '1':1,'2':2,'3':3,'4':4,'5弱':4.5,'5強':5,'6弱':5.5,'6強':6,'7':7 };
  var clean = s.replace(/震度|階級/g, '').trim();
  return m[clean] || parseFloat(clean) || 0;
}

// ─── 震度数値→表示文字列 ─────────────────────────────────────────
function numToShindo(n) {
  var m = { 7:'7', 6:'6強', 5.5:'6弱', 5:'5強', 4.5:'5弱', 4:'4', 3:'3', 2:'2', 1:'1' };
  return m[n] || String(n);
}

// ─── alertLevel判定 ───────────────────────────────────────────────
function calcAlertLevel(maxShindoNum) {
  if (maxShindoNum >= 5) return 'alert';
  if (maxShindoNum >= 4.5) return 'watch';
  return 'normal';
}

// ─── 都道府県名から affectedPrefs を生成 ─────────────────────────
// JMAの地域名（例「宮城県南部」「岩手県北部」）から都道府県名を抽出
function extractPref(areaName) {
  var m = areaName.match(/^(.+?[都道府県])/);
  return m ? m[1] : areaName;
}

// ─── 地震電文（VXSE53）の完全解析 ──────────────────────────────
// 気象庁 震源・震度に関する情報 の XML を受け取り、
// index.html の DD.quake.render() が期待するスキーマに変換する
function parseEqXML(xml) {
  if (!xml) return null;

  // ── 発生時刻 ──────────────────────────────────────────────────
  var timeM = xml.match(/<OriginTime>([\s\S]*?)<\/OriginTime>/i);
  var time = '';
  if (timeM) {
    // ISO8601 → "M/D HH:MM頃" に変換
    try {
      var d = new Date(timeM[1].trim());
      // JST変換（YYYY/M/D HH:MM 形式）
      var jst = new Date(d.getTime() + 9 * 3600000);
      time = jst.getUTCFullYear() + '/'
           + (jst.getUTCMonth()+1) + '/'
           + jst.getUTCDate() + ' '
           + String(jst.getUTCHours()).padStart(2,'0') + ':'
           + String(jst.getUTCMinutes()).padStart(2,'0')
           + ' (JST)';
    } catch(e) { time = timeM[1].trim(); }
  }

  // ── 震源地 ────────────────────────────────────────────────────
  // Body/Earthquake/Hypocenter/Area/Name
  var epicenterM = xml.match(/<Hypocenter>[\s\S]*?<Area>[\s\S]*?<Name>([\s\S]*?)<\/Name>/i)
                || xml.match(/<Name>([\s\S]*?)<\/Name>/i);
  var epicenter = epicenterM ? epicenterM[1].trim() : '';

  // ── 深さ ──────────────────────────────────────────────────────
  var depM = xml.match(/depth="([^"]+)"/i)
           || xml.match(/<jmx_eb:Coordinate[^>]*>([\s\S]*?)<\/jmx_eb:Coordinate>/i);
  var depth = '';
  if (depM) {
    // 座標形式 "+38.5+142.2-60000/" から深さを抽出
    var dm = depM[1].match(/[+-]\d+\.?\d*\//) || depM[1].match(/(\d+)km/i);
    if (dm) {
      var depKm = Math.round(Math.abs(parseFloat(dm[0])) / 1000);
      if (depKm > 0 && depKm < 800) depth = '約' + depKm + 'km';
    }
  }

  // ── マグニチュード ────────────────────────────────────────────
  var magM = xml.match(/<jmx_eb:Magnitude[^>]*type="Mj"[^>]*>([\s\S]*?)<\/jmx_eb:Magnitude>/i)
           || xml.match(/<jmx_eb:Magnitude[^>]*>([\s\S]*?)<\/jmx_eb:Magnitude>/i);
  var magnitude = magM ? 'M' + magM[1].trim() : '';

  // ── 最大震度 ──────────────────────────────────────────────────
  var maxIntM = xml.match(/<MaxInt>([\s\S]*?)<\/MaxInt>/i)
             || xml.match(/<jmx_eb:Intensity>([\s\S]*?)<\/jmx_eb:Intensity>/i);
  var maxShindoStr = maxIntM ? maxIntM[1].replace(/震度/g,'').trim() : '';
  var maxShindoNum = shindoToNum(maxShindoStr);

  // ── 津波情報 ──────────────────────────────────────────────────
  var tsunamiM = xml.match(/<TsunamiComment[^>]*>([\s\S]*?)<\/TsunamiComment>/i)
              || xml.match(/<Comments>[\s\S]*?<Text[^>]*>([\s\S]*?)<\/Text>/i)
              || xml.match(/<Forecast[^>]*>[\s\S]*?<Text[^>]*>([\s\S]*?)<\/Text>/i);
  var tsunami = '情報なし';
  if (tsunamiM) {
    var t = tsunamiM[1].trim();
    if (t.indexOf('心配ない') >= 0 || t.indexOf('なし') >= 0) tsunami = 'なし';
    else if (t.indexOf('注意報') >= 0) tsunami = '津波注意報発表';
    else if (t.indexOf('警報') >= 0) tsunami = '津波警報発表';
    else if (t.indexOf('大津波') >= 0) tsunami = '大津波警報発表';
    else tsunami = t.slice(0, 40).replace(/[\r\n]+/g, '');
  }

  // ── 震度エリア（shindoAreas）────────────────────────────────
  // <Pref><Name>都道府県名</Name><MaxInt>震度X</MaxInt><Area>...</Area></Pref>
  // または <Area><Name>地域名</Name><MaxInt>震度X</MaxInt></Area>
  var shindoAreas = [];
  var prefBlocks = xml.match(/<Pref>([\s\S]*?)<\/Pref>/gi) || [];

  if (prefBlocks.length > 0) {
    // 都道府県ブロックがある場合 → 都道府県単位で集約
    var prefMap = {}; // 震度 → [都道府県名]
    prefBlocks.forEach(function(pb) {
      var pnM  = pb.match(/<Name>([\s\S]*?)<\/Name>/i);
      var piM  = pb.match(/<MaxInt>([\s\S]*?)<\/MaxInt>/i);
      if (!pnM || !piM) return;
      var pref  = pnM[1].trim();
      var level = piM[1].replace(/震度/g,'').trim();
      var lNum  = shindoToNum(level);
      if (lNum < 1) return;
      var key = numToShindo(lNum);
      if (!prefMap[key]) prefMap[key] = [];
      prefMap[key].push(pref);
    });
    // 震度降順でソート
    var shindoOrder = ['7','6強','6弱','5強','5弱','4','3','2','1'];
    shindoOrder.forEach(function(lv) {
      if (prefMap[lv] && prefMap[lv].length > 0) {
        shindoAreas.push({ level: lv, area: prefMap[lv].join('・') });
      }
    });
  } else {
    // Prefブロックなし → Areaブロックから取得
    var areaBlocks = xml.match(/<Area>([\s\S]*?)<\/Area>/gi) || [];
    var areaMap = {};
    areaBlocks.forEach(function(ab) {
      var anM = ab.match(/<Name>([\s\S]*?)<\/Name>/i);
      var aiM = ab.match(/<MaxInt>([\s\S]*?)<\/MaxInt>/i)
             || ab.match(/<jmx_eb:Intensity>([\s\S]*?)<\/jmx_eb:Intensity>/i);
      if (!anM || !aiM) return;
      var area  = anM[1].trim();
      var level = aiM[1].replace(/震度/g,'').trim();
      var lNum  = shindoToNum(level);
      if (lNum < 1) return;
      var key = numToShindo(lNum);
      if (!areaMap[key]) areaMap[key] = [];
      areaMap[key].push(area);
    });
    var shindoOrder2 = ['7','6強','6弱','5強','5弱','4','3','2','1'];
    shindoOrder2.forEach(function(lv) {
      if (areaMap[lv] && areaMap[lv].length > 0) {
        shindoAreas.push({ level: lv, area: areaMap[lv].join('・') });
      }
    });
  }

  // ── affectedPrefs（RC状態判定用）────────────────────────────
  var affectedPrefs = [];
  var seen = {};
  shindoAreas.forEach(function(sa) {
    sa.area.split('・').forEach(function(name) {
      var pref = extractPref(name);
      if (pref && !seen[pref]) { seen[pref] = true; affectedPrefs.push(pref); }
    });
  });

  return {
    time:         time,
    epicenter:    epicenter,
    depth:        depth,
    magnitude:    magnitude,
    maxShindo:    maxShindoStr || numToShindo(maxShindoNum),
    tsunami:      tsunami,
    shindoAreas:  shindoAreas,
    alertLevel:   calcAlertLevel(maxShindoNum),
    affectedPrefs: affectedPrefs,
  };
}

// ─── 地震電文を取得して完全解析 ──────────────────────────────────
async function fetchAndParseEq(url) {
  var xml = await fetchXML(url);
  if (!xml) return null;

  // 最大震度だけ素早く取得（スクリーニング用）
  var maxIntM = xml.match(/<MaxInt>([\s\S]*?)<\/MaxInt>/i)
             || xml.match(/<jmx_eb:Intensity>([\s\S]*?)<\/jmx_eb:Intensity>/i);
  var maxShindo = maxIntM ? shindoToNum(maxIntM[1].trim()) : 0;

  return { xml, maxShindo, parsed: null }; // parsed は必要時に計算
}

// ─── メイン ─────────────────────────────────────────────────────
async function main() {
  var ts  = nowJST();
  var now = new Date();
  console.log('[' + ts + '] 災害トリガーチェック開始');

  var cfg  = loadConfig();
  var data = loadProcessed();
  var processedIds = new Set(data.processed_ids || []);
  var newTriggers  = [];

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ① 地震チェック（eqvol.xml）
  //    トリガー検知 + earthquake-info.json への完全構造化データ保存
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  var bestEqInfo   = null;  // 今回取得した中で最大震度の地震情報
  var bestEqLevel  = 0;

  if (cfg.auto_shindo !== false) {
    var eqXml = await fetchXML(JMA_FEEDS.eqvol);
    var eqEntries = parseFeedEntries(eqXml);
    console.log('  地震フィード:', eqEntries.length, 'エントリー');

    // 「震源・震度に関する情報」のみ対象（最も詳細な電文）
    var eqInfoEntries = eqEntries.filter(function(e) {
      return e.title.indexOf('震源・震度') >= 0
          || e.title.indexOf('震度速報') >= 0;
    });

    // 未処理エントリーのみ処理
    var unprocessed = eqInfoEntries.filter(function(e) {
      return !processedIds.has(e.id);
    });

    for (var i = 0; i < unprocessed.length; i++) {
      var entry = unprocessed[i];

      // タイトルから震度を素早く判定
      var titleShindo = 0;
      var sm = entry.title.match(/震度([0-9０-９]+[弱強]?)/);
      if (sm) titleShindo = shindoToNum(sm[1]);

      // 閾値候補のみ電文を取得
      if (titleShindo >= cfg.auto_shindo - 0.5 || titleShindo === 0) {
        var result = await fetchAndParseEq(entry.url);
        if (!result) { processedIds.add(entry.id); continue; }

        var level = result.maxShindo;
        console.log('  [地震]', entry.title, '→ 震度', level, '(閾値:', cfg.auto_shindo, ')');

        // earthquake-info.json 用：最大震度の電文を保存候補とする
        if (level > bestEqLevel) {
          bestEqLevel = level;
          // 詳細解析（震度≥3 以上の電文のみ）
          if (level >= 3) {
            var parsed = parseEqXML(result.xml);
            if (parsed) bestEqInfo = parsed;
          }
        }

        // トリガー判定
        if (level >= cfg.auto_shindo) {
          var epicenter = '';
          var em = entry.title.match(/([^\s　（）()、。]+地|[^\s　（）()、。]+地方|[^\s　（）()、。]+沖|[^\s　（）()、。]+半島)/);
          if (em) epicenter = em[1];

          newTriggers.push({
            id:        entry.id,
            type:      'quake',
            dtype:     'quake',
            level:     level,
            title:     entry.title,
            epicenter: epicenter,
            maxShindo: level,
            detected:  ts,
            url:       entry.url,
          });
        }
      }
      processedIds.add(entry.id);
    }

    // earthquake-info.json を更新（震度3以上のデータがあれば）
    if (bestEqInfo) {
      var eqOutput = Object.assign({ generated: ts, source: 'jma_xml' }, bestEqInfo);
      fs.writeFileSync(EQ_INFO_PATH, JSON.stringify(eqOutput, null, 2), 'utf-8');
      console.log('  [earthquake-info] 更新 epicenter=', bestEqInfo.epicenter, 'maxShindo=', bestEqInfo.maxShindo);
    } else if (!fs.existsSync(EQ_INFO_PATH)) {
      // 初回実行時：空のプレースホルダーを作成
      fs.writeFileSync(EQ_INFO_PATH, JSON.stringify({
        generated: ts, source: 'jma_xml',
        time:'', epicenter:'', depth:'', magnitude:'', maxShindo:'',
        tsunami:'情報なし', shindoAreas:[], alertLevel:'normal', affectedPrefs:[],
      }, null, 2), 'utf-8');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ② 台風・大雨・大雪チェック（extra.xml）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  var exXml = await fetchXML(JMA_FEEDS.extra);
  var exEntries = parseFeedEntries(exXml);
  console.log('  随時フィード:', exEntries.length, 'エントリー');

  exEntries.forEach(function(entry) {
    if (processedIds.has(entry.id)) return;
    var t = entry.title;

    if (cfg.auto_typhoon &&
        t.indexOf('台風') >= 0 &&
        (t.indexOf('発生') >= 0 || t.indexOf('接近') >= 0 ||
         t.indexOf('上陸') >= 0 || t.indexOf('進路') >= 0 ||
         t.indexOf('暴風') >= 0 || t.indexOf('全般台風') >= 0)) {
      console.log('  [台風]', t);
      newTriggers.push({ id: entry.id, type: 'typhoon', dtype: 'typhoon', title: t, detected: ts, url: entry.url });
    }

    if (cfg.auto_rain &&
        (t.indexOf('大雨警報') >= 0 || t.indexOf('大雨特別警報') >= 0 ||
         t.indexOf('土砂災害警戒情報') >= 0 || t.indexOf('記録的短時間大雨') >= 0 ||
         t.indexOf('指定河川洪水予報') >= 0) &&
        t.indexOf('解除') < 0) {
      console.log('  [大雨]', t);
      newTriggers.push({ id: entry.id, type: 'rain', dtype: 'rain', title: t, detected: ts, url: entry.url });
    }

    if (cfg.auto_snow &&
        (t.indexOf('大雪警報') >= 0 || t.indexOf('大雪特別警報') >= 0) &&
        t.indexOf('解除') < 0) {
      console.log('  [大雪]', t);
      newTriggers.push({ id: entry.id, type: 'snow', dtype: 'snow', title: t, detected: ts, url: entry.url });
    }

    processedIds.add(entry.id);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ③ 特務機関NERV Mastodon RSSチェック（フォールバック）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  var nervFeeds = [
    { key: 'quake',   url: NERV_FEEDS.quake,   enabled: cfg.auto_shindo !== false },
    { key: 'typhoon', url: NERV_FEEDS.typhoon,  enabled: cfg.auto_typhoon },
    { key: 'all',     url: NERV_FEEDS.all,      enabled: true },
  ];

  for (var ni = 0; ni < nervFeeds.length; ni++) {
    var nf = nervFeeds[ni];
    if (!nf.enabled) continue;

    var nervXml   = await fetchXML(nf.url);
    var nervItems = parseRSSItems(nervXml);
    console.log('  NERV[' + nf.key + ']:', nervItems.length, '件');

    nervItems.forEach(function(item) {
      var nid = 'nerv:' + item.id;
      if (processedIds.has(nid)) return;
      processedIds.add(nid);
      var t = item.text;

      if (cfg.auto_shindo !== false) {
        var nsm = t.match(/最大震度[　\s]*([0-9０-９]+[弱強]?)/) || t.match(/震度[　\s]*([0-9０-９]+[弱強]?).*?(発生|地震|観測)/);
        if (nsm) {
          var nlevel = shindoToNum(nsm[1]);
          if (nlevel >= cfg.auto_shindo) {
            var alreadyQ = newTriggers.some(function(x){ return x.dtype === 'quake'; }) ||
                           (data.triggers||[]).some(function(x){ return x.dtype === 'quake' &&
                             new Date(x.detected.replace('+09:00','Z').replace(' ','T')) > new Date(now.getTime() - 24*3600000); });
            if (!alreadyQ) {
              console.log('  [NERV地震]', item.title, '→ 震度', nlevel);
              newTriggers.push({ id: nid, type: 'quake', dtype: 'quake', level: nlevel, maxShindo: nlevel, title: item.title, detected: ts, url: item.url, source: 'NERV' });
            }
          }
        }
      }

      if (cfg.auto_typhoon && nf.key !== 'quake') {
        if (t.indexOf('台風') >= 0 && (t.indexOf('発生') >= 0 || t.indexOf('接近') >= 0 || t.indexOf('上陸') >= 0 || t.indexOf('暴風') >= 0 || t.indexOf('台風情報') >= 0)) {
          var alreadyT = newTriggers.some(function(x){ return x.dtype === 'typhoon'; }) ||
                         (data.triggers||[]).some(function(x){ return x.dtype === 'typhoon' &&
                           new Date(x.detected.replace('+09:00','Z').replace(' ','T')) > new Date(now.getTime() - 24*3600000); });
          if (!alreadyT) {
            console.log('  [NERV台風]', item.title);
            newTriggers.push({ id: nid, type: 'typhoon', dtype: 'typhoon', title: item.title, detected: ts, url: item.url, source: 'NERV' });
          }
        }
      }

      if (cfg.auto_rain && nf.key !== 'quake' && nf.key !== 'typhoon') {
        if ((t.indexOf('大雨警報') >= 0 || t.indexOf('大雨特別警報') >= 0 || t.indexOf('土砂災害警戒情報') >= 0 || t.indexOf('記録的短時間大雨') >= 0) && t.indexOf('解除') < 0) {
          var alreadyR = newTriggers.some(function(x){ return x.dtype === 'rain'; }) ||
                         (data.triggers||[]).some(function(x){ return x.dtype === 'rain' &&
                           new Date(x.detected.replace('+09:00','Z').replace(' ','T')) > new Date(now.getTime() - 24*3600000); });
          if (!alreadyR) {
            console.log('  [NERV大雨]', item.title);
            newTriggers.push({ id: nid, type: 'rain', dtype: 'rain', title: item.title, detected: ts, url: item.url, source: 'NERV' });
          }
        }
      }

      if (cfg.auto_snow && nf.key !== 'quake' && nf.key !== 'typhoon') {
        if ((t.indexOf('大雪警報') >= 0 || t.indexOf('大雪特別警報') >= 0) && t.indexOf('解除') < 0) {
          var alreadyS = newTriggers.some(function(x){ return x.dtype === 'snow'; }) ||
                         (data.triggers||[]).some(function(x){ return x.dtype === 'snow' &&
                           new Date(x.detected.replace('+09:00','Z').replace(' ','T')) > new Date(now.getTime() - 24*3600000); });
          if (!alreadyS) {
            console.log('  [NERV大雪]', item.title);
            newTriggers.push({ id: nid, type: 'snow', dtype: 'snow', title: item.title, detected: ts, url: item.url, source: 'NERV' });
          }
        }
      }
    });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ④ 結果保存（disaster-trigger.json）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  var cutoff = new Date(now.getTime() - 24 * 3600000);
  var existingTriggers = (data.triggers || []).filter(function(t) {
    return new Date(t.detected.replace('+09:00','Z').replace(' ','T')) > cutoff;
  });

  newTriggers = newTriggers.filter(function(nt) {
    return !existingTriggers.some(function(et) { return et.dtype === nt.dtype; });
  });

  var allTriggers  = existingTriggers.concat(newTriggers);
  var processedArr = Array.from(processedIds).slice(-2000);

  fs.writeFileSync(TRIGGER_PATH, JSON.stringify({
    generated:     ts,
    triggers:      allTriggers,
    processed_ids: processedArr,
  }, null, 2), 'utf-8');

  if (newTriggers.length > 0) {
    console.log('[' + ts + '] 新規トリガー:', newTriggers.length, '件');
    newTriggers.forEach(function(t) { console.log('  >', t.type, '|', t.title); });
  } else {
    console.log('[' + ts + '] 新規トリガーなし');
  }
}

main().catch(function(e) {
  console.warn('[WARN] 予期しないエラー:', e.message);
  process.exit(0);
});
