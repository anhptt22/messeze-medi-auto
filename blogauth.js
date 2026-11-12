// blogauth.js — Blogger API OAuth 1회 인증. 실행하면 브라우저가 열리고, 동의하면 token.json 저장.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
let google; try { ({ google } = require('googleapis')); } catch { console.log('googleapis 미설치 — 프로그램 폴더에서 npm install 을 실행하세요'); process.exit(2); }

const csName = fs.readdirSync(__dirname).find(n => /^client_secret.*\.json$/i.test(n) || n === 'credentials.json');
if (!csName) { console.log('★ client_secret*.json 파일을 프로그램 폴더에 먼저 넣으세요.'); process.exit(2); }
const cs = JSON.parse(fs.readFileSync(path.join(__dirname, csName), 'utf8'));
const c = cs.installed || cs.web;
const REDIRECT = 'http://127.0.0.1:5117/oauth2cb';
const oauth2 = new google.auth.OAuth2(c.client_id, c.client_secret, REDIRECT);

const url = oauth2.generateAuthUrl({
  access_type: 'offline', prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/blogger'],
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:5117');
  if (u.pathname !== '/oauth2cb') { res.end(); return; }
  const code = u.searchParams.get('code');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (!code) { res.end('인증 실패 — 다시 시도하세요.'); return; }
  res.end('<h2>인증 완료 — 이 창을 닫으세요.</h2>');
  try {
    const { tokens } = await oauth2.getToken(code);
    fs.writeFileSync(path.join(__dirname, 'token.json'), JSON.stringify(tokens, null, 2), 'utf8');
    console.log('token.json 저장 완료. 이제 게시가 가능합니다.');
  } catch (e) { console.error('토큰 교환 실패:', e.message); }
  server.close();
  process.exit(0);
});
server.listen(5117, '127.0.0.1', () => {
  console.log('브라우저에서 Google 동의 화면이 열립니다...');
  console.log('(자동으로 안 열리면 이 URL을 브라우저에 붙여넣기)\n' + url + '\n');
  spawn('powershell', ['-NoProfile', '-Command', `Start-Process "${url.replace(/"/g, '')}"`], { windowsHide: true, stdio: 'ignore' });
});
