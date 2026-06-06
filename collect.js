/**
 * collect.js  (v2 - X/RSS方式)
 *
 * NEXCO公式X（旧Twitter）アカウントの投稿を、無料のNitter/RSS変換サービス
 * 経由で取得し、「通行止め」を含む投稿から区間・時刻を抽出して
 * data/road-log.json に時系列で追記する。
 *
 * コスト：完全無料（GitHub Actions無料枠 + 無料RSS変換のみ。API不要）
 * 弱点：無料RSS変換サービスは不安定。複数を順番に試すフォールバック構造で対応。
 */

const fs   = require('fs');
const path = require('path');

let fetchFn;
try { fetchFn = globalThis.fetch || require('node-fetch'); }
catch (e) { fetchFn = require('node-fetch'); }

// ─── 監視対象のNEXCO公式Xアカウント ─────────────────────────────
// 地図に描画した全40路線をカバーするよう支社アカウントも追加
const ACCOUNTS = [
  // NEXCO東日本
  'e_nexco_bousai',   // 道路防災情報（最重要・災害時随時発信）
  'e_nexco_kanto',    // 関東支社（東名・中央・東北・関越・常磐・圏央）
  'e_nexco_tohoku',   // 東北支社（東北道・磐越道・日本海東北道・山形道・秋田道）
  'e_nexco_kita',     // 北海道支社（道央道・道東道・旭川道・函館江差道・深川留萌道）
  'e_nexco_niigata',  // 新潟支社（関越道・北陸道の新潟側・上信越道）
  // NEXCO中日本
  'c_nexco_official', // 本社（東名・新東名・中央・名神・新名神・東名阪・伊勢湾岸・上信越・北陸）
  // NEXCO西日本
  'w_nexco_official'  // 本社（山陽・中国・阪和・山陰・舞鶴若狭・九州・長崎・大分・宮崎・東九州・高松・徳島・高知・松山・沖縄）
];

// ─── 無料RSS変換サービス（順番に試す） ──────────────────────────
const RSS_PROVIDERS = [
  'https://nitter.poast.org/{user}/rss',
  'https://nitter.privacydev.net/{user}/rss',
  'https://nitter.net/{user}/rss',
  'https://rss-bridge.org/bridge01/?action=display&bridge=TwitterBridge&context=By+username&u={user}&format=Atom'
];

// ─── 監視対象路線（地図描画の40路線に対応） ─────────────────────
// ★ 路線名は投稿文内のキーワードとして使用するため、
//    実際の投稿で使われる略称・通称を優先する。
//    長い名称ほど先に書くことで誤マッチを防ぐ（例: '東名阪' を '東名' より先に）
const TARGET_ROADS = [
  // 関東・中部（東名系）
  '新東名', '東名阪', '東名',
  // 関東・中部（名神系）
  '新名神', '伊勢湾岸', '名神',
  // 関東・中部（その他）
  '西名阪', '名二環', '中央', '上信越', '長野',
  // 関東
  '関越', '東北', '常磐', '圏央', 'アクアライン', '東関東',
  // 北陸・日本海
  '北陸', '舞鶴若狭', '京都縦貫',
  // 東北・日本海
  '日本海東北', '磐越', '山形', '秋田',
  // 近畿・中国
  '山陽', '中国', '山陰', '阪和',
  // 四国
  '高松', '徳島', '高知', '松山',
  // 九州
  '東九州', '九州', '長崎', '大分', '宮崎',
  // 北海道
  '道央', '道東', '旭川紋別', '函館江差', '深川留萌',
  // 沖縄
  '沖縄'
];

async function fetchAccountRSS(user) {
  for (var i = 0; i < RSS_PROVIDERS.length; i++) {
    var url = RSS_PROVIDERS[i].replace('{user}', user);
    try {
      var opt = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RoadInfoBot/2.0)' } };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(12000);
      var res = await fetchFn(url, opt);
      if (!res.ok) { console.warn('  ' + user + ': ' + url + ' -> HTTP ' + res.status); continue; }
      var xml = await res.text();
      if (xml && xml.length > 200 && (xml.indexOf('<item') >= 0 || xml.indexOf('<entry') >= 0)) {
        console.log('  OK ' + user + ': ' + url + ' (' + xml.length + 'B)');
        return xml;
      }
    } catch (e) {
      console.warn('  ' + user + ': ' + url + ' -> ' + e.message);
    }
  }
  console.warn('  NG ' + user + ': 全プロバイダ失敗');
  return null;
}

function parseItems(xml) {
  var items = [];
  var blocks = xml.split(/<item[>\s]|<entry[>\s]/).slice(1);
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var title = extractTag(b, 'title');
    var desc  = extractTag(b, 'description') || extractTag(b, 'content');
    var date  = extractTag(b, 'pubDate') || extractTag(b, 'published') || extractTag(b, 'updated');
    var text  = stripHtml((title || '') + ' ' + (desc || ''));
    if (text.trim()) items.push({ text: text.trim(), date: date || '' });
  }
  return items;
}
function extractTag(block, tag) {
  var re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
  var m = block.match(re);
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, ' ')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'").replace(/\s+/g, ' ');
}

// E番号→路線名の対応表（NEXCO公式投稿では「E1 東名」「E1A 新東名」形式が多い）
var E_NUM_MAP = {
  'E1A':'新東名','E1':'東名','E2A':'中国','E2':'山陽',
  'E3':'九州','E4A':'山形','E4':'東北','E5A':'道東','E5':'道央',
  'E6':'常磐','E7':'日本海東北','E8':'北陸','E9':'山陰',
  'E10':'東九州','E17':'関越','E18':'上信越','E19':'中央','E20':'中央',
  'E23':'東名阪','E25':'西名阪','E26':'阪和','E27':'舞鶴若狭',
  'E34':'大分','E35':'長崎','E38':'高松','E42':'阪和',
  'E45':'秋田','E46':'秋田','E50':'東関東','E51':'東関東',
  'E67':'磐越','E74':'浜田','E80':'京都縦貫','E86':'松山','E87':'高知',
  'E88':'高知','E89':'京都縦貫'
};

function extractClosure(text, postDate) {
  if (!/通行止/.test(text)) return null;
  var road = '';
  // ① E番号から路線名を特定（優先）
  var eMatch = text.match(/\bE(\d+[A-Z]?)\b/);
  if (eMatch && E_NUM_MAP['E' + eMatch[1]]) {
    road = E_NUM_MAP['E' + eMatch[1]];
  }
  // ② キーワード照合（前後に漢字が続く場合は誤マッチとして除外）
  if (!road) {
    for (var i = 0; i < TARGET_ROADS.length; i++) {
      var kw = TARGET_ROADS[i];
      var idx = text.indexOf(kw);
      if (idx < 0) continue;
      // 直前文字が漢字の場合スキップ（例:「東九州」の「九州」を除外）
      var prev = idx > 0 ? text.charCodeAt(idx - 1) : 0;
      if (prev >= 0x4E00 && prev <= 0x9FFF) continue;
      road = kw;
      break;
    }
  }
  if (!road) return null;
  var section = '';
  var secMatch = text.match(/([^\s　]+(?:IC|JCT|PA|SA|入口|出口))\s*[〜～\-]\s*([^\s　]+(?:IC|JCT|PA|SA))/);
  if (secMatch) section = secMatch[1] + '〜' + secMatch[2];
  var direction = '';
  if (text.indexOf('上下線') >= 0) direction = '上下線';
  else if (text.indexOf('上り') >= 0) direction = '上り';
  else if (text.indexOf('下り') >= 0) direction = '下り';
  var isReleased = /解除/.test(text);
  var eventTime = '';
  var timeMatch = text.match(/(\d{1,2})[:：時](\d{1,2})/);
  if (timeMatch) eventTime = timeMatch[1].padStart(2, '0') + ':' + timeMatch[2].padStart(2, '0');
  var reason = '';
  if (/地震/.test(text)) reason = '地震';
  else if (/大雪|積雪|雪/.test(text)) reason = '大雪';
  else if (/台風|強風|暴風/.test(text)) reason = '台風';
  else if (/大雨|豪雨|冠水/.test(text)) reason = '大雨';
  else if (/火災/.test(text)) reason = '車両火災';
  else if (/事故/.test(text)) reason = '事故';
  else if (/工事/.test(text)) reason = '工事';
  return {
    road: road, section: section, direction: direction,
    status: isReleased ? '解除' : '通行止め',
    eventTime: eventTime, reason: reason,
    postDate: postDate || '', rawText: text.slice(0, 140)
  };
}

async function main() {
  var now = new Date();
  var jst = new Date(now.getTime() + 9 * 3600 * 1000);
  var ts  = jst.toISOString().replace('Z', '+09:00').slice(0, 19) + '+09:00';
  console.log('[' + ts + '] 収集開始（X/RSS方式）');

  var allClosures = [];
  for (var i = 0; i < ACCOUNTS.length; i++) {
    var acct = ACCOUNTS[i];
    var xml = await fetchAccountRSS(acct);
    if (!xml) continue;
    var items = parseItems(xml);
    console.log('  ' + acct + ': ' + items.length + '件の投稿');
    for (var j = 0; j < items.length; j++) {
      var c = extractClosure(items[j].text, items[j].date);
      if (c) { c.account = acct; allClosures.push(c); }
    }
  }
  console.log('  通行止め関連の投稿: ' + allClosures.length + '件');

  var logPath = path.join(__dirname, 'data', 'road-log.json');
  var log = [];
  if (fs.existsSync(logPath)) {
    try { log = JSON.parse(fs.readFileSync(logPath, 'utf-8')); } catch (e) { log = []; }
  }
  var cutoff = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  log = log.filter(function(e){ return new Date(e.ts) > cutoff; });

  var active = computeActive(allClosures);
  log.push({ ts: ts, closures: active, rawCount: allClosures.length });
  log.sort(function(a, b){ return a.ts.localeCompare(b.ts); });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');
  console.log('[' + ts + '] road-log.json 更新（全' + log.length + 'スナップショット、現在通行止め' + active.length + '件）');

  var summary = buildSummary(log);
  fs.writeFileSync(path.join(__dirname, 'data', 'road-log-summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log('road-log-summary.json 更新（通行止め期間' + summary.periods.length + '件）');
}

function computeActive(closures) {
  var released = {};
  for (var i = 0; i < closures.length; i++) {
    if (closures[i].status === '解除') released[closures[i].road + '|' + closures[i].section] = true;
  }
  var seen = {};
  var active = [];
  for (var i = 0; i < closures.length; i++) {
    var c = closures[i];
    if (c.status !== '通行止め') continue;
    var key = c.road + '|' + c.section;
    if (released[key]) continue;
    if (seen[key]) continue;
    seen[key] = true;
    active.push({ road: c.road, section: c.section, direction: c.direction, status: '通行止め', reason: c.reason, startTime: c.eventTime, source: c.account });
  }
  return active;
}

function buildSummary(log) {
  if (!log.length) return { generated: new Date().toISOString(), periods: [] };
  var snaps = log.map(function(e){
    var keys = {};
    (e.closures || []).forEach(function(c){ keys[c.road + '|' + c.section] = true; });
    return { ts: e.ts, keys: keys, closures: e.closures || [] };
  });
  var allKeys = {};
  snaps.forEach(function(s){ for (var k in s.keys) allKeys[k] = true; });
  var periods = [];
  for (var key in allKeys) {
    var parts = key.split('|');
    var road = parts[0], section = parts[1] || '';
    var appears = snaps.filter(function(s){ return s.keys[key]; });
    if (!appears.length) continue;
    var first = appears[0];
    var fc = first.closures.filter(function(c){ return c.road + '|' + c.section === key; })[0] || {};
    var last = appears[appears.length - 1];
    var lastSnap = snaps[snaps.length - 1];
    var ongoing = !!lastSnap.keys[key];
    periods.push({
      road: road, section: section, direction: fc.direction || '', reason: fc.reason || '',
      status: '通行止め', start: first.ts, end: ongoing ? null : last.ts,
      startTimeJST: fc.startTime || '', source: fc.source || '',
      snapshots: appears.map(function(s){
        var d = new Date(s.ts); var j = new Date(d.getTime() + 9 * 3600 * 1000);
        return j.getUTCHours() + ':' + String(j.getUTCMinutes()).padStart(2, '0');
      })
    });
  }
  periods.sort(function(a, b){ return a.start.localeCompare(b.start); });
  return { generated: new Date().toISOString(), periods: periods };
}

main().catch(function(e){ console.error('Fatal:', e); process.exit(1); });
