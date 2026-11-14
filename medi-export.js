// medi-export.js — 메디 칼럼 미리보기 HTML(사이트 스킨 근사) + 관리자 입력값 텍스트 보관본
const fs = require('fs');
const path = require('path');
const L = require('./medi-lib');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 사이트(medi.messeze.com) 글 페이지의 .article / .pcover 스타일을 그대로 옮긴 미리보기
// 발행기(medi-poster.js)와 같은 처리: 표를 <div class="tbl"> 로 감싼다. 미리보기도 발행된 화면과 같은 CSS 로 보여 준다.
function wrapTables(html) {
  return String(html).replace(/(<div class="tbl">\s*)?<table\b[\s\S]*?<\/table>(\s*<\/div>)?/gi, (m, pre) => (pre ? m : '<div class="tbl">' + m + '</div>'));
}

function renderHtml(it) {
  const p = (it && it.post) || {};
  const cover = p.photo ? `<img class="cover" src="${esc(String(p.photo).replace(/&amp;/g, '&'))}" alt="">` : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>[메디 미리보기] ${esc(p.title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@1.3.9/dist/web/static/pretendard.min.css">
<style>
:root{--ink:#0A1930;--navy:#12203F;--cobalt:#2B5CFF;--sky:#EEF3FF;--body:#4A5568}
*{box-sizing:border-box}body{margin:0;font-family:'Pretendard',system-ui,sans-serif;color:var(--ink);background:#fff;line-height:1.6}
.pv{max-width:860px;margin:18px auto 0;padding:0 20px}.pv span{display:inline-block;background:var(--sky);color:var(--cobalt);font-size:12px;font-weight:800;border-radius:999px;padding:5px 14px}
.head{max-width:860px;margin:14px auto 18px;padding:0 20px}.head .meta{color:#8B95A7;font-size:13.5px;margin-top:10px}.head h1{font-size:30px;line-height:1.4;letter-spacing:-.02em;margin:10px 0 0}
.pcover{max-width:860px;margin:0 auto;height:360px;border-radius:22px;position:relative;overflow:hidden;background:linear-gradient(135deg,#12203F,#4A6BFF)}
.pcover::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(16,31,63,.06) 42%,rgba(9,17,35,.55));z-index:1;pointer-events:none}
.cover{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
.tag{position:absolute;left:24px;bottom:20px;font-size:13px;font-weight:800;color:#fff;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.3);padding:7px 14px;border-radius:999px;z-index:2}
.article{max-width:720px;margin:0 auto;padding:46px 20px 10px}
.article p{font-size:16.5px;color:#333C4E;line-height:1.85;margin:0 0 26px}
.article h2{font-size:22px;margin:42px 0 16px;padding-top:8px}
.article h3{font-size:17px;margin:26px 0 8px}
.article b{color:var(--ink)}
.article blockquote{background:var(--sky);border-left:4px solid var(--cobalt);border-radius:0 14px 14px 0;padding:20px 24px;font-size:16px;color:var(--navy);line-height:1.75;margin:34px 0}
.tbl{overflow-x:auto;margin:30px 0}
.tbl table{width:100%;border-collapse:collapse;font-size:15px;min-width:480px}
.tbl th,.tbl td{border:1px solid #E5EAF2;padding:12px 14px;text-align:left;vertical-align:top;line-height:1.6}
.tbl th{background:#EAF1FF;font-weight:800;color:var(--ink)}
.foot{max-width:720px;margin:20px auto 50px;padding:0 20px;color:#8B95A7;font-size:12.5px}
</style></head><body>
<div class="pv"><span>발행 전 미리보기 · ${esc(it.status)}${it.warnings && it.warnings.length ? ' · 확인 ' + it.warnings.length + '건' : ''}</span></div>
<div class="head"><div class="meta">${esc(p.cat)} · ${esc(p.date)} · ${esc(p.slug)}${it.score ? ' · 채점 ' + esc(it.score) : ''}</div><h1>${esc(p.title)}</h1></div>
<div class="pcover">${cover}<span class="tag">${esc(p.cat)}</span></div>
<article class="article">${wrapTables(p.body || '')}</article>
<div class="foot">요약(목록 카드·검색 설명): ${esc(p.summary)}</div>
</body></html>`;
}

// 관리자 화면에 손으로 붙여 넣을 때 쓰는 입력값(자동 발행이 막혔을 때의 대비)
function fieldsTxt(it) {
  const p = it.post || {};
  return [
    `제목: ${p.title}`, `슬러그: ${p.slug}`, `분류: ${p.cat}`, `요약: ${p.summary}`,
    `대표 이미지: ${p.photo}`, `발행일: (비워 두면 공개 시 현재 시각)`, `상태: 비공개 → 확인 후 공개`,
    `SEO 제목: ${p.seoTitle || p.title}`, `SEO 설명: ${p.seoDesc || p.summary}`, '', '── 본문(HTML) ──', p.body || '',
  ].join('\n');
}

function exportPost(it) {
  try {
    const p = it.post || {};
    const dir = path.join(L.OUT_DIR(), p.date || new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, p.slug + '.html'), renderHtml(it), 'utf8');
    fs.writeFileSync(path.join(dir, p.slug + '.txt'), fieldsTxt(it), 'utf8');
    return dir;
  } catch { return ''; }
}

module.exports = { renderHtml, fieldsTxt, exportPost };
