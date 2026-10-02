// printers-conf.js — printers.conf 配置仓库：解析/增删改 + SIGHUP 重载
'use strict';
const fs = require('fs');
const path = require('path');
const cups = require('./cups');

const FILE = () => path.join(cups.dirs.configDir, 'printers.conf');
function parse() {
  const text = fs.readFileSync(FILE(), 'utf8');
  const blocks = [];
  const lines = text.split('\n');
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^<Printer\s+(\S+)>/.test(line)) {
      cur = { name: line.match(/^<Printer\s+(\S+)>/)[1], attrs: {} };
      blocks.push(cur);
    } else if (cur && /^<\/Printer>/.test(line)) {
      cur = null;
    } else if (cur && line && !line.startsWith('#')) {
      const idx = line.indexOf(' ');
      if (idx > 0) {
        const k = line.slice(0, idx);
        const v = line.slice(idx + 1);
        if (cur.attrs[k] !== undefined) {
          if (!Array.isArray(cur.attrs[k])) cur.attrs[k] = [cur.attrs[k]];
          cur.attrs[k].push(v);
        } else cur.attrs[k] = v;
      }
    }
  }
  return { blocks, nextId: parseInt((text.match(/NextPrinterId\s+(\d+)/) || [])[1] || '1', 10) };
}
function serialize(data) {
  const head = '# Printer configuration file for CUPS\n# Written by PrintCenter\n';
  let out = head;
  out += `NextPrinterId ${data.nextId}\n`;
  for (const b of data.blocks) {
    out += `\n<Printer ${b.name}>\n`;
    if (b.attrs.PrinterId) out += `PrinterId ${b.attrs.PrinterId}\n`;
    if (b.attrs.UUID) out += `UUID ${b.attrs.UUID}\n`;
    const order = ['Info', 'Location', 'MakeModel', 'DeviceURI', 'State', 'StateTime',
      'StateMessage', 'Accepting', 'Shared', 'JobSheets', 'QuotaPeriod', 'PageLimit',
      'KLimit', 'OpPolicy', 'ErrorPolicy'];
    for (const k of order) {
      if (b.attrs[k] !== undefined) out += `${k} ${b.attrs[k]}\n`;
    }
    for (const k of Object.keys(b.attrs)) {
      if (!order.includes(k) && k !== 'PrinterId' && k !== 'UUID') {
        const v = b.attrs[k];
        if (Array.isArray(v)) v.forEach(x => out += `${k} ${x}\n`);
        else out += `${k} ${v}\n`;
      }
    }
    out += '</Printer>\n';
  }
  return out;
}
function genUuid() {
  const crypto = require('crypto');
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function persist(blocks, nextId) {
  fs.writeFileSync(FILE(), serialize({ blocks, nextId }));
  return cups.reloadCupsd();
}
function get(name) {
  const { blocks } = parse();
  return blocks.find(b => b.name === name) || null;
}
function list() { return parse().blocks; }
function upsert(spec) {
  const data = parse();
  let block = data.blocks.find(b => b.name === spec.name);
  if (!block) {
    block = { name: spec.name, attrs: { PrinterId: data.nextId, UUID: genUuid() } };
    data.nextId += 1;
    data.blocks.push(block);
  }
  const a = block.attrs;
  if (spec.uri !== undefined) a.DeviceURI = spec.uri;
  if (spec.driver !== undefined) a.MakeModel = spec.driver;
  if (spec.info !== undefined) a.Info = spec.info;
  if (spec.location !== undefined) a.Location = spec.location;
  if (spec.shared !== undefined) a.Shared = spec.shared ? 'Yes' : 'No';
  if (spec.accepting !== undefined) a.Accepting = spec.accepting ? 'Yes' : 'No';
  a.State = a.State || 'Idle';
  a.StateTime = a.StateTime || String(Math.floor(Date.now() / 1000));
  a.OpPolicy = 'default';
  a.ErrorPolicy = 'retry-job';
  a.JobSheets = a.JobSheets || 'none none';
  persist(data.blocks, data.nextId);
  return block;
}
function remove(name) {
  const data = parse();
  const idx = data.blocks.findIndex(b => b.name === name);
  if (idx < 0) return { ok: false, msg: '打印机不存在' };
  data.blocks.splice(idx, 1);
  persist(data.blocks, data.nextId);
  try { fs.unlinkSync(path.join(cups.dirs.ppdDir, `${name}.ppd`)); } catch {}
  return { ok: true };
}
function setDefault(name) {
  const cf = path.join(cups.dirs.configDir, 'cupsd.conf');
  let text = fs.readFileSync(cf, 'utf8');
  text = text.replace(/^(DefaultPrinter\s+.*)$/m, '');
  text += `\nDefaultPrinter ${name}\n`;
  fs.writeFileSync(cf, text);
  return cups.reloadCupsd();
}
function setDefaultFlag(name, isDefault) {
  if (isDefault) return setDefault(name);
  const cf = path.join(cups.dirs.configDir, 'cupsd.conf');
  let text = fs.readFileSync(cf, 'utf8');
  text = text.replace(/^DefaultPrinter\s+\S+$/m, '');
  fs.writeFileSync(cf, text);
  return cups.reloadCupsd();
}
module.exports = { parse, serialize, get, list, upsert, remove, setDefault, setDefaultFlag, genUuid };
