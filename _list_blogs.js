// 인증된 계정의 블로그 목록 조회 (1회용)
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'client_secret.json'), 'utf8'));
const c = cs.installed || cs.web;
const oauth2 = new google.auth.OAuth2(c.client_id, c.client_secret, 'http://127.0.0.1:5117/oauth2cb');
oauth2.setCredentials(JSON.parse(fs.readFileSync(path.join(__dirname, 'token.json'), 'utf8')));

const blogger = google.blogger({ version: 'v3', auth: oauth2 });
blogger.blogs.listByUser({ userId: 'self' }).then(r => {
  const items = r.data.items || [];
  console.log('블로그 수:', items.length);
  for (const b of items) {
    console.log(JSON.stringify({ name: b.name, url: b.url, id: b.id }));
  }
}).catch(e => { console.error('실패:', e.message); process.exit(1); });
