// cli.js — 封装捆绑 CUPS CLI：lpstat / lp / cancel / lpadmin 并解析文本输出
'use strict';
const path = require('path');
const { execFile } = require('child_process');
const cups = require('./cups');

function bin(name) {
  const dir = ['lp', 'lpstat', 'cancel', 'lpoptions', 'lpq', 'lpr'].includes(name)
    ? path.join(cups.cupsPrefix, 'bin') : path.join(cups.cupsPrefix, 'sbin');
  return path.join(dir, name);
}
function env() {
  return Object.assign({}, process.env, {
    LD_LIBRARY_PATH: path.join(cups.cupsPrefix, 'lib'),
    CUPS_SERVERBIN: path.join(cups.cupsPrefix, 'lib', 'cups'),
    CUPS_DATADIR: path.join(cups.cupsPrefix, 'share', 'cups'),
  });
}
function run(name, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin(name), args, {
      env: env(), timeout: opts.timeout || 20000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').toString().trim();
        resolve({ ok: false, code: err.code || 1, msg, stdout: (stdout || '').toString() });
      } else {
        resolve({ ok: true, code: 0, msg: '', stdout: (stdout || '').toString() });
      }
    });
  });
}
const H = () => ['-h', `127.0.0.1:${cups.port}`];
async function printers() {
  const r = await run('lpstat', [...H(), '-p', '-d']);
  const lines = (r.stdout || '').split('\n').filter(Boolean);
  const list = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^printer\s+(\S+)\s+(.+)$/) || line.match(/^(\S+)\s+(.+)$/);
    if (line.startsWith('printer ') || (m && !line.startsWith('no system default'))) {
      if (m) {
        if (cur && cur.name !== m[1]) { list.push(cur); }
        cur = { name: m[1], stateText: m[2] };
      }
    } else if (line.startsWith('system default destination:')) {
      list.forEach(p => { p.isDefault = line.includes(p.name); });
    } else if (line.startsWith('no system default')) {
      list.forEach(p => { p.isDefault = false; });
    }
  }
  if (cur) list.push(cur);
  const d = await run('lpstat', [...H(), '-d']);
  const dflt = (d.stdout || '').match(/system default destination:\s*(\S+)/);
  list.forEach(p => { p.isDefault = dflt && dflt[1] === p.name; });
  return list;
}
async function printerUris() {
  const r = await run('lpstat', [...H(), '-v']);
  const map = {};
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^device for (\S+):\s*(\S+)/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}
async function printerDetail(name) {
  const p = await run('lpstat', [...H(), '-p', name]);
  const v = await run('lpstat', [...H(), '-v', name]);
  return { name, stateText: (p.stdout || '').trim(), deviceUri: (v.stdout || '').trim() };
}
async function jobs(filter = 'active') {
  const args = [...H(), '-W', filter, '-o'];
  if (filter === 'completed') args.push('-W', 'completed');
  const r = await run('lpstat', args);
  const out = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/)
      || line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (m) {
      out.push({ id: m[1], user: m[2], printer: m[3], size: m[4], time: m[5], status: m[6] || '', title: m[7] || '' });
    }
  }
  return out;
}
async function printFile(printer, filePath, title) {
  const args = [...H(), '-d', printer, '-t', title || '打印任务'];
  if (filePath) args.push(filePath);
  return run('lp', args);
}
async function cancelJob(jobId) { return run('cancel', [...H(), jobId]); }
async function jobAction(jobId, action) {
  const flag = { hold: 'hold', release: 'resume', restart: 'restart' }[action];
  if (!flag) return { ok: false, msg: '未知操作' };
  return run('lp', [...H(), '-H', flag, jobId]);
}
async function printerAction(name, action) {
  const map = { enable: ['cupsenable', [name]], disable: ['cupsdisable', [name]] };
  const [cmd, args] = map[action] || [];
  if (!cmd) return { ok: false, msg: '未知操作' };
  return run(cmd, [...H(), ...args]);
}
module.exports = {
  run, printers, printerUris, printerDetail, jobs, printFile, cancelJob, jobAction, printerAction,
};
