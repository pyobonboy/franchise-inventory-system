const jwt = require('jsonwebtoken');
const { knex } = require('../db/schema');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET 환경변수가 설정되지 않았습니다. server/.env에 JWT_SECRET을 설정하세요.');
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, brand_id: user.brand_id, store_id: user.store_id },
    SECRET,
    { expiresIn: '7d' }
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });
  try {
    const decoded = jwt.verify(token, SECRET);
    // 토큰만으로는 계정 비활성화 여부를 알 수 없으므로 매 요청마다 최신 활성 상태를 확인
    const user = await knex('users').where({ id: decoded.id })
      .select('is_active', 'role', 'brand_id', 'store_id').first();
    if (!user || !user.is_active) {
      return res.status(401).json({ error: '계정이 비활성화되었습니다' });
    }
    // 역할 강등·소속 매장 이동은 토큰에 반영되지 않는다(만료 7일). 어차피 매 요청 DB를 조회하고 있으므로
    // 같은 쿼리에서 권한 관련 값을 전부 가져와 토큰 값보다 우선한다 — 그렇지 않으면 강등된 계정이
    // 최대 7일간 이전 권한으로, 다른 매장으로 옮긴 계정이 이전 매장 데이터로 계속 동작한다.
    req.user = { ...decoded, role: user.role, brand_id: user.brand_id, store_id: user.store_id };
    next();
  } catch {
    res.status(401).json({ error: '토큰이 유효하지 않습니다' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: '권한이 없습니다' });
    }
    next();
  };
}

// HQ roles
const HQ_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN', 'HQ_LOGISTICS', 'HQ_ACCOUNTING'];
const STORE_ROLES = ['STORE_OWNER', 'STORE_STAFF'];
// 물류 처리(발주 상태변경, 상품/재료/메뉴 관리) — 회계 역할은 조회만 가능하고 변경은 불가
const LOGISTICS_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN', 'HQ_LOGISTICS'];
// 가맹점 정보·사용자 관리 — 최고/일반 관리자만 (물류·회계 역할은 조회만)
const ADMIN_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN'];

module.exports = { signToken, requireAuth, requireRole, HQ_ROLES, STORE_ROLES, LOGISTICS_ROLES, ADMIN_ROLES, SECRET };
