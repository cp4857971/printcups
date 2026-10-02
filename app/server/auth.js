// auth.js — 简单登录会话（admin/admin 默认，可改）
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cups = require('./cups');

const FILE = () => path.join(cups.dirs.configDir, 'users.json');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    const users = { admin: { password: 'admin', role: 'super', name: '超级管理员' } };
    saveUsers(users);
    return users;
  }
}
function saveUsers(users) { fs.writeFileSync(FILE(), JSON.stringify(users, null, 2), { mode: 0o600 }); }
function sanitize(u) { return { username: u, role: loadUsers()[u].role, name: loadUsers()[u].name }; }
const sessions = new Map();
function login(username, password) {
  const users = loadUsers();
  const u = users[username];
  if (!u || u.password !== password) return null;
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { user: username, exp: Date.now() + 7 * 24 * 3600 * 1000 });
  return { token, ...sanitize(username) };
}
function auth(req) {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '');
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return s;
}
function changePassword(username, oldPw, newPw) {
  const users = loadUsers();
  const u = users[username];
  if (!u) return { ok: false, msg: '用户不存在' };
  if (u.password !== oldPw) return { ok: false, msg: '原密码错误' };
  if (!newPw || newPw.length < 4) return { ok: false, msg: '新密码至少 4 位' };
  u.password = newPw;
  saveUsers(users);
  return { ok: true };
}
function logout(token) { sessions.delete(token); }
function addUser(username, password, role, name) {
  const users = loadUsers();
  if (users[username]) return { ok: false, msg: '用户名已存在' };
  if (!password || password.length < 4) return { ok: false, msg: '密码至少 4 位' };
  users[username] = { password, role: role === 'admin' ? 'admin' : 'operator', name: name || username };
  saveUsers(users);
  return { ok: true };
}
function deleteUser(username) {
  if (username === 'admin') return { ok: false, msg: '不能删除超管' };
  const users = loadUsers();
  if (!users[username]) return { ok: false, msg: '用户不存在' };
  delete users[username];
  saveUsers(users);
  return { ok: true };
}
function listUsers() {
  return Object.entries(loadUsers()).map(([u, v]) => ({ username: u, role: v.role, name: v.name }));
}
module.exports = { login, auth, logout, changePassword, addUser, deleteUser, listUsers, sanitize };
