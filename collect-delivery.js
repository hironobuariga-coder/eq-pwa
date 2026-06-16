/**
 * collect-delivery.js
 *
 * ヤマト運輸・佐川急便の公式ページから遅延・制限情報を取得し
 * data/delivery-status.json に保存する。
 *
 * 実行：GitHub Actions（毎時）または手動
 * コスト：完全無料（Claude API 不使用）
 *
 * 【取得方法】
 *   ① 各社の公式お知らせページを fetch で取得
 *   ② テキストから「遅延・停止・制限・影響」キーワードを検索
 *   ③ 該当件数・内容をまとめて JSON に保存
 *
 * 【ステータス定義】
 *   normal    : 通常通り（遅延・制限なし）
 *   partial   : 一部地域で遅延・制限あり
 *   suspended : 広範囲で停止・大幅遅延
 */

'use strict';

const fs   = require('fs');
const path = require('path');

if (typeof globalThis.fetch === 'undefined') {
  console.error('fetch が利用できません。Node.js 18以上が必要です。');
  process.exit(1);
}
const fetchFn = globalThis.fetch.bind(globalThis);

const OUTPUT_PATH = path.join(__dirname, 'data', 'delivery-status.json');

// ─── JST タイムスタンプ ─────────────────────────────────────────
function nowJST() {
  var jst = new Date(Date.now() + 9 * 3600000);
  var Y  = jst.getUTCFullYear();
  var Mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  var D  = String(jst.getUTCDate()).padStart(2, '0');
  var H  = String(jst.getUTCHours()).padStart(2, '0');
  var Mi = String(jst.getUTCMinutes()).padStart(2, '0');
  return Y + '/' + Mo + '/' + D + ' ' + H + ':' + Mi + ' JST';
}

// ─── HTML 取得ヘルパー ────────────────────────────────────────────
async function fetchPage(url) {
  try {
    var res = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DeliveryInfoBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (!res.ok) {
      console.warn('HTTP', res.status, url);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn('fetch error:', e.message, url);
    return null;
  }
}

// HTML タグ除去・整形
function stripHTML(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#[0-9]+;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── キーワード判定 ──────────────────────────────────────────────
const STOP_WORDS    = ['停止', '中止', '不能', '全面', '全域停止'];
const PARTIAL_WORDS = ['遅延', '遅れ', '一部', '制限', '影響', '停止中', '見合わせ', '休止', '集荷停止'];
const NORMAL_WORDS  = ['平常', '通常通り', '影響なし', '解除'];

// テキストからステータスと概要を判定
function detectStatus(text, siteName) {
  if (!text) return { status: 'normal', detail: '取得不可', notices: [] };

  // お知らせ行を抽出（改行・句点区切りで100文字以上のブロックは不要）
  var lines = text.split(/[\n。]+/).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 10 && s.length < 200; });

  // 災害・遅延関連の行だけ抽出
  var impactWords = STOP_WORDS.concat(PARTIAL_WORDS).concat(['地震', '台風', '大雨', '大雪', '警報', '災害', '荒天']);
  var notices = lines.filter(function(line) {
    return impactWords.some(function(w) { return line.indexOf(w) >= 0; });
  }).slice(0, 5);

  // ステータス判定
  var hasStop    = STOP_WORDS.some(function(w)    { return text.indexOf(w) >= 0; });
  var hasPartial = PARTIAL_WORDS.some(function(w)  { return text.indexOf(w) >= 0; });
  var hasNormal  = NORMAL_WORDS.some(function(w)   { return text.indexOf(w) >= 0; });

  var status = 'normal';
  var detail = siteName + '：現時点でWeb上に遅延・制限情報の掲載なし';

  if (hasStop && !hasNormal) {
    status = 'suspended';
    detail = notices.length ? notices.join(' / ') : siteName + '：広範囲で集配停止中';
  } else if (hasPartial) {
    status = 'partial';
    detail = notices.length ? notices.join(' / ') : siteName + '：一部地域で遅延・制限あり';
  }

  return { status: status, detail: detail, notices: notices };
}

// ─── ヤマト運輸 ────────────────────────────────────────────────
async function fetchYamato() {
  console.log('  [ヤマト] 取得中...');
  var url = 'https://www.kuronekoyamato.co.jp/ytc/chien/chien_hp.html';
  var html = await fetchPage(url);

  // フォールバック: トップから遅延ページを探す
  if (!html) {
    html = await fetchPage('https://www.kuronekoyamato.co.jp/');
    // トップで遅延リンクを探す
    if (html) {
      var linkMatch = html.match(/href="([^"]*chien[^"]*)"/i) ||
                      html.match(/href="([^"]*delay[^"]*)"/i) ||
                      html.match(/href="([^"]*jyouhou[^"]*)"/i);
      if (linkMatch) {
        var altUrl = linkMatch[1].startsWith('http') ? linkMatch[1] : 'https://www.kuronekoyamato.co.jp' + linkMatch[1];
        html = await fetchPage(altUrl);
        if (html) url = altUrl;
      }
    }
  }

  var text = stripHTML(html);
  var result = detectStatus(text, 'ヤマト運輸');
  result.url = url;
  console.log('  [ヤマト] status=', result.status, ' notices=', result.notices.length);
  return result;
}

// ─── 佐川急便 ─────────────────────────────────────────────────
async function fetchSagawa() {
  console.log('  [佐川] 取得中...');
  var url = 'https://www2.sagawa-exp.co.jp/information/list/';
  var html = await fetchPage(url);

  // フォールバック
  if (!html) {
    html = await fetchPage('https://www.sagawa-exp.co.jp/');
    if (html) {
      var linkMatch = html.match(/href="([^"]*information[^"]*)"/i) ||
                      html.match(/href="([^"]*notice[^"]*)"/i) ||
                      html.match(/href="([^"]*news[^"]*)"/i);
      if (linkMatch) {
        var altUrl = linkMatch[1].startsWith('http') ? linkMatch[1] : 'https://www.sagawa-exp.co.jp' + linkMatch[1];
        html = await fetchPage(altUrl);
        if (html) url = altUrl;
      }
    }
  }

  var text = stripHTML(html);
  var result = detectStatus(text, '佐川急便');
  result.url = url;
  console.log('  [佐川] status=', result.status, ' notices=', result.notices.length);
  return result;
}

// ─── メイン ─────────────────────────────────────────────────────
async function main() {
  var ts = nowJST();
  console.log('[' + ts + '] 配送会社情報収集開始');

  var yamato = await fetchYamato();
  var sagawa = await fetchSagawa();

  var output = {
    generated: ts,
    yamato: {
      status:  yamato.status,
      detail:  yamato.detail,
      updated: ts,
      url:     yamato.url,
      notices: yamato.notices,
    },
    sagawa: {
      status:  sagawa.status,
      detail:  sagawa.detail,
      updated: ts,
      url:     sagawa.url,
      notices: sagawa.notices,
    },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log('[' + ts + '] 保存完了 → data/delivery-status.json');
  console.log('  ヤマト:', output.yamato.status, '/ 佐川:', output.sagawa.status);
}

main().catch(function(e) {
  console.warn('[WARN] 予期しないエラー:', e.message);
  // エラーでも空ファイルを残して Actions を正常終了
  var ts = nowJST();
  var fallback = {
    generated: ts,
    yamato: { status: 'normal', detail: 'データ取得失敗 — 公式サイトをご確認ください', updated: ts, url: 'https://www.kuronekoyamato.co.jp/ytc/chien/chien_hp.html', notices: [] },
    sagawa: { status: 'normal', detail: 'データ取得失敗 — 公式サイトをご確認ください', updated: ts, url: 'https://www2.sagawa-exp.co.jp/information/list/', notices: [] },
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(fallback, null, 2), 'utf-8');
  process.exit(0);
});
