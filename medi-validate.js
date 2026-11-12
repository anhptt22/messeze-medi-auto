// medi-validate.js — 메디 칼럼 형식 검증기 (기존 메디 글 3편에서 뽑은 규격, 프롬프트의 [본문 형식 명세]와 같은 수치)
// errors = 규격 위반(재작성 대상) · warns = 규격에서 조금 벗어남(눈으로 확인)
// CLI: node medi-validate.js <slug>   (queue_medi.json 의 글 검사)
const EXPECT = ['p', 'h2', 'p', 'table', 'h2', 'p', 'h2', 'p', 'blockquote', 'h2', 'h3', 'p', 'h3', 'p'];
const txt = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const nospace = (s) => String(s || '').replace(/\s+/g, '');
const sentences = (s) => (String(s).match(/[.?!](?:\s|$|[’”'"])/g) || []).length || (String(s).trim() ? 1 : 0);
const inR = (v, a, b) => v >= a && v <= b;

function blocks(body) {
  const out = [];
  const re = /<(p|h2|h3|blockquote|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body))) out.push({ tag: m[1].toLowerCase(), html: m[0], inner: m[2], text: txt(m[2]) });
  return out;
}

function validate(post) {
  const errors = [], warns = [];
  const p = post || {};
  const E_ = (m) => errors.push(m), W_ = (m) => warns.push(m);
  const title = String(p.title || ''), summary = String(p.summary || p.desc || ''), slug = String(p.slug || '');
  const body = String(p.body || '');

  // ── 메타 ──
  if (!/^hospital(-[a-z0-9]+){2,8}$/.test(slug) || slug.length > 70) E_(`slug 형식: hospital- 뒤에 영단어 2~8개, 70자 이내, 소문자-하이픈 (현재 "${slug}")`);
  if (!inR(title.length, 22, 50)) E_(`제목 길이 ${title.length}자 (질문표 질문 26~48자 기준)`); else if (!inR(title.length, 26, 48)) W_(`제목 ${title.length}자 — 26~48자 밖`);
  if (!/\?$/.test(title.trim())) E_('제목은 질문형 + 물음표(?)로 끝나야 합니다');
  if (!inR(summary.length, 75, 110)) E_(`요약 길이 ${summary.length}자 (규격 85~100자)`); else if (!inR(summary.length, 85, 100)) W_(`요약 ${summary.length}자 — 규격 85~100자 밖`);
  if (sentences(summary) !== 2) W_(`요약 문장 수 ${sentences(summary)} (규격 2문장)`);
  if (!/정리했습니다\.?$/.test(summary.trim())) W_('요약 끝이 "~정리했습니다." 가 아닙니다');
  if (!p.cat) E_('분류(cat) 없음');
  if (!/^https:\/\/images\.(pexels|unsplash)\.com\//.test(String(p.photo || ''))) E_('커버 사진(photo) 주소가 없거나 형식 오류');

  // ── 블록 순서 ──
  const bl = blocks(body);
  const seq = bl.map(b => b.tag);
  if (seq.join(',') !== EXPECT.join(',')) {
    E_(`블록 순서 불일치 — 규격: ${EXPECT.join(' ')} / 현재: ${seq.join(' ')}`);
  }
  if (/<(ul|ol|img|script|style|iframe)\b/i.test(body)) E_('허용되지 않는 태그(ul/ol/img/script/style)가 있습니다');
  if (/\s(?:class|style)=/i.test(body)) E_('class/style 속성은 쓸 수 없습니다');

  // ── 길이(구조가 맞을 때만 세부 점검) ──
  const total = nospace(txt(body)).length;
  if (!inR(total, 550, 1100)) E_(`본문 ${total}자 (규격 650~900자, 공백 제외)`); else if (!inR(total, 650, 900)) W_(`본문 ${total}자 — 규격 650~900자 밖`);
  if (seq.join(',') === EXPECT.join(',')) {
    const [intro, h1, p1, tb, h2b, p2, h3b, p3, bq, hf, q1, a1, q2, a2] = bl;
    if (sentences(intro.text) !== 2) W_(`도입 문장 수 ${sentences(intro.text)} (규격 2문장)`);
    if (!inR(intro.text.length, 85, 140)) W_(`도입 ${intro.text.length}자 (규격 100~120자)`);
    for (const [i, h] of [h1, h2b, h3b].entries()) if (!inR(h.text.length, 6, 28)) W_(`소제목${i + 1} ${h.text.length}자 (규격 8~25자)`);
    if (hf.text !== '자주 묻는 질문') E_('FAQ 소제목은 "자주 묻는 질문" 이어야 합니다');
    for (const [i, pp] of [p1, p2, p3].entries()) {
      const s = sentences(pp.text);
      if (s < 2 || s > 3) E_(`섹션${i + 1} 문단 문장 수 ${s} (규격 2문장, 많아야 3)`);
      if (!inR(pp.text.length, 80, 150)) W_(`섹션${i + 1} 문단 ${pp.text.length}자 (규격 95~130자)`);
    }
    // 표
    const th = (tb.html.match(/<th\b/gi) || []).length;
    const bodyRows = ((tb.html.match(/<tbody[\s\S]*<\/tbody>/i) || [tb.html])[0].match(/<tr\b/gi) || []).length;
    const cols = (tb.html.match(/<tr\b[\s\S]*?<\/tr>/i) || [''])[0].match(/<t[hd]\b/gi);
    const nCols = cols ? cols.length : th;
    if (!inR(nCols, 2, 3)) E_(`표 열 ${nCols}개 (규격 2~3열)`);
    if (!inR(bodyRows, 4, 5)) E_(`표 데이터 행 ${bodyRows}개 (규격 4~5행)`);
    const cells = [...tb.html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => txt(m[1]));
    const longCell = cells.find(c => c.length > 42 || /니다\.?$/.test(c));
    if (longCell) W_(`표 셀이 문장처럼 깁니다(첫 열 2~8자, 나머지 5~25자 구, 길어도 40자): "${longCell.slice(0, 30)}"`);
    // 인용 블록
    if (!inR(bq.text.length, 40, 80)) W_(`blockquote ${bq.text.length}자 (규격 55~65자)`);
    if (sentences(bq.text) !== 1) W_(`blockquote 문장 수 ${sentences(bq.text)} (규격 1문장)`);
    // FAQ
    for (const [i, [q, a]] of [[q1, a1], [q2, a2]].entries()) {
      if (!/^Q\.\s/.test(q.text) || !/\?$/.test(q.text)) E_(`FAQ ${i + 1} 질문 형식: "Q. …?" (현재 "${q.text.slice(0, 30)}")`);
      if (!inR(q.text.length, 10, 34)) W_(`FAQ ${i + 1} 질문 ${q.text.length}자 (규격 16~28자)`);
      const s = sentences(a.text);
      if (s < 1 || s > 2) W_(`FAQ ${i + 1} 답변 문장 수 ${s} (규격 1~2문장)`);
      if (!inR(a.text.length, 40, 125)) W_(`FAQ ${i + 1} 답변 ${a.text.length}자 (규격 55~100자)`);
    }
  }

  // ── 문체·금지어 ──
  const plain = txt(body);
  const ban = [
    [/원장님|귀원|저희|여러분/, '본문에 "원장님/귀원/저희/여러분" 금지(병원은 3인칭)'],
    [/!/, '느낌표 금지'],
    [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, '이모지 금지'],
    [/최고|1위|무조건|확실히|반드시 (?:나옵니다|노출)/, '최상급·단정 표현 금지'],
    [/환불|기자 3,?000|베이직|프리미엄|엔터프라이즈/, '환불 문구·본 사이트 플랜명 혼입 금지'],
    [/후기|치료 효과를 보장|완치/, '후기·효과 보장 표현 확인 필요(후기는 "권하지 않습니다" 문맥만 허용)'],
  ];
  for (const [re, msg] of ban) if (re.test(plain)) {
    // "후기" 는 부정 문맥 허용 → 경고로만
    if (/후기/.test(msg)) { if (/후기/.test(plain) && !/(제한|권하지|쓰지)/.test(plain)) W_(msg); } else E_(msg);
  }
  if (/\d+\s*%/.test(plain)) E_('퍼센트(%) 수치 금지 — 통계를 쓰지 않습니다');
  if (/\d{3,}/.test(plain.replace(/\d{1,2}시/g, ''))) W_('세 자리 이상 숫자가 있습니다 — 통계·출처 확인');
  const links = [...body.matchAll(/<a\b[^>]*href="([^"]+)"/gi)].map(m => m[1]);
  if (links.length > 1) E_(`링크 ${links.length}개 (규격 최대 1개)`);
  for (const h of links) if (!/^https:\/\/medi\.messeze\.com\//.test(h)) E_('메디 사이트 밖 링크 금지: ' + h);
  const dupBold = (body.match(/<b>/gi) || []).length; if (dupBold > 2) W_('<b> 강조가 많습니다(blockquote 안 1개 권장)');
  return { errors, warns, stats: { total, blocks: seq.length } };
}

module.exports = { validate, blocks, EXPECT };

if (require.main === module) {
  const slug = process.argv[2];
  const fs = require('fs'), path = require('path');
  let q = { posts: [] };
  try { q = JSON.parse(fs.readFileSync(path.join(__dirname, 'queue_medi.json'), 'utf8')); } catch {}
  const it = (q.posts || []).find(x => x.post && x.post.slug === slug);
  if (!it) { console.log('큐에서 글을 찾지 못했습니다: ' + slug); process.exit(1); }
  const r = validate(it.post);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.errors.length ? 2 : 0);
}
