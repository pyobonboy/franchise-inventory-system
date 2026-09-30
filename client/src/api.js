// VITE_API_URL이 호스트명만 있거나(Render의 fromService 값) 프로토콜/경로가 빠진 경우를 모두 보정
function normalizeApiBase(raw) {
  if (!raw) return '/api';
  let url = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  url = url.replace(/\/$/, '');
  return url.endsWith('/api') ? url : `${url}/api`;
}
const BASE_API = normalizeApiBase(import.meta.env.VITE_API_URL);
const BASE_AUTH = BASE_API.replace('/api', '/auth');

function getToken() { return localStorage.getItem('token'); }

async function req(base, path, options = {}) {
  const token = getToken();
  const res = await fetch(base + path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  // 예전엔 `throw new Error(await res.text())`라 토스트에 `{"error":"..."}` 원문이 그대로 노출됐다. 앱 전체 토스트가 이 함수를 탄다.
  if (!res.ok) {
    const text = await res.text();
    let message = '';
    try { const parsed = JSON.parse(text); message = parsed?.error || parsed?.message || ''; } catch { message = text; }
    const err = new Error(message || `요청에 실패했습니다 (${res.status})`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.json();
}

const a = (path, opts) => req(BASE_API, path, opts);
const auth = (path, opts) => req(BASE_AUTH, path, opts);
const qs = (params = {}) => {
  const filtered = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  const s = new URLSearchParams(filtered);
  return s.toString() ? '?' + s : '';
};

export const api = {
  // 인증
  login: (email, password) => auth('/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => auth('/me'),
  getUsers: () => auth('/users'),
  createUser: (data) => auth('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id, data) => auth(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteUser: (id) => auth(`/users/${id}`, { method: 'DELETE' }),

  // 브랜드
  getBrands: () => a('/brands'),

  // 가맹점
  getStores: () => a('/stores'),
  getMyStore: () => a('/stores/me'),
  getStoreOrderStatus: () => a('/stores/order-status'),
  getStoreAuditStatus: () => a('/stores/audit-status'),
  getMyTasks: () => a('/my-tasks'),
  createStore: (data) => a('/stores', { method: 'POST', body: JSON.stringify(data) }),
  updateStore: (id, data) => a(`/stores/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteStore: (id) => a(`/stores/${id}`, { method: 'DELETE' }),

  // 재료
  getIngredients: (store_id) => a(`/ingredients${qs({ store_id })}`),
  createIngredient: (data) => a('/ingredients', { method: 'POST', body: JSON.stringify(data) }),
  updateIngredient: (id, data) => a(`/ingredients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteIngredient: (id) => a(`/ingredients/${id}`, { method: 'DELETE' }),
  restock: (id, amount) => a(`/ingredients/${id}/restock`, { method: 'POST', body: JSON.stringify({ amount }) }),

  // 메뉴
  getMenus: (store_id) => a(`/menus${qs({ store_id })}`),
  createMenu: (data) => a('/menus', { method: 'POST', body: JSON.stringify(data) }),
  updateMenu: (id, data) => a(`/menus/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMenu: (id) => a(`/menus/${id}`, { method: 'DELETE' }),

  // 레시피
  addRecipe: (menuId, data) => a(`/menus/${menuId}/recipes`, { method: 'POST', body: JSON.stringify(data) }),
  deleteRecipe: (menuId, ingredientId) => a(`/menus/${menuId}/recipes/${ingredientId}`, { method: 'DELETE' }),

  // 메뉴 매핑 — 레시피/표준메뉴/세트구성이 전부 없어 재고가 안 깎이는 메뉴 정리
  getUnassignedMenus: (params) => a(`/menus/unassigned${qs(params)}`),
  updateMenuRecipeLinks: (links) => a('/menus/recipe-links', { method: 'PUT', body: JSON.stringify({ links }) }),
  getMenuComponents: (menuId) => a(`/menus/${menuId}/components`),
  addMenuComponent: (menuId, data) => a(`/menus/${menuId}/components`, { method: 'POST', body: JSON.stringify(data) }),
  deleteMenuComponent: (menuId, componentMenuId) => a(`/menus/${menuId}/components/${componentMenuId}`, { method: 'DELETE' }),

  // 발주 상품
  getProducts: () => a('/products'),
  getProductRecommendations: (store_id) => a(`/products/recommendations${qs({ store_id })}`),
  createProduct: (data) => a('/products', { method: 'POST', body: JSON.stringify(data) }),
  updateProduct: (id, data) => a(`/products/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProduct: (id) => a(`/products/${id}`, { method: 'DELETE' }),

  // 발주서
  getOrders: (params) => a(`/orders${qs(params)}`),
  getOrder: (id) => a(`/orders/${id}`),
  createOrder: (data) => a('/orders', { method: 'POST', body: JSON.stringify(data) }),
  updateOrder: (id, data) => a(`/orders/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  changeOrderStatus: (id, status, reason) => a(`/orders/${id}/status`, { method: 'POST', body: JSON.stringify({ status, reason }) }),
  updateOrderItem: (orderId, itemId, data) => a(`/orders/${orderId}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }),
  cancelOrder: (id) => a(`/orders/${id}`, { method: 'DELETE' }),
  preparePayment: (id) => a(`/orders/${id}/payment/prepare`, { method: 'POST' }),
  confirmPayment: (id, data) => a(`/orders/${id}/payment/confirm`, { method: 'POST', body: JSON.stringify(data) }),
  refundOrder: (id, reason, amount, reason_code) => a(`/orders/${id}/refund`, { method: 'POST', body: JSON.stringify({ reason, amount, reason_code }) }),
  refundOrderItems: (id, reason, items, reason_code) => a(`/orders/${id}/refund-items`, { method: 'POST', body: JSON.stringify({ reason, items, reason_code }) }),
  getRefundReasons: (params) => a(`/orders/refund-reasons${qs(params)}`),
  getAttentionOrders: () => a('/orders/attention'),
  ackOrder: (id) => a(`/orders/${id}/ack`, { method: 'POST' }),
  confirmReceipt: (id, ok, note) => a(`/orders/${id}/receipt-confirm`, { method: 'POST', body: JSON.stringify({ ok, note }) }),
  getReceiptIssues: () => a('/orders/receipt-issues'),
  resolveReceiptIssue: (id) => a(`/orders/${id}/receipt-issue/resolve`, { method: 'POST' }),

  // 정기 발주 템플릿
  getOrderTemplates: () => a('/order-templates'),
  createOrderTemplate: (data) => a('/order-templates', { method: 'POST', body: JSON.stringify(data) }),
  deleteOrderTemplate: (id) => a(`/order-templates/${id}`, { method: 'DELETE' }),

  // 폐기
  getWaste: (params) => a(`/waste${qs(params)}`),
  createWaste: (data) => a('/waste', { method: 'POST', body: JSON.stringify(data) }),
  deleteWaste: (id) => a(`/waste/${id}`, { method: 'DELETE' }),
  getWasteSummary: (params) => a(`/waste/summary${qs(params)}`),

  // 리스크
  getRisks: (params) => a(`/risks${qs(params)}`),
  createRisk: (data) => a('/risks', { method: 'POST', body: JSON.stringify(data) }),
  updateRiskStatus: (id, status, memo) => a(`/risks/${id}/status`, { method: 'POST', body: JSON.stringify({ status, memo }) }),
  getRiskSettings: () => a('/risks/settings'),
  updateRiskSettings: (data) => a('/risks/settings', { method: 'PUT', body: JSON.stringify(data) }),

  // 대시보드
  getDashboard: (store_id) => a(`/dashboard${qs({ store_id })}`),

  // 판매 분석
  getAnalytics: (params) => a(`/analytics${qs(params)}`),
  syncStore: (id, data) => a(`/stores/${id}/sync`, { method: 'POST', body: JSON.stringify(data) }),
  getChannelBreakdown: (params) => a(`/dashboard/channel-breakdown${qs(params)}`),

  // 가맹점 순위
  getStoreRankings: (params) => a(`/store-rankings${qs(params)}`),
  getStorePayments: (storeId, params) => a(`/stores/${storeId}/payments${qs(params)}`),

  // 정산 리포트
  getSettlement: (params) => a(`/settlement${qs(params)}`),

  // 사입 이상 모니터링
  getPurchaseAnomalies: (params) => a(`/purchase-anomalies${qs(params)}`),

  // 레시피 변경 이력
  getRecipeHistory: (menuId) => a(`/menus/${menuId}/recipe-history`),

  // 감사 로그
  getAuditLog: (params) => a(`/audit-log${qs(params)}`),

  // 공지사항
  getNotices: () => a('/notices'),
  createNotice: (data) => a('/notices', { method: 'POST', body: JSON.stringify(data) }),
  updateNotice: (id, data) => a(`/notices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteNotice: (id) => a(`/notices/${id}`, { method: 'DELETE' }),
  getMyNotices: (store_id) => a(`/notices/mine${qs({ store_id })}`),
  markNoticeRead: (id) => a(`/notices/${id}/read`, { method: 'POST' }),

  // 실사 재고 조정 / 상품별 거래 수불
  getStockAdjustments: (store_id) => a(`/stock/adjustments${qs({ store_id })}`),
  createStockAdjustment: (data) => a('/stock/adjustments', { method: 'POST', body: JSON.stringify(data) }),
  getStockLedger: (params) => a(`/stock/ledger${qs(params)}`),
};
