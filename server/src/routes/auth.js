const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { knex } = require('../db/schema');
const { signToken, requireAuth, requireRole, HQ_ROLES } = require('../middleware/auth');
const { logAudit } = require('../auditLog');

// 로그인 무차별 대입 방어 — 이메일 기준 5회 연속 실패 시 15분 잠금 (단일 프로세스 메모리 기반이라
// 여러 인스턴스로 띄우면 인스턴스별로 따로 센다는 한계는 있음, 지금 배포 형태에서는 이 정도로 충분)
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // email -> { count, lockedUntil, lastAttemptAt }

function getLoginState(email) {
  const state = loginAttempts.get(email);
  if (state?.lockedUntil && state.lockedUntil < Date.now()) {
    loginAttempts.delete(email);
    return null;
  }
  return state || null;
}

// 잠기지 않은 채로 남은 항목(존재하지 않는 이메일로 계속 실패시키면 count<5인 항목이 영원히
// 안 지워짐)이 쌓여 메모리를 갉아먹지 않도록 주기적으로 정리. 잠금 시간이 지난 뒤 조회되면
// getLoginState에서 지워지지만, 조회가 없으면 그마저도 안 일어나므로 별도 스윕이 필요함
const LOGIN_ATTEMPTS_CLEANUP_MS = LOGIN_LOCKOUT_MS;
// 정상 트래픽에서는 절대 도달하지 않을 값 — 대량의 서로 다른 이메일로 스윕 주기 안에 들어오는
// 공격까지 잡기 위한 최후 안전장치 (잠금이 걸린 계정은 건드리지 않아 정상 사용자 보호는 그대로 유지)
const LOGIN_ATTEMPTS_MAX_SIZE = 20000;

function cleanupLoginAttempts() {
  const now = Date.now();
  for (const [email, state] of loginAttempts) {
    if (state.lockedUntil && state.lockedUntil >= now) continue; // 잠긴 계정은 잠금이 우회되지 않도록 유지
    if (now - (state.lastAttemptAt || 0) >= LOGIN_LOCKOUT_MS) loginAttempts.delete(email);
  }
  if (loginAttempts.size > LOGIN_ATTEMPTS_MAX_SIZE) {
    for (const [email, state] of loginAttempts) {
      if (loginAttempts.size <= LOGIN_ATTEMPTS_MAX_SIZE) break;
      if (!state.lockedUntil || state.lockedUntil < now) loginAttempts.delete(email);
    }
  }
}

// 미존재 이메일은 bcrypt 없이 즉시 반환돼 응답 시간 차이만으로 계정 존재 여부를 알아낼 수 있었다.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-equalisation', 10);

try {
  const cleanupTimer = setInterval(() => {
    try { cleanupLoginAttempts(); } catch (e) { console.error('로그인 시도 기록 정리 오류:', e); }
  }, LOGIN_ATTEMPTS_CLEANUP_MS);
  cleanupTimer.unref(); // 이 타이머 때문에 프로세스 종료가 늦어지면 안 됨
} catch (e) {
  console.error('로그인 시도 기록 정리 타이머 등록 실패:', e);
}

// 로그인
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요' });
    }
    // 카운터 키가 이메일 원문이라 `Foo@x.com`/`foo@x.com`을 번갈아 쓰면 잠금을 무한히 우회할 수 있었다.
    // 사용자 조회 쿼리 자체는 건드리지 않는다 — 대소문자 정책을 바꾸면 기존 계정 로그인이 깨진다.
    const attemptKey = String(email).trim().toLowerCase();
    const state = getLoginState(attemptKey);
    if (state?.lockedUntil) {
      const minutesLeft = Math.ceil((state.lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `로그인 시도가 너무 많습니다. ${minutesLeft}분 후 다시 시도해주세요` });
    }

    // 로그인 응답에 매장명이 없어 로그인 직후 첫 재고부족 팝업에 매장명이 비어 떴다.
    const user = await knex('users as u')
      .leftJoin('stores as s', 'u.store_id', 's.id')
      .select('u.*', 's.name as store_name')
      .where({ 'u.email': email, 'u.is_active': true }).first();
    // 소셜/초대 계정처럼 해시가 비어 있으면 `bcrypt.compare(password, null)`이 throw해 500이 났다.
    const ok = (user && user.password_hash) ? await bcrypt.compare(password, user.password_hash) : (await bcrypt.compare(password, DUMMY_HASH), false);
    if (!ok) {
      const next = { count: (state?.count || 0) + 1, lastAttemptAt: Date.now() };
      if (next.count >= MAX_LOGIN_ATTEMPTS) next.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
      loginAttempts.set(attemptKey, next);
      return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' });
    }
    loginAttempts.delete(attemptKey);

    const token = signToken(user);
    const { password_hash, ...userInfo } = user;
    res.json({ token, user: userInfo });
  } catch (err) {
    // DB 오류 메시지 등 내부 정보가 그대로 브라우저에 노출되지 않도록 콘솔에만 상세 로그를 남김
    console.error('로그인 처리 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// 내 정보
router.get('/me', requireAuth, async (req, res) => {
  const user = await knex('users as u')
    .leftJoin('stores as s', 'u.store_id', 's.id')
    .select('u.*', 's.name as store_name')
    .where('u.id', req.user.id).first();
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  const { password_hash, ...userInfo } = user;
  res.json(userInfo);
});

// 사용자 목록 (HQ 전용)
router.get('/users', requireAuth, requireRole('SUPER_ADMIN', 'HQ_ADMIN'), async (req, res) => {
  const users = await knex('users')
    .where({ brand_id: req.user.brand_id })
    .select('id', 'name', 'email', 'role', 'store_id', 'is_active', 'created_at')
    .orderBy('created_at');
  res.json(users);
});

// 사용자 생성
router.post('/users', requireAuth, requireRole('SUPER_ADMIN', 'HQ_ADMIN'), async (req, res) => {
  try {
    const { name, email, password, role, store_id } = req.body;
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
    }
    if (role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: '최고관리자만 최고관리자 계정을 생성할 수 있습니다' });
    }
    // 가맹점 역할은 가맹점이 지정되지 않으면 재고/주문 조회 필터가 무력화되어 다른 가맹점 데이터까지 보일 수 있음
    if (['STORE_OWNER', 'STORE_STAFF'].includes(role || 'STORE_OWNER') && !store_id) {
      return res.status(400).json({ error: '가맹점 역할(점주/직원)은 소속 가맹점을 반드시 지정해야 합니다' });
    }
    // email이 DB에서 unique라 insert 시점에도 걸러지긴 하지만, 그 경우 드라이버(sqlite/pg)마다
    // 다른 제약 위반 에러가 그대로 노출될 위험이 있어 미리 확인해서 사용자가 고칠 수 있는 안내를 줌
    const emailTaken = await knex('users').where({ email }).first();
    if (emailTaken) {
      return res.status(400).json({ error: '이미 사용 중인 이메일입니다' });
    }
    const hash = await bcrypt.hash(password, 10);
    const [{ id }] = await knex('users').insert({
      brand_id: req.user.brand_id,
      store_id: store_id || null,
      name, email,
      password_hash: hash,
      role: role || 'STORE_OWNER',
    }).returning('id');
    await logAudit(req.user.brand_id, req.user.id, 'USER', id, 'CREATE', null, { name, email, role: role || 'STORE_OWNER', store_id: store_id || null });
    res.json({ id });
  } catch (err) {
    // 위 사전 확인과 실제 insert 사이의 동시 요청으로 유니크 제약에 걸리는 경우의 대비책 —
    // 그 외 원인 불명 오류는 테이블/컬럼명 등 DB 구조가 드러나지 않도록 일반 메시지로 통일.
    // knex 에러 메시지에는 실행된 SQL 전문(컬럼 목록 포함)이 그대로 들어있어서, email이 아닌
    // 다른 제약(예: store_id FK) 위반이어도 insert 문에 email 컬럼이 있으면 메시지에 "email"이
    // 찍힌다 — 그래서 "email"만으로는 안 되고 실제로 unique 제약 위반인지까지 같이 확인해야 함
    const msg = err?.message || '';
    const isUniqueViolation = err?.code === '23505' || (err?.code === 'SQLITE_CONSTRAINT' && /unique constraint failed/i.test(msg));
    if (isUniqueViolation && /email/i.test(msg)) {
      return res.status(400).json({ error: '이미 사용 중인 이메일입니다' });
    }
    console.error('사용자 생성 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  }
});

// 사용자 수정
router.put('/users/:id', requireAuth, requireRole('SUPER_ADMIN', 'HQ_ADMIN'), async (req, res) => {
  const existing = await knex('users').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!existing) return res.status(404).json({ error: '없음' });
  const { name, role, store_id, is_active, password } = req.body;
  if (password && (typeof password !== 'string' || password.length < 8)) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
  }
  if (role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: '최고관리자만 최고관리자 권한을 부여할 수 있습니다' });
  }
  // 위 체크는 "새로 SUPER_ADMIN 권한을 부여하는 것"만 막고 있었음 — 이미 SUPER_ADMIN인 계정을
  // HQ_ADMIN이 강등/비활성화/비밀번호 변경하는 경로는 안 막혀있어서, 권한이 더 낮은 HQ_ADMIN이
  // 최고관리자 계정을 무력화할 수 있는 권한 역전 문제가 있었음
  if (existing.role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: '최고관리자 계정은 최고관리자만 수정할 수 있습니다' });
  }
  const nextRole = role ?? existing.role;
  const nextStoreId = store_id !== undefined ? (store_id || null) : existing.store_id;
  if (['STORE_OWNER', 'STORE_STAFF'].includes(nextRole) && !nextStoreId) {
    return res.status(400).json({ error: '가맹점 역할(점주/직원)은 소속 가맹점을 반드시 지정해야 합니다' });
  }
  const update = {
    name: name ?? existing.name,
    role: nextRole,
    store_id: nextStoreId,
    is_active: is_active !== undefined ? is_active : existing.is_active,
  };
  if (password) update.password_hash = await bcrypt.hash(password, 10);
  await knex('users').where({ id: req.params.id, brand_id: req.user.brand_id }).update(update);
  await logAudit(req.user.brand_id, req.user.id, 'USER', existing.id, 'UPDATE',
    { name: existing.name, role: existing.role, store_id: existing.store_id, is_active: existing.is_active },
    { name: update.name, role: update.role, store_id: update.store_id, is_active: update.is_active });
  res.json({ ok: true });
});

// 사용자 삭제
router.delete('/users/:id', requireAuth, requireRole('SUPER_ADMIN', 'HQ_ADMIN'), async (req, res) => {
  const existing = await knex('users').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!existing) return res.status(404).json({ error: '없음' });
  // PUT과 동일한 이유 — HQ_ADMIN이 SUPER_ADMIN 계정을 삭제할 수 있게 열려있던 권한 역전 문제
  if (existing.role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: '최고관리자 계정은 최고관리자만 삭제할 수 있습니다' });
  }
  await knex('users').where({ id: req.params.id, brand_id: req.user.brand_id }).delete();
  await logAudit(req.user.brand_id, req.user.id, 'USER', Number(req.params.id), 'DELETE', null, null);
  res.json({ ok: true });
});

module.exports = router;
