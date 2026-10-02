// server.js — 打印中心后端：CUPS 管理 REST API + 登录 + 静态前端
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');

const cups = require('./cups');
const cli = require('./cli');
const conf = require('./printers-conf');
const auth = require('./auth');

cups.resolveRoots();
try { cups.startCupsd(); } catch (e) { console.error('[PrintCenter] cupsd 启动失败（不影响登录）：', e && e.message || e); }

const app = express();
app.use(express.json({ limit: '4mb', type: () => true }));
app.use((req, res, next) => {
  if (!req.body || typeof req.body !== 'object') req.body = {};
  next();
});

const GATEWAY_PREFIX = (process.env.GATEWAY_PREFIX || '').replace(/\/+$/, '');
if (GATEWAY_PREFIX) {
  app.use((req, res, next) => {
    if (req.url === GATEWAY_PREFIX) req.url = '/';
    else if (req.url.startsWith(GATEWAY_PREFIX + '/')) req.url = req.url.slice(GATEWAY_PREFIX.length);
    next();
  });
}

const FRONT = path.join(__dirname, 'public');
app.use(express.static(FRONT));

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 100 * 1024 * 1024 } });

function needAuth(req, res, next) {
  if (!auth.auth(req)) return res.status(401).json({ ok: false, msg: '未登录或会话过期' });
  next();
}
function needSuper(req, res, next) {
  const s = auth.auth(req);
  if (!s) return res.status(401).json({ ok: false, msg: '未登录或会话过期' });
  if (auth.loadUsers()[s.user].role !== 'super') return res.status(403).json({ ok: false, msg: '需要管理员权限' });
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, msg: '缺少用户名或密码' });
  const r = auth.login(username, password);
  if (!r) return res.status(401).json({ ok: false, msg: '用户名或密码错误' });
  res.json({ ok: true, ...r });
});
app.post('/api/logout', (req, res) => {
  const h = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  auth.logout(h);
  res.json({ ok: true });
});
app.get('/api/me', needAuth, (req, res) => {
  const s = auth.auth(req);
  res.json({ ok: true, ...auth.sanitize(s.user) });
});
app.post('/api/password', needAuth, (req, res) => {
  const s = auth.auth(req);
  const r = auth.changePassword(s.user, req.body.old, req.body.now);
  res.json(r);
});
app.get('/api/users', needSuper, (req, res) => res.json({ ok: true, users: auth.listUsers() }));
app.post('/api/users', needSuper, (req, res) => {
  const { username, password, role, name } = req.body || {};
  res.json(auth.addUser(username, password, role, name));
});
app.delete('/api/users/:name', needSuper, (req, res) => res.json(auth.deleteUser(req.params.name)));

app.get('/api/status', needAuth, (req, res) => {
  res.json({ ok: true, ...cups.health() });
});

app.get('/api/printers', needAuth, async (req, res) => {
  try {
    const list = await cli.printers();
    const uris = await cli.printerUris();
    const blocks = conf.list();
    const out = list.map(p => {
      const b = blocks.find(x => x.name === p.name);
      return {
        name: p.name,
        stateText: p.stateText,
        isDefault: !!p.isDefault,
        deviceUri: uris[p.name] || (b && b.attrs.DeviceURI) || '',
        info: b && b.attrs.Info || '',
        location: b && b.attrs.Location || '',
        driver: b && b.attrs.MakeModel || '',
        shared: b ? b.attrs.Shared === 'Yes' : false,
        accepting: b ? b.attrs.Accepting !== 'No' : true,
        raw: b ? b.attrs : {},
      };
    });
    res.json({ ok: true, printers: out, default: list.find(p => p.isDefault)?.name || null });
  } catch (e) {
    res.status(500).json({ ok: false, msg: String(e && e.message || e) });
  }
});

const MODEL_RE = /^\*ModelName:\s*"([^"]+)"/m;
function ppdModel(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4096);
    const m = head.match(MODEL_RE);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
app.get('/api/drivers', needAuth, (req, res) => {
  const map = new Map();
  for (const p of collectPpds()) {
    const file = path.basename(p).replace(/\.ppd$/i, '');
    if (!map.has(file)) map.set(file, ppdModel(p));
  }
  const drivers = [...map.entries()].map(([file, model]) => ({ file, model }))
    .sort((a, b) => (a.model || a.file).localeCompare(b.model || b.file, 'zh-CN'));
  res.json({ ok: true, drivers });
});

app.post('/api/printers', needAuth, (req, res) => {
  const { name, uri, driver, info, location, shared, accepting } = req.body || {};
  if (!name || !/^[\w\-]{1,127}$/.test(name)) return res.status(400).json({ ok: false, msg: '打印机名称不合法（字母数字-_）' });
  if (!uri) return res.status(400).json({ ok: false, msg: '缺少连接地址 (URI)' });
  try {
    const ppdSrc = findPpd(driver || 'Generic-PDF_Printer-PDF');
    if (ppdSrc) fs.copyFileSync(ppdSrc, path.join(cups.dirs.ppdDir, `${name}.ppd`));
  } catch (e) {}
  const block = conf.upsert({
    name, uri, driver: driver || 'Generic-PDF_Printer-PDF', info, location,
    shared: shared !== false, accepting: accepting !== false,
  });
  res.json({ ok: true, printer: block.name });
});

app.put('/api/printers/:name', needAuth, (req, res) => {
  const { uri, driver, info, location, shared, accepting } = req.body || {};
  try {
    if (driver) {
      const ppdSrc = findPpd(driver);
      if (ppdSrc) fs.copyFileSync(ppdSrc, path.join(cups.dirs.ppdDir, `${req.params.name}.ppd`));
    }
    const b = conf.upsert({ name: req.params.name, uri, driver, info, location, shared, accepting });
    res.json({ ok: true, printer: b.name });
  } catch (e) {
    res.status(400).json({ ok: false, msg: String(e && e.message || e) });
  }
});

app.delete('/api/printers/:name', needAuth, (req, res) => {
  res.json(conf.remove(req.params.name));
});

app.post('/api/printers/:name/default', needAuth, (req, res) => {
  res.json(conf.setDefaultFlag(req.params.name, true));
});
app.delete('/api/printers/:name/default', needAuth, (req, res) => {
  res.json(conf.setDefaultFlag(req.params.name, false));
});

app.post('/api/printers/:name/enable', needAuth, async (req, res) => {
  res.json(await cli.printerAction(req.params.name, 'enable'));
});
app.post('/api/printers/:name/disable', needAuth, async (req, res) => {
  res.json(await cli.printerAction(req.params.name, 'disable'));
});

app.post('/api/printers/:name/test', needAuth, async (req, res) => {
  const tmp = path.join(os.tmpdir(), `pc-test-${Date.now()}.txt`);
  const host = os.hostname();
  const content = `打印中心 测试页\n===============\n\n打印机：${req.params.name}\n主机：${host}\n时间：${new Date().toLocaleString('zh-CN')}\n\n如果您能看到本页，说明打印机工作正常。\n\n— 打印中心 PrintCenter\n`;
  fs.writeFileSync(tmp, content);
  try {
    const r = await cli.printFile(req.params.name, tmp, '打印中心测试页');
    res.json(r);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
});

app.post('/api/print', needAuth, upload.single('file'), async (req, res) => {
  const { printer, title } = req.body || {};
  if (!printer) return res.status(400).json({ ok: false, msg: '缺少打印机' });
  if (!req.file) return res.status(400).json({ ok: false, msg: '缺少文件' });
  const r = await cli.printFile(printer, req.file.path, title || req.file.originalname || '打印任务');
  try { fs.unlinkSync(req.file.path); } catch {}
  res.json(r);
});

app.get('/api/jobs', needAuth, async (req, res) => {
  const filter = req.query.filter || 'active';
  try {
    const active = await cli.jobs('active');
    let completed = [];
    if (filter === 'all' || filter === 'completed') completed = await cli.jobs('completed');
    const all = filter === 'completed' ? completed : [...active, ...(filter === 'all' ? completed : [])];
    res.json({ ok: true, jobs: all });
  } catch (e) {
    res.status(500).json({ ok: false, msg: String(e && e.message || e) });
  }
});

app.post('/api/jobs/:id/cancel', needAuth, async (req, res) => res.json(await cli.cancelJob(req.params.id)));
app.post('/api/jobs/:id/hold', needAuth, async (req, res) => res.json(await cli.jobAction(req.params.id, 'hold')));
app.post('/api/jobs/:id/release', needAuth, async (req, res) => res.json(await cli.jobAction(req.params.id, 'release')));
app.post('/api/jobs/:id/restart', needAuth, async (req, res) => res.json(await cli.jobAction(req.params.id, 'restart')));

app.post('/api/jobs/cancel-all', needAuth, async (req, res) => {
  const active = await cli.jobs('active');
  for (const j of active) await cli.cancelJob(j.id);
  res.json({ ok: true, cancelled: active.length });
});

app.get('/api/settings', needAuth, (req, res) => {
  res.json({
    ok: true,
    settings: {
      port: cups.port,
      logLevel: cups.getSetting('logLevel', 'info'),
      browsing: cups.getSetting('browsing', 'Off'),
      defaultShared: cups.getSetting('defaultShared', 'Off'),
      dataDir: cups.dirs.CUPS_DIR,
      cupsPrefix: cups.cupsPrefix,
    },
  });
});
app.put('/api/settings', needAuth, async (req, res) => {
  const { logLevel, browsing, defaultShared } = req.body || {};
  const s = cups.settings;
  if (logLevel) s.logLevel = logLevel;
  if (browsing !== undefined) s.browsing = browsing ? 'On' : 'Off';
  if (defaultShared !== undefined) s.defaultShared = defaultShared ? 'On' : 'Off';
  cups.saveSettings();
  cups.stopCupsd();
  await new Promise(r => setTimeout(r, 500));
  cups.startCupsd();
  res.json({ ok: true });
});

function collectPpds() {
  const roots = [
    path.join(cups.cupsPrefix, 'share', 'cups', 'model'),
    path.join(cups.cupsPrefix, 'share', 'ppd'),
  ];
  const out = [];
  const walk = (dir) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p);
      else if (it.name.toLowerCase().endsWith('.ppd')) out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

function findPpd(driver) {
  const target = driver.endsWith('.ppd') ? driver : driver + '.ppd';
  const hit = collectPpds().find(p => path.basename(p).toLowerCase() === target.toLowerCase());
  return hit || null;
}

app.use((err, req, res, next) => {
  try { fs.appendFileSync(path.join(cups.dirs.logDir, 'api_error.log'), new Date().toISOString() + ' ' + req.method + ' ' + req.url + ' -> ' + (err && err.message || err) + '\n'); } catch {}
  res.status(500).json({ ok: false, msg: '服务内部错误：' + (err && err.message || err) });
});

const PORT = process.env.PC_HTTP_PORT || 3001;
const SOCKET_PATH = process.env.SOCKET_PATH || '';

if (SOCKET_PATH) {
  try { fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true }); } catch {}
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  app.listen(SOCKET_PATH, () => {
    console.log(`[PrintCenter] listening on socket ${SOCKET_PATH}${GATEWAY_PREFIX ? ' prefix ' + GATEWAY_PREFIX : ''}`);
  });
}
app.listen(PORT, () => {
  console.log(`[PrintCenter] API listening on :${PORT}`);
  console.log(`[PrintCenter] CUPS prefix=${cups.cupsPrefix} port=${cups.port}`);
});
