// cups.js — CUPS 运行时管理：配置生成、进程启动、健康检查、SIGHUP 重载
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

let CUPS_DIR = null;
let CUPS_PREFIX = null;
let PORT = 6631;
let configDir, stateDir, spoolDir, logDir, ppdDir;

function resolveRoots() {
  const envDir = process.env.DATA_DIR || (process.env.TRIM_DATA_SHARE_PATHS || '')
    .split(':').map(s => s.trim()).filter(Boolean)[0];
  const dataRoot = envDir || path.join(process.env.APP_DIR || __dirname, 'data');
  CUPS_DIR = path.join(dataRoot, 'cups');
  configDir = path.join(CUPS_DIR, 'conf');
  stateDir = path.join(CUPS_DIR, 'state');
  spoolDir = path.join(CUPS_DIR, 'spool');
  logDir = path.join(CUPS_DIR, 'logs');
  ppdDir = path.join(configDir, 'ppd');
  CUPS_PREFIX = process.env.CUPS_PREFIX || path.join(__dirname, '..', 'cups');
  PORT = parseInt(process.env.CUPS_PORT || process.env.PC_PORT || '6631', 10);
}

const BIN = () => path.join(CUPS_PREFIX, 'sbin', 'cupsd');
const SERVERBIN = () => path.join(CUPS_PREFIX, 'lib', 'cups');
const DATADIR = () => path.join(CUPS_PREFIX, 'share', 'cups');
const LD = () => {
  const libs = [path.join(CUPS_PREFIX, 'lib'), path.join(CUPS_PREFIX, 'lib64')];
  return (process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH + ':' : '') + libs.join(':');
};

function ensureDirs() {
  for (const d of [configDir, stateDir, spoolDir, logDir, ppdDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function cupsdConfTemplate() {
  return `# PrintCenter cupsd.conf (generated)\nLogLevel ${getSetting('logLevel', 'info')}\nSystemGroup ${process.env.USER || 'root'}\nServerName localhost\nListen 127.0.0.1:${PORT}\nPort ${PORT}\nBrowsing ${getSetting('browsing', 'Off')}\nDefaultShared ${getSetting('defaultShared', 'Off')}\nPrintcapFormat none\nServerRoot ${configDir}\nStateDir ${stateDir}\nRequestRoot ${spoolDir}\nCacheDir ${stateDir}\nTempDir ${spoolDir}/tmp\nConfigFilePerm 0640\nLogFilePerm 0644\nAccessLog ${path.join(logDir, 'access_log')}\nErrorLog ${path.join(logDir, 'error_log')}\nPageLog ${path.join(logDir, 'page_log')}\nUser ${process.env.USER || 'root'}\nGroup ${process.env.USER || 'root'}\n<Policy default>\n  <Limit CUPS-Add-Modify-Printer CUPS-Delete-Printer CUPS-Set-Default Enable-Printer Disable-Printer Pause-Printer Resume-Printer Restart-Printer CUPS-Accept-Jobs CUPS-Reject-Jobs Cancel-Jobs Hold-New-Jobs Release-Held-New-Jobs Cancel-My-Jobs>\n    AuthType None\n  </Limit>\n</Policy>\n`;
}

let settings = {};
function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));
  } catch { settings = {}; }
}
function getSetting(k, def) { return settings[k] !== undefined ? settings[k] : def; }
function saveSettings() {
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

let proc = null;
let cupsdPid = null;
function cupsdRunning() {
  if (!cupsdPid) return false;
  try { process.kill(cupsdPid, 0); return true; } catch { cupsdPid = null; return false; }
}
function cupsdVersion() {
  try {
    const out = execFileSync(BIN(), ['--version'], { encoding: 'utf8', timeout: 15000 });
    const m = out.match(/CUPS v?([\d.]+)/i);
    return m ? m[1] : '?';
  } catch { return '?'; }
}

function startCupsd() {
  ensureDirs();
  loadSettings();
  fs.writeFileSync(path.join(configDir, 'cupsd.conf'), cupsdConfTemplate());
  if (!fs.existsSync(path.join(configDir, 'printers.conf'))) {
    fs.writeFileSync(path.join(configDir, 'printers.conf'), '# Printer configuration file for CUPS\n');
  }
  if (proc && cupsdRunning()) return { ok: true, already: true };
  const env = Object.assign({}, process.env, {
    LD_LIBRARY_PATH: LD(),
    CUPS_DATADIR: DATADIR(),
    CUPS_SERVERBIN: SERVERBIN(),
    PC_CUPS_SERVERBIN: SERVERBIN(),
    PC_CUPS_DATADIR: DATADIR(),
    PC_CUPS_REQUESTROOT: spoolDir,
    PC_CUPS_CACHEDIR: stateDir,
    PC_CUPS_STATEDIR: stateDir,
    PC_CUPS_ACCESSLOG: path.join(logDir, 'access_log'),
    PC_CUPS_ERRORLOG: path.join(logDir, 'error_log'),
    PC_CUPS_PAGELOG: path.join(logDir, 'page_log'),
    PC_CUPS_PRINTCAP: '/dev/null',
    TMPDIR: path.join(spoolDir, 'tmp'),
  });
  proc = spawn(BIN(), ['-c', path.join(configDir, 'cupsd.conf'), '-f'], {
    env, detached: false, stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout && proc.stdout.on('data', () => {});
  proc.stderr && proc.stderr.on('data', (d) => {
    try { fs.appendFileSync(path.join(logDir, 'cupsd_stderr.log'), d); } catch {}
  });
  proc.on('error', (err) => {
    try { fs.appendFileSync(path.join(logDir, 'cupsd_stderr.log'), 'spawn error: ' + err.message + '\n'); } catch {}
    cupsdPid = null;
  });
  proc.on('exit', () => { cupsdPid = null; });
  cupsdPid = proc.pid;
  return { ok: true, pid: proc.pid };
}
function stopCupsd() {
  if (cupsdPid) {
    try { process.kill(cupsdPid, 'SIGTERM'); } catch {}
    cupsdPid = null;
  }
}
function reloadCupsd() {
  if (cupsdPid) {
    try { process.kill(cupsdPid, 'SIGHUP'); return true; } catch { return false; }
  }
  return false;
}
function health() {
  return {
    running: cupsdRunning(),
    pid: cupsdPid,
    version: cupsdVersion(),
    port: PORT,
    configDir, stateDir, spoolDir,
    prefix: CUPS_PREFIX,
  };
}
module.exports = {
  resolveRoots, startCupsd, stopCupsd, reloadCupsd, health, cupsdRunning,
  getSetting, loadSettings, saveSettings, settings,
  get dirs() { return { CUPS_DIR, configDir, stateDir, spoolDir, logDir, ppdDir }; },
  get cupsPrefix() { return CUPS_PREFIX; },
  get port() { return PORT; },
};
