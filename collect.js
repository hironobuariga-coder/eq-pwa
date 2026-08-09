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

// ─── JST日付+時刻フォーマット ────────────────────────────────────
// UTC DateオブジェクトをJSTの「M/D HH:MM」文字列に変換
function fmtJST(d) {
  var j = new Date(d.getTime() + 9 * 3600 * 1000);
  var mo = j.getUTCMonth() + 1;
  var dd = j.getUTCDate();
  var hh = String(j.getUTCHours()).padStart(2, '0');
  var mm = String(j.getUTCMinutes()).padStart(2, '0');
  return mo + '/' + dd + ' ' + hh + ':' + mm;
}

// ─── 鮮度・状態管理の閾値 ────────────────────────────────────────
// 無料Nitterミラーは壊れていると「古いキャッシュ」をHTTP 200で返すことがあり、
// 数ヶ月前の投稿（例：冬の大雪通行止め）を「今の情報」として誤収集してしまう。
// これを防ぐため、投稿日時が新しいものだけを「今回の検知」として採用する。
var FRESH_WINDOW_MS  = 24 * 3600 * 1000; // これより古い投稿は「新規の検知情報」として信用しない
var CLOCK_SKEW_MS    = 15 * 60 * 1000;   // 未来日時の許容誤差（時刻ズレ対策）
// 一定時間、鮮度のある投稿で再確認できない通行止めは「解除ツイートが出ないまま
// 実際には解消された」とみなして自動的に一覧から外す（=ずっと通行止めのままに
// ならないようにする安全弁）。収集は1時間毎なので、数回分の欠測を許容する。
var STALE_TTL_MS     = 6 * 3600 * 1000;
// buildSummary()で「継続した1つの通行止め期間」とみなす最大の空白時間。
// これを超えて記録が途切れたら、再出現時は「別の通行止め」として扱う。
var SUMMARY_GAP_MS   = 150 * 60 * 1000;

// RSSの pubDate（RFC822）/ updated（ISO8601）を Date に変換。パース不能は null。
function parsePostDate(s) {
  if (!s) return null;
  var d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d;
}

// 通行止め／解除の「同一地点」を識別するキー。
// road+section が基本だが、section が取れない投稿も多いため、その場合は
// reason を補助的に使って衝突（別々の通行止めの混同）をできるだけ減らす。
function locKey(c) {
  var sec = (c.section || '').trim();
  if (sec) return c.road + '|' + sec;
  return c.road + '|#' + (c.reason || '');
}

// Node.js 18+ 組み込みの fetch を使用（追加パッケージ不要）
if (typeof globalThis.fetch === 'undefined') {
  console.error('fetch が利用できません。Node.js 18以上が必要です。');
  process.exit(1);
}
var fetchFn = globalThis.fetch.bind(globalThis);

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
  // IC/JCT名の前後のゴミ文字を除いた区間を抽出
  // 「白石IC〜平泉前沢IC」のような形式に限定（各IC名は15文字以内）
  var secMatch = text.match(/([^\s　（）()、。\uff0c]{1,15}(?:IC|JCT|PA|SA|入口|出口))\s*[〜～\-]\s*([^\s　（）()、。\uff0c]{1,15}(?:IC|JCT|PA|SA))/);
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

  var allClosures = [];   // 鮮度チェックを通過した「通行止め」投稿のみ
  var allReleases = [];   // 鮮度チェックを通過した「解除」投稿のみ
  var staleSkipped = 0, unparsedSkipped = 0;

  for (var i = 0; i < ACCOUNTS.length; i++) {
    var acct = ACCOUNTS[i];
    var xml = await fetchAccountRSS(acct);
    if (!xml) continue;
    var items = parseItems(xml);
    console.log('  ' + acct + ': ' + items.length + '件の投稿');
    for (var j = 0; j < items.length; j++) {
      var c = extractClosure(items[j].text, items[j].date);
      if (!c) continue;
      var pd = parsePostDate(items[j].date);
      // 投稿日時が読み取れない、または古すぎる／未来すぎる投稿は
      // 「壊れたNitterミラーが返す古いキャッシュ」の可能性が高いため除外する。
      if (!pd) { unparsedSkipped++; continue; }
      var age = now.getTime() - pd.getTime();
      if (age > FRESH_WINDOW_MS || age < -CLOCK_SKEW_MS) { staleSkipped++; continue; }
      c.account = acct;
      c.postDate = pd.toISOString();
      if (c.status === '解除') allReleases.push(c); else allClosures.push(c);
    }
  }
  console.log('  通行止め関連の投稿: 通行止め' + allClosures.length + '件 / 解除' + allReleases.length + '件'
    + '（鮮度NGで除外: 古い/未来' + staleSkipped + '件、日時不明' + unparsedSkipped + '件）');

  // ── 永続状態（road-state.json）の更新 ─────────────────────────
  // road-log.json は24時間で切り詰められるため「開始時刻」の記録用には使えない。
  // ここでは「今も通行止めが続いている場所」を key 単位で永続管理し、
  // ①鮮度のある投稿で再確認できた分は継続、②解除投稿があれば即削除、
  // ③一定時間(TTL)再確認できなかった分は「解除ツイートが無いまま解消された」
  //   とみなして自動的に外す。これにより「ずっと通行止めのまま残り続ける」事象を防ぐ。
  var statePath = path.join(__dirname, 'data', 'road-state.json');
  var state = { active: {} };
  if (fs.existsSync(statePath)) {
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch (e) { state = { active: {} }; }
  }
  if (!state.active) state.active = {};

  // 解除が確認できた場所を先に消す（同時に、今回バッチ内での解除キー集合も作る）
  var releasedThisRun = {};
  for (var r = 0; r < allReleases.length; r++) {
    var rk = locKey(allReleases[r]);
    releasedThisRun[rk] = true;
    if (state.active[rk]) delete state.active[rk];
  }

  // 今回の通行止め投稿ごとに、同一キーの重複を除いて最新情報を保持
  // （同じ投稿バッチ内に解除ツイートも含まれていた場合はスキップ＝閉じたまま扱わない）
  for (var k = 0; k < allClosures.length; k++) {
    var c = allClosures[k];
    var key = locKey(c);
    if (releasedThisRun[key]) continue;
    var existing = state.active[key];
    if (existing) {
      // 継続確認：最終確認時刻とその他の付帯情報（区間・方向・理由など）を更新
      existing.lastSeenTs = c.postDate;
      existing.direction  = c.direction || existing.direction;
      existing.reason     = c.reason || existing.reason;
      existing.startTime  = c.eventTime || existing.startTime;
      existing.source     = c.account;
      existing.section    = c.section || existing.section;
    } else {
      state.active[key] = {
        road: c.road, section: c.section, direction: c.direction, reason: c.reason,
        firstSeenTs: c.postDate, lastSeenTs: c.postDate,
        startTime: c.eventTime, source: c.account
      };
    }
  }

  // TTL切れ（一定時間、鮮度のある投稿で再確認できなかった）を自動解除
  var expiredKeys = [];
  for (var key2 in state.active) {
    var e = state.active[key2];
    var lastSeen = new Date(e.lastSeenTs).getTime();
    if (now.getTime() - lastSeen > STALE_TTL_MS) expiredKeys.push(key2);
  }
  expiredKeys.forEach(function(k){ delete state.active[k]; });
  if (expiredKeys.length) console.log('  TTL切れで自動解除: ' + expiredKeys.length + '件（' + expiredKeys.join(', ') + '）');

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');

  var active = Object.keys(state.active).map(function(k){
    var e = state.active[k];
    return {
      road: e.road, section: e.section, direction: e.direction, status: '通行止め',
      reason: e.reason, startTime: e.startTime, source: e.source,
      firstSeenTs: e.firstSeenTs, lastSeenTs: e.lastSeenTs
    };
  });

  // ── road-log.json（直近24時間のスナップショット履歴） ───────────
  var logPath = path.join(__dirname, 'data', 'road-log.json');
  var log = [];
  if (fs.existsSync(logPath)) {
    try { log = JSON.parse(fs.readFileSync(logPath, 'utf-8')); } catch (e) { log = []; }
  }
  var cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
  log = log.filter(function(e){ return new Date(e.ts) > cutoff; });

  log.push({ ts: ts, closures: active, rawCount: allClosures.length });
  log.sort(function(a, b){ return a.ts.localeCompare(b.ts); });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');
  console.log('[' + ts + '] road-log.json 更新（全' + log.length + 'スナップショット、現在通行止め' + active.length + '件）');

  var summary = buildSummary(log);
  fs.writeFileSync(path.join(__dirname, 'data', 'road-log-summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  console.log('road-log-summary.json 更新（通行止め期間' + summary.periods.length + '件）');
}

// road-log.json（直近24時間のスナップショット列）から、通行止めの「期間」を組み立てる。
// ポイント：同じ場所（road-state.jsonのkeyと同じlocKey）が一度記録から消え、
// 一定時間（SUMMARY_GAP_MS）を超えてから再び現れた場合は「別の通行止め期間」として
// 分割する。これにより、一度解除されて再度通行止めになったケースが
// 「ずっと通行止めが続いている」ように連結表示されるのを防ぐ。
function buildSummary(log) {
  if (!log.length) return { generated: new Date().toISOString(), periods: [] };
  var snaps = log.map(function(e){
    var byKey = {};
    (e.closures || []).forEach(function(c){ byKey[locKey(c)] = c; });
    return { ts: e.ts, byKey: byKey };
  });
  var allKeys = {};
  snaps.forEach(function(s){ for (var k in s.byKey) allKeys[k] = true; });
  var lastSnapTs = snaps[snaps.length - 1].ts;

  var periods = [];
  for (var key in allKeys) {
    // このキーが登場するスナップショットだけを時系列で抽出
    var appears = [];
    for (var i = 0; i < snaps.length; i++) {
      if (snaps[i].byKey[key]) appears.push(snaps[i]);
    }
    if (!appears.length) continue;

    // 出現間隔が SUMMARY_GAP_MS を超えたら別期間に分割
    var groups = [[appears[0]]];
    for (var i2 = 1; i2 < appears.length; i2++) {
      var prevTs = new Date(appears[i2 - 1].ts).getTime();
      var curTs  = new Date(appears[i2].ts).getTime();
      if (curTs - prevTs > SUMMARY_GAP_MS) groups.push([appears[i2]]);
      else groups[groups.length - 1].push(appears[i2]);
    }

    groups.forEach(function(g){
      var first = g[0], last = g[g.length - 1];
      var fc = first.byKey[key], lc = last.byKey[key];
      var ongoing = last.ts === lastSnapTs; // 最新スナップショットまで途切れず続いている
      // 開始時刻は road-state.json 由来の firstSeenTs（24時間ロールオーバーの影響を受けない）
      // があれば優先し、無ければスナップショット時刻にフォールバックする。
      var startTs = fc.firstSeenTs || first.ts;
      var endTs = ongoing ? null : (lc.lastSeenTs || last.ts);
      periods.push({
        road: fc.road, section: fc.section || '', direction: fc.direction || '', reason: fc.reason || '',
        status: '通行止め', start: startTs, end: endTs,
        startJST: fmtJST(new Date(startTs)),
        endJST:   endTs ? fmtJST(new Date(endTs)) : null,
        startTimeJST: fc.startTime || '', source: lc.source || fc.source || '',
        snapshots: g.map(function(s){ return fmtJST(new Date(s.ts)); })
      });
    });
  }
  periods.sort(function(a, b){ return a.start.localeCompare(b.start); });
  return { generated: new Date().toISOString(), periods: periods };
}

main().catch(function(e){
  console.warn('[WARN] 予期しないエラー（外部要因の可能性）:', e.message);
  process.exit(0);
});
