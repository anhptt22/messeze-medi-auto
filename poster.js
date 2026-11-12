// poster.js — Blogger API v3로 메세지 큐(queue.json) 글 게시(초안/공개).
// 윈차이나 poster.js와 동일 메커니즘(★슬러그 트릭: 발행 순간의 제목이 URL이 되므로
// 영문 슬러그 제목으로 발행 → 한글 제목 복원). OAuth 토큰은 blogauth.js로 1회 발급.
// ※ 검색 설명(메타)은 Blogger API로 입력 불가 — 발행 후 편집기에서 수동 입력(발행정보.txt 참조).
const fs = require('fs');
const path = require('path');

// googleapis: 로컬 node_modules 우선, 없으면 같은 머신의 다른 시스템 것 재사용
function requireGoogle() {
  const cands = ['googleapis'];
  for (const c of cands) { try { return require(c).google; } catch {} }
  throw new Error('googleapis 미설치 — 프로그램 폴더에서 npm install 을 실행하세요');
}

const TOKEN_FILE = path.join(__dirname, 'token.json');

function findClientSecret() {
  const f = fs.readdirSync(__dirname).find(n => /^client_secret.*\.json$/i.test(n) || n === 'credentials.json');
  return f ? path.join(__dirname, f) : null;
}
function apiReady() {
  try { requireGoogle(); } catch { return false; }
  return !!findClientSecret() && fs.existsSync(TOKEN_FILE);
}
function authClient() {
  const google = requireGoogle();
  const csPath = findClientSecret();
  if (!csPath) throw new Error('client_secret*.json 이 프로그램 폴더에 없습니다 (README 의 블로거 연동 참고).');
  const cs = JSON.parse(fs.readFileSync(csPath, 'utf8'));
  const c = cs.installed || cs.web;
  const oauth2 = new google.auth.OAuth2(c.client_id, c.client_secret, 'http://127.0.0.1:5117/oauth2cb');
  if (!fs.existsSync(TOKEN_FILE)) throw new Error('token.json 없음 — 먼저 node blogauth.js 로 메세지 구글 계정 인증(1회)이 필요합니다.');
  oauth2.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
  oauth2.on('tokens', (t) => {
    try {
      const cur = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...cur, ...t }, null, 2), 'utf8');
    } catch {}
  });
  return oauth2;
}
function bloggerApi() { const google = requireGoogle(); return google.blogger({ version: 'v3', auth: authClient() }); }

// 초안 등록(제목=한글 그대로 — 검토용)
async function insertDraft(blog, { title, html, labels }) {
  const api = bloggerApi();
  const res = await api.posts.insert({
    blogId: blog.blogId, isDraft: true,
    requestBody: { title, content: html, labels: (labels || []).slice(0, 20) },
  });
  return { id: res.data.id, url: res.data.url || '', status: 'DRAFT' };
}

// ★초안 → 공개 발행 + 커스텀 퍼머링크(슬러그 트릭)
async function publishWithSlug(blog, postId, slug, koreanTitle) {
  const api = bloggerApi();
  if (slug) await api.posts.patch({ blogId: blog.blogId, postId, requestBody: { title: slug.replace(/-/g, ' ') } });
  const pub = await api.posts.publish({ blogId: blog.blogId, postId });
  await api.posts.patch({ blogId: blog.blogId, postId, requestBody: { title: koreanTitle } });
  return { id: postId, url: pub.data.url, status: 'LIVE' };
}

// 초안 없이 바로 공개: 슬러그 제목으로 insert 후 제목 복원
async function insertPublish(blog, { title, html, labels, slug }) {
  const api = bloggerApi();
  const res = await api.posts.insert({
    blogId: blog.blogId, isDraft: false,
    requestBody: { title: slug ? slug.replace(/-/g, ' ') : title, content: html, labels: (labels || []).slice(0, 20) },
  });
  if (slug) await api.posts.patch({ blogId: blog.blogId, postId: res.data.id, requestBody: { title } });
  return { id: res.data.id, url: res.data.url, status: 'LIVE' };
}

module.exports = { apiReady, findClientSecret, TOKEN_FILE, bloggerApi, insertDraft, insertPublish, publishWithSlug };
