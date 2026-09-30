const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { SECRET, HQ_ROLES, STORE_ROLES } = require('../middleware/auth');
const { knex } = require('../db/schema');

// 연결(res)마다 인증된 사용자 정보를 같이 들고 있어야 broadcast에서 권한별로 필터링할 수 있다.
// (예전에는 JWT 유효성만 확인하고 clients Set에 res만 넣어서, 접속한 모든 클라이언트가
// 브랜드/가맹점 구분 없이 전체 이벤트를 다 받는 문제가 있었음)
const clients = new Map();

router.get('/', async (req, res) => {
  // EventSource는 커스텀 헤더를 보낼 수 없어 토큰을 쿼리스트링으로 전달
  const token = req.query.token;
  let user;
  try {
    user = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).end();
  }

  // 토큰만으로는 계정 비활성화 여부를 알 수 없으므로 requireAuth와 동일하게 연결 시점에 최신 활성 상태를 확인
  // (비활성화된 계정이 토큰 만료(7일) 전까지 실시간 스트림을 계속 열어둘 수 있는 문제를 막기 위함).
  // 조회 실패 시에도 연결을 열어두면 비활성 계정을 걸러낼 수 없으므로 안전하게 끊는다
  try {
    const row = await knex('users').where({ id: user.id }).select('role', 'brand_id', 'store_id', 'is_active').first();
    if (!row || !row.is_active) return res.status(401).end();
    // 토큰에 든 role/brand_id/store_id를 그대로 쓰면, 강등되거나 소속이 바뀐 계정이 토큰 만료(7일)
    // 전까지 옛 권한으로 이벤트를 계속 받는다 — requireAuth가 매 요청마다 DB를 다시 읽는 것과 같은 이유로
    // 여기서도 DB 값을 정본으로 삼는다.
    user = { ...user, role: row.role, brand_id: row.brand_id, store_id: row.store_id };
  } catch {
    return res.status(401).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.set(res, user);
  req.on('close', () => clients.delete(res));
});

// 연결 시점 검사만으로는 "연결된 상태에서 계정이 비활성화된 경우"를 막지 못한다 — SSE는 몇 시간~며칠씩
// 연결이 유지되므로 실질적인 구멍이다. 5분마다 현재 연결된 사용자들의 활성 상태를 한 번의 쿼리로 확인해서
// 비활성으로 바뀐 연결은 끊는다.
setInterval(async () => {
  if (clients.size === 0) return; // 연결이 없으면 불필요한 조회를 하지 않음
  try {
    const ids = [...new Set([...clients.values()].map(u => u.id))];
    const rows = await knex('users').whereIn('id', ids).select('id', 'is_active');
    const activeIds = new Set(rows.filter(r => r.is_active).map(r => r.id));
    for (const [res, user] of clients) {
      if (!activeIds.has(user.id)) {
        res.end();
        clients.delete(res);
      }
    }
  } catch (e) {
    // 정리 루프가 실패해도 SSE 서버 자체는 계속 떠 있어야 하므로 예외를 삼키고 다음 주기에 재시도
    console.error('[SSE] 비활성 계정 연결 정리 중 오류:', e.message);
  }
}, 5 * 60 * 1000).unref();

function broadcast(data) {
  // 본사는 brandId로, 가맹점은 storeId로 필터링하므로 둘 중 하나만 없어도 그 역할군은 조용히 이벤트를
  // 못 받게 된다 (원인 찾기 어려운 버그) — 잘못 흘려보내는 것보다 아예 막고 어느 필드가 빠졌는지 남긴다
  if (data.brandId == null || data.storeId == null) {
    console.warn(`[SSE] brandId/storeId 누락으로 전송하지 않습니다 (brandId=${data.brandId}, storeId=${data.storeId}, type=${data.type})`);
    return;
  }

  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach((user, res) => {
    // 본사: 선택한 가맹점과 무관하게 자기 브랜드 전체 이벤트를 받는다 (커밋 9f2ccf6에서 의도한 동작 유지)
    // 가맹점: 자기 가맹점 이벤트만 받는다
    const allowed = HQ_ROLES.includes(user.role)
      ? data.brandId === user.brand_id
      : STORE_ROLES.includes(user.role) && data.storeId === user.store_id;
    if (allowed) res.write(msg);
  });
}

module.exports = { router, broadcast };
