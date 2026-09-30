import { toast } from '../toast';
import { Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { exportCsv } from '../exportCsv';
import { useStore } from '../StoreContext';
import { useAuth } from '../AuthContext';
import { useCountUp } from '../useCountUp';
import PaymentHistoryList from '../components/PaymentHistoryList';
import {
  Button, Badge, Card, ElevatedCard, Field, FieldRow, Input, Select,
  Modal, confirmDialog, DropdownMenu, Table, THead, TBody, TR, TH, TD,
  EmptyState, LoadingState,
} from '../components/ui';
import { cn } from '../lib/cn';
import { ACTIVE_STATUSES } from '../constants/orderStatus';

const AVATAR_PALETTE_SIZE = 6;
const avatarClass = (id) => `avatar-ring c${Number(id) % AVATAR_PALETTE_SIZE}`;

const FAVORITES_KEY = 'storeFavoriteIds';
const loadFavorites = () => {
  try { return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]')); } catch { return new Set(); }
};

const SEARCH_HISTORY_KEY = 'storeSearchHistory';
const loadSearchHistory = () => {
  try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); } catch { return []; }
};

function KpiCard({ label, value, tone, suffix }) {
  const display = useCountUp(value);
  return (
    <div className={`kpi-card fade-stagger${tone ? ` ${tone}` : ''}`}>
      <div className="kpi-card-label">{label}</div>
      <div className="kpi-card-value count-up">{Math.round(display).toLocaleString()}{suffix || ''}</div>
    </div>
  );
}

const ADMIN_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN'];
const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

// 토스플레이스 API는 2022-01-01 이전 날짜를 from으로 보내면 에러를 반환함 (API 자체 제약)
const TOSS_PLACE_MIN_DATE = '2022-01-01';

function BulkSyncModal({ stores, onClose }) {
  const [from, setFrom] = useState(() => {
    const fiveYearsAgo = new Date(Date.now() - 5 * 365 * 86400000).toISOString().split('T')[0];
    return fiveYearsAgo < TOSS_PLACE_MIN_DATE ? TOSS_PLACE_MIN_DATE : fiveYearsAgo;
  });
  const [to, setTo] = useState(() => new Date().toISOString().split('T')[0]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);

  const targets = stores.filter(s => s.toss_store_id);

  const runAll = async () => {
    setRunning(true);
    setResults(targets.map(s => ({ store_id: s.id, store_name: s.name, status: 'pending' })));
    for (const store of targets) {
      setResults(prev => prev.map(r => r.store_id === store.id ? { ...r, status: 'running' } : r));
      try {
        const r = await api.syncStore(store.id, { from, to });
        setResults(prev => prev.map(x => x.store_id === store.id ? { ...x, status: 'done', inserted: r.inserted, failed: r.failed } : x));
      } catch (e) {
        setResults(prev => prev.map(x => x.store_id === store.id ? { ...x, status: 'error', error: e.message } : x));
      }
    }
    setRunning(false);
  };

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next && !running) onClose(); }}
      title="전체 가맹점 매출 동기화"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={running}>닫기</Button>
          <Button variant="primary" onClick={runAll} disabled={running || targets.length === 0}>
            {running ? '동기화 진행 중...' : '동기화 시작'}
          </Button>
        </>
      )}
    >
      <p className="text-muted text-[13px] mb-4">
        토스플레이스 매장 ID가 등록된 가맹점({targets.length}개)을 순서대로 하나씩 동기화합니다.
        배달앱 연동을 켠 매장은 배민/쿠팡이츠/요기요 주문도 이 동기화에 같이 포함됩니다.
      </p>
      <FieldRow>
        <Field label="시작일">
          <Input type="date" value={from} min={TOSS_PLACE_MIN_DATE} onChange={e => setFrom(e.target.value)} disabled={running} />
        </Field>
        <Field label="종료일">
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} disabled={running} />
        </Field>
      </FieldRow>

      {results.length > 0 && (
        <ElevatedCard className="p-3 mb-4 max-h-[240px] overflow-y-auto">
          {results.map(r => (
            <div key={r.store_id} className="flex justify-between text-[13px] py-[6px] border-b border-line">
              <span>{r.store_name}</span>
              {r.status === 'pending' && <span className="text-muted">대기중</span>}
              {r.status === 'running' && <span className="text-[var(--purple)]">동기화 중...</span>}
              {r.status === 'done' && (
                <span className="text-[#16a34a]">
                  {r.inserted.toLocaleString()}건
                  {r.failed > 0 && <span className="text-[#dc2626] ml-1">실패 {r.failed}건</span>}
                </span>
              )}
              {r.status === 'error' && <span className="text-[#dc2626]">{r.error}</span>}
            </div>
          ))}
        </ElevatedCard>
      )}

      {targets.length === 0 && (
        <EmptyState className="p-4">토스플레이스 매장 ID가 등록된 가맹점이 없습니다</EmptyState>
      )}
    </Modal>
  );
}

const won = (v) => `${Math.round(v || 0).toLocaleString()}원`;

// 가맹점명을 클릭했을 때 뜨는 운영 미니 대시보드 — 기본정보(전화번호/주소 등)는 거의 입력이 안 되고
// 잘 쓰이지도 않아서, 본사가 실제로 알고싶어하는 "이 가맹점 요즘 어때?"에 답이 되는 매출/발주/리스크
// 신호를 모아서 보여준다. 기존 대시보드/주문목록 API를 그대로 재사용한다.
function StoreDetailPanel({ store, onClose }) {
  const [dashboard, setDashboard] = useState(null);
  const [orders, setOrders] = useState([]);
  const [ratioTrend, setRatioTrend] = useState(null);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    Promise.all([
      api.getDashboard(store.id),
      api.getOrders({ store_id: store.id }),
      api.getStoreRankings({ from: thisMonthStart.toISOString(), to: now.toISOString() }),
      api.getStoreRankings({ from: lastMonthStart.toISOString(), to: lastMonthEnd.toISOString() }),
      api.getStorePayments(store.id),
    ]).then(([d, o, thisMonth, lastMonth, p]) => {
      setDashboard(d); setOrders(o); setPayments(p);
      const thisRatio = thisMonth.efficiencyRanking.find(r => r.store_id === store.id)?.ratio ?? null;
      const lastRatio = lastMonth.efficiencyRanking.find(r => r.store_id === store.id)?.ratio ?? null;
      setRatioTrend({ thisRatio, lastRatio });
    }).catch(err => {
      console.error(err);
      toast('가맹점 정보를 불러오지 못했습니다', 'error');
    }).finally(() => setLoading(false));
  }, [store.id]);

  const attentionCount = orders.filter(o => o.needs_attention).length;
  const activeCount = orders.filter(o => ACTIVE_STATUSES.includes(o.status)).length;
  const maxRevenue = Math.max(1, ...(dashboard?.weeklyStats || []).map(d => d.revenue));

  return (
    <Card>
      <div className="flex justify-between mb-4">
        <div className="font-bold text-base">{store.name}</div>
        <Button variant="secondary" size="sm" onClick={onClose}>닫기</Button>
      </div>

      {loading ? <LoadingState>불러오는 중...</LoadingState> : (
        <>
          <div className="grid grid-cols-5 gap-[10px] mb-5">
            <ElevatedCard className="p-3">
              <div className="text-sub text-xs">오늘 매출</div>
              <div className="font-bold text-base mt-1">{won(dashboard?.todayRevenue)}</div>
            </ElevatedCard>
            <ElevatedCard className="p-3">
              <div className="text-sub text-xs">재고 자산가치</div>
              <div className="font-bold text-base mt-1">{won(dashboard?.stockValue)}</div>
            </ElevatedCard>
            <ElevatedCard className="p-3">
              <div className="text-sub text-xs">처리중 발주</div>
              <div className="font-bold text-base mt-1">{activeCount}건</div>
            </ElevatedCard>
            <ElevatedCard className="p-3">
              <div className="text-sub text-xs">미확인 변경알림</div>
              <div className={`font-bold text-base mt-1 ${attentionCount > 0 ? 'text-[#f59e0b]' : 'text-fg'}`}>{attentionCount}건</div>
            </ElevatedCard>
            <ElevatedCard className="p-3">
              <div className="text-sub text-xs">이번달 발주율 (전월대비)</div>
              <div className="font-bold text-base mt-1">
                {ratioTrend?.thisRatio ?? '-'}{ratioTrend?.thisRatio !== null && ratioTrend?.thisRatio !== undefined ? '%' : ''}
                {ratioTrend?.thisRatio != null && ratioTrend?.lastRatio != null && (
                  <span className={`text-xs ml-[6px] ${ratioTrend.thisRatio > ratioTrend.lastRatio ? 'text-[#dc2626]' : 'text-[#16a34a]'}`}>
                    {ratioTrend.thisRatio > ratioTrend.lastRatio ? '▲' : '▼'} {Math.abs(Math.round((ratioTrend.thisRatio - ratioTrend.lastRatio) * 10) / 10)}%p
                  </span>
                )}
              </div>
            </ElevatedCard>
          </div>

          <div className="grid grid-cols-3 gap-5">
            <div>
              <div className="font-bold mb-2 text-[13px]">최근 7일 매출</div>
              <div className="flex items-end gap-[6px] h-20">
                {(dashboard?.weeklyStats || []).map(d => (
                  <div key={d.date} className="flex-1 text-center">
                    <div className="bg-[var(--purple)] rounded-[3px] mx-auto w-[70%]"
                      style={{ height: Math.max(2, (d.revenue / maxRevenue) * 60) }} title={won(d.revenue)} />
                    <div className="text-sub text-[11px] mt-1">{d.weekday}</div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="font-bold mb-2 text-[13px]">미확인 리스크 ({dashboard?.risks?.length || 0})</div>
              {(!dashboard?.risks || dashboard.risks.length === 0) ? (
                <EmptyState className="p-3">없음</EmptyState>
              ) : (
                dashboard.risks.slice(0, 5).map(r => (
                  <div key={r.id} className="text-muted text-[12.5px] mb-1">
                    {new Date(r.created_at).toLocaleDateString('ko-KR')} — {r.description || r.type}
                  </div>
                ))
              )}
            </div>

            <div>
              <div className="font-bold mb-2 text-[13px]">최근 발주</div>
              {orders.length === 0 ? (
                <EmptyState className="p-3">발주 내역 없음</EmptyState>
              ) : (
                orders.slice(0, 5).map(o => (
                  <div key={o.id} className="flex justify-between text-[12.5px] mb-1">
                    <span className="text-muted">{new Date(o.created_at).toLocaleDateString('ko-KR')} — 발주서 #{o.id}</span>
                    <span>{won(o.confirmed_amount ?? o.total_amount)}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-5">
            <div className="font-bold mb-2 text-[13px]">최근 결제내역</div>
            <PaymentHistoryList payments={payments} />
          </div>
        </>
      )}
    </Card>
  );
}

const FRANCHISE_TYPES = ['가맹점', '직영점'];

const HQ_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN', 'HQ_LOGISTICS', 'HQ_ACCOUNTING'];

function StoreModal({ item, onClose, onSave }) {
  const [form, setForm] = useState(item || {
    name: '', webhook_secret: '', toss_store_id: '', order_deadline: '', delivery_days: '',
    business_number: '', owner_name: '', phone: '', open_date: '', franchise_type: '', is_open: true, address: '',
    assigned_user_id: '',
  });
  const [hqUsers, setHqUsers] = useState([]);
  useEffect(() => {
    api.getUsers().then(users => setHqUsers(users.filter(u => HQ_ROLES.includes(u.role)))).catch(() => {});
  }, []);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const toggleDay = (d) => {
    const days = form.delivery_days ? form.delivery_days.split(',').filter(Boolean) : [];
    const ds = String(d);
    const next = days.includes(ds) ? days.filter(x => x !== ds) : [...days, ds].sort();
    set('delivery_days', next.join(','));
  };
  const selectedDays = form.delivery_days ? form.delivery_days.split(',').filter(Boolean) : [];

  const FRANCHISE_OPTIONS = [{ value: 'NONE', label: '선택 안함' }, ...FRANCHISE_TYPES.map(t => ({ value: t, label: t }))];
  const OPEN_OPTIONS = [{ value: '1', label: '오픈' }, { value: '0', label: '폐점' }];
  const ASSIGNED_OPTIONS = [{ value: 'NONE', label: '지정 안함' }, ...hqUsers.map(u => ({ value: String(u.id), label: `${u.name} (${u.role})` }))];

  return (
    <Modal
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={item ? '가맹점 수정' : '가맹점 추가'}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button variant="primary" onClick={() => onSave(form)}>저장</Button>
        </>
      )}
    >
      <Field label="가맹점명" className="mb-3">
        <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="예: 강남점" />
      </Field>
      <FieldRow>
        <Field label="가맹형태" className="mb-3">
          <Select
            value={form.franchise_type || 'NONE'}
            onValueChange={v => set('franchise_type', v === 'NONE' ? '' : v)}
            options={FRANCHISE_OPTIONS}
          />
        </Field>
        <Field label="오픈여부" className="mb-3">
          <Select
            value={form.is_open ? '1' : '0'}
            onValueChange={v => set('is_open', v === '1')}
            options={OPEN_OPTIONS}
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="대표자명" className="mb-3">
          <Input value={form.owner_name || ''} onChange={e => set('owner_name', e.target.value)} placeholder="예: 홍길동" />
        </Field>
        <Field label="전화번호" className="mb-3">
          <Input value={form.phone || ''} onChange={e => set('phone', e.target.value)} placeholder="02-1234-5678" />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="사업자번호" className="mb-3">
          <Input value={form.business_number || ''} onChange={e => set('business_number', e.target.value)} placeholder="123-45-67890" />
        </Field>
        <Field label="개점일자" className="mb-3">
          <Input type="date" value={form.open_date || ''} onChange={e => set('open_date', e.target.value)} />
        </Field>
      </FieldRow>
      <Field label="주소" className="mb-3">
        <Input value={form.address || ''} onChange={e => set('address', e.target.value)} placeholder="예: 서울 강남구 ..." />
      </Field>
      <Field label="담당자 (본사)" className="mb-3">
        <Select
          value={form.assigned_user_id ? String(form.assigned_user_id) : 'NONE'}
          onValueChange={v => set('assigned_user_id', v === 'NONE' ? '' : v)}
          options={ASSIGNED_OPTIONS}
        />
      </Field>
      <Field label="웹훅 시크릿 키 (토스플레이스 발급)" className="mb-3">
        <Input value={form.webhook_secret || ''} onChange={e => set('webhook_secret', e.target.value)} placeholder="시크릿 키 입력" />
      </Field>
      <Field label="토스플레이스 매장 ID (선택)" className="mb-3">
        <Input value={form.toss_store_id || ''} onChange={e => set('toss_store_id', e.target.value)} placeholder="store_xxx" />
      </Field>
      <Field label="발주 마감 시간 (예: 18:00)" className="mb-3">
        <Input value={form.order_deadline} onChange={e => set('order_deadline', e.target.value)} placeholder="18:00" />
      </Field>
      <Field label="납품 가능 요일" className="mb-3">
        <div className="flex gap-[6px] mt-1">
          {[0,1,2,3,4,5,6].map(d => (
            <button
              key={d}
              type="button"
              onClick={() => toggleDay(d)}
              className={cn(
                'px-[10px] py-[5px] rounded-md cursor-pointer text-[13px] border border-line',
                selectedDays.includes(String(d)) ? 'bg-[var(--purple)] text-white' : 'bg-elevated text-fg'
              )}
            >
              {DAY_LABELS[d]}
            </button>
          ))}
        </div>
      </Field>
    </Modal>
  );
}

export default function Stores() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canEdit = ADMIN_ROLES.includes(user?.role);
  const { stores, currentStore, reloadStores, loaded } = useStore();
  const [modal, setModal] = useState(null);
  const [bulkSyncOpen, setBulkSyncOpen] = useState(false);
  const [detailStore, setDetailStore] = useState(null);
  const [orderStatus, setOrderStatus] = useState([]);
  const [auditStatus, setAuditStatus] = useState([]);
  const [openRisks, setOpenRisks] = useState([]);
  const [statusChip, setStatusChip] = useState('all');
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [showOptional, setShowOptional] = useState(false);
  const [todayRevenue, setTodayRevenue] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [favoriteIds, setFavoriteIds] = useState(loadFavorites);
  const [searchHistory, setSearchHistory] = useState(loadSearchHistory);
  const [refreshing, setRefreshing] = useState(false);

  const todaySparkValue = useCountUp(todayRevenue || 0);

  const toggleFavorite = (id) => {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      return next;
    });
  };
  useEffect(() => {
    api.getStoreOrderStatus().then(setOrderStatus).catch(() => {});
    api.getStoreAuditStatus().then(setAuditStatus).catch(() => {});
    api.getRisks({ status: 'OPEN' }).then(setOpenRisks).catch(() => {});
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    api.getStoreRankings({ from: todayStart, to: now.toISOString() })
      .then(data => {
        // `revenueRanking` 키는 서버에 존재한 적이 없어 '금일 전체 매출' KPI가 항상 0이었다.
        const arr = Array.isArray(data) ? data[0]?.salesRanking : data?.salesRanking;
        const total = (arr || []).reduce((sum, r) => sum + (r.revenue || 0), 0);
        if (total > 0) setTodayRevenue(total);
      }).catch(() => {});
  }, []);

  const [nameQuery, setNameQuery] = useState('');
  const [bizQuery, setBizQuery] = useState('');
  const [franchiseType, setFranchiseType] = useState('');
  const [openStatus, setOpenStatus] = useState('');
  const [filters, setFilters] = useState(null);

  // window.open + localStorage 조합은 새 탭뿐 아니라 현재 탭의 선택 가맹점도 함께 바꾼다.
  // 되돌릴 방법(레이스 없이)이 마땅치 않아 부작용 자체는 없애지 못하므로, 최소한 사용자가
  // 놀라지 않도록 실행 전에 확인을 받는다.
  const handleLogin = async (store) => {
    const ok = await confirmDialog({
      title: '새 탭에서 이 가맹점 화면을 엽니다',
      description: '현재 탭의 선택 가맹점도 함께 바뀝니다.',
    });
    if (!ok) return;
    localStorage.setItem('currentStoreId', store.id);
    window.open(`${window.location.origin}/dashboard`, '_blank');
  };

  const runSearch = () => {
    setFilters({ nameQuery, bizQuery, franchiseType, openStatus });
    const term = nameQuery.trim();
    if (term) {
      setSearchHistory(prev => {
        const next = [term, ...prev.filter(t => t !== term)].slice(0, 5);
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
        return next;
      });
    }
  };

  const applyHistoryChip = (term) => {
    setNameQuery(term);
    setFilters({ nameQuery: term, bizQuery, franchiseType, openStatus });
  };

  const filteredStores = stores.filter(s => {
    // sqlite는 boolean을 1/0 정수로 돌려주므로 `=== false`가 로컬에서 항상 거짓이 되어
    // 폐점 매장이 전부 '오픈'으로 표시됐다(운영 pg는 진짜 boolean이라 로컬에서만 틀렸다).
    // 서버 응답을 boolean으로 정규화하는 것이 근본이지만 범위가 커서, 화면에서는 진리값으로만 판단한다.
    if (statusChip === 'open' && !s.is_open) return false;
    if (statusChip === 'closed' && !!s.is_open) return false;
    if (!filters) return true;
    if (filters.nameQuery && !String(s.name || '').toLowerCase().includes(filters.nameQuery.toLowerCase())) return false;
    if (filters.bizQuery && !String(s.business_number || '').includes(filters.bizQuery)) return false;
    if (filters.franchiseType && s.franchise_type !== filters.franchiseType) return false;
    if (filters.openStatus === 'open' && !s.is_open) return false;
    if (filters.openStatus === 'closed' && !!s.is_open) return false;
    return true;
  }).sort((a, b) => {
    const fa = favoriteIds.has(a.id) ? 1 : 0;
    const fb = favoriteIds.has(b.id) ? 1 : 0;
    return fb - fa;
  });

  const handleSave = async (form) => {
    if (!form.name?.trim()) { toast('가맹점명을 입력해주세요', 'error'); return; }
    try {
      if (modal?.edit) await api.updateStore(modal.edit.id, form);
      else await api.createStore(form);
      setModal(null);
      reloadStores();
    } catch (e) {
      toast(e.message || '저장에 실패했습니다', 'error');
    }
  };

  const handleDelete = async (store) => {
    const ok = await confirmDialog({
      title: `"${store.name}"을 삭제하시겠습니까?`,
      // 서버가 이력이 있으면 409로 거부하므로 "모두 삭제됩니다"는 더 이상 사실이 아니다.
      description: '발주·매출·재고 이력이 없는 가맹점만 삭제할 수 있습니다. 이력이 있으면 폐점 처리를 이용해주세요.',
    });
    if (!ok) return;
    try {
      await api.deleteStore(store.id);
      toast('가맹점이 삭제되었습니다', 'success');
      reloadStores();
    } catch (e) {
      // try/catch가 없어 서버가 새로 주는 409 안내("폐점 처리를 이용하세요")가 화면에 전혀 안 떴고,
      // 관리자는 버튼이 고장 난 줄 알았다.
      toast(e.message || '삭제에 실패했습니다', 'error');
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    reloadStores();
    setLastUpdated(Date.now());
    toast('최신 데이터로 갱신됐습니다', 'success');
    setTimeout(() => setRefreshing(false), 700);
  };

  const openCount = stores.filter(s => !!s.is_open).length;
  const closedCount = stores.filter(s => !s.is_open).length;
  const hasRisks = auditStatus.length > 0 || orderStatus.length > 0 || openRisks.length > 0;

  const visibleIds = filteredStores.map(s => s.id);
  const allChecked = visibleIds.length > 0 && visibleIds.every(id => checkedIds.has(id));
  const toggleAll = () => {
    if (allChecked) setCheckedIds(new Set());
    else setCheckedIds(new Set(visibleIds));
  };
  const toggleOne = (id) => setCheckedIds(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  const [nowTs, setNowTs] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const minutesAgo = Math.floor((nowTs - lastUpdated) / 60000);
  const lastUpdatedText = minutesAgo < 1 ? '방금 업데이트됨' : `${minutesAgo}분 전 업데이트됨`;

  // 체크박스, NO, 매장, 대표자명, 전화번호, 사업자번호, 오픈여부, 관리 = 8열 고정
  const colSpan = 8 + (showOptional ? 6 : 0);

  return (
    <div>
      {refreshing && <div className="top-progress-bar" />}

      {/* 페이지 헤더 */}
      <div className="mb-6">
        <div className="flex items-center gap-1 text-sm text-fg-3 font-semibold mb-2">
          기초정보 <span className="opacity-50">›</span> 가맹점관리
        </div>
        <div className="flex items-center justify-between">
          <h2 className="border-l-2 border-line-input pl-4 text-2xl">가맹점조회</h2>
          <div className="btn-group-stagger flex gap-2">
            <Button variant="secondary" onClick={() => setBulkSyncOpen(true)}>매출 동기화</Button>
            {canEdit && <Button variant="primary" onClick={() => setModal('add')}>+ 가맹점 추가</Button>}
          </div>
        </div>
      </div>

      {/* KPI 스트립 */}
      <div className="kpi-strip">
        <KpiCard label="전체 가맹점" value={stores.length} suffix="개" />
        <KpiCard label="오픈" value={openCount} tone="accent" suffix="개" />
        <KpiCard label="폐점" value={closedCount} suffix="개" />
        <KpiCard label="주의 필요" value={auditStatus.length + orderStatus.length + openRisks.length} tone={hasRisks ? 'warn' : undefined} suffix="건" />
        <KpiCard label="금일 전체 매출" value={Math.round((todayRevenue || 0) / 1000)} suffix="천원" />
      </div>

      {/* 대량 작업 바 */}
      {checkedIds.size > 0 && (
        <div className="bulk-bar flex items-center justify-between bg-fg text-white rounded-md py-[10px] px-4 mb-4">
          <span className="text-sm font-semibold">선택 {checkedIds.size}건</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm"
              className="bg-white/15 text-white border-none shadow-none hover:bg-white/15 hover:text-white"
              onClick={() => {
                const rows = [['가맹점명','사업자번호','대표자','전화','토스매장ID','상태'],
                  ...stores.filter(s => checkedIds.has(s.id)).map(s => [s.name, s.business_number||'', s.owner_name||'', s.phone||'', s.toss_store_id||'', s.is_open ? '오픈':'폐점'])];
                exportCsv(`가맹점_${new Date().toISOString().slice(0,10)}.csv`, rows);
              }}>내보내기</Button>
            <Button variant="secondary" size="sm"
              className="bg-white/15 text-white border-none shadow-none hover:bg-white/15 hover:text-white"
              onClick={() => setCheckedIds(new Set())}>선택 해제</Button>
          </div>
        </div>
      )}

      {/* 2컬럼 레이아웃 */}
      <div className="flex gap-6 items-start">

        {/* 메인 콘텐츠 */}
        <div className="flex-1 min-w-0">
          <Card className="p-0 overflow-hidden">

            {/* 검색 필터 헤더 */}
            <div className="px-6 pt-6 pb-5 border-b border-line bg-muted">
              <h3 className="text-lg font-bold mb-[14px]">가맹점 목록</h3>
              <div className="grid grid-cols-[1.4fr_1.4fr_1fr_1fr_auto] gap-4 items-end">
                <div className="form-group">
                  <label htmlFor="sq-name">매장명</label>
                  <div className="search-input-wrap">
                    <Input id="sq-name" value={nameQuery} onChange={e => setNameQuery(e.target.value)} placeholder="가맹점명"
                      onKeyDown={e => e.key === 'Enter' && runSearch()} />
                  </div>
                  {searchHistory.length > 0 && (
                    <div className="flex gap-[6px] mt-[6px] flex-wrap">
                      {searchHistory.map(term => (
                        <button key={term} type="button" className="search-chip" onClick={() => applyHistoryChip(term)}>
                          🕐 {term}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label htmlFor="sq-biz">사업자번호</label>
                  <Input id="sq-biz" value={bizQuery} onChange={e => setBizQuery(e.target.value)} placeholder="123-45-67890"
                    onKeyDown={e => e.key === 'Enter' && runSearch()} />
                </div>
                <div className="form-group">
                  <label>가맹형태</label>
                  <Select
                    value={franchiseType || 'ALL'}
                    onValueChange={v => setFranchiseType(v === 'ALL' ? '' : v)}
                    options={[{ value: 'ALL', label: '전체' }, ...FRANCHISE_TYPES.map(t => ({ value: t, label: t }))]}
                  />
                </div>
                <div className="form-group">
                  <label>오픈여부</label>
                  <Select
                    value={openStatus || 'ALL'}
                    onValueChange={v => setOpenStatus(v === 'ALL' ? '' : v)}
                    options={[{ value: 'ALL', label: '전체' }, { value: 'open', label: '오픈' }, { value: 'closed', label: '폐점' }]}
                  />
                </div>
                <Button variant="primary" className="mb-4" onClick={runSearch}>조회</Button>
              </div>
              <div className="flex gap-[6px] mt-1">
                {[
                  { key: 'all', label: `전체 ${stores.length}` },
                  { key: 'open', label: `오픈 ${openCount}` },
                  { key: 'closed', label: `폐점 ${closedCount}` },
                ].map(chip => (
                  <button key={chip.key} onClick={() => setStatusChip(chip.key)} className={cn(
                    'px-[13px] py-[5px] rounded-full border border-line text-[14px] font-semibold',
                    statusChip === chip.key ? 'bg-fg text-white' : 'bg-transparent text-fg-3'
                  )}>{chip.label}</button>
                ))}
              </div>
            </div>

            {/* 테이블 툴바 */}
            <div className="flex items-center justify-between pt-[14px] px-5">
              <div className="flex items-center gap-[10px]">
                <span className="text-sm text-fg-3">
                  전체 <b className="text-fg">{filteredStores.length}건</b>
                </span>
                <span className="text-xs text-fg-3 opacity-80">· {lastUpdatedText}</span>
              </div>
              <div className="flex items-center gap-[6px]">
                <Button variant="ghost" size="sm" aria-label={showOptional ? '컬럼 줄이기' : '컬럼 더보기'} onClick={() => setShowOptional(v => !v)}>
                  {showOptional ? '↑ 컬럼 줄이기' : '↓ 컬럼 더보기'}
                </Button>
                <Button variant="ghost" size="sm" aria-label="새로고침" onClick={handleRefresh}>↺ 새로고침</Button>
              </div>
            </div>

            {/* 테이블 */}
            <div className="mt-[10px] overflow-x-auto">
              {!loaded ? (
                <Table key="store-skeleton">
                  <TBody>
                    {[...Array(5)].map((_, i) => (
                      <TR key={i} className="skeleton-row">
                        <TD colSpan={colSpan}><div className="skeleton skeleton-line" style={{ animationDelay: `${i * 60}ms` }} /></TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : stores.length === 0 ? (
                <EmptyState key="store-empty">가맹점을 추가해주세요</EmptyState>
              ) : (
                <Table className="tab-content" key={`store-list-${statusChip}`}>
                  <THead>
                    <TR>
                      <TH className="w-9">
                        <input type="checkbox" checked={allChecked} onChange={toggleAll}
                          className="accent-[var(--purple)] cursor-pointer w-[15px] h-[15px]" />
                      </TH>
                      <TH className="w-[46px]">NO</TH>
                      <TH>매장</TH>
                      <TH>대표자명</TH>
                      <TH>전화번호</TH>
                      <TH>사업자번호</TH>
                      {showOptional && <><TH>가맹형태</TH><TH>담당자</TH></>}
                      <TH>오픈여부</TH>
                      {showOptional && <><TH>개점일</TH><TH>주소</TH><TH>발주마감</TH><TH>납품요일</TH></>}
                      <TH className="w-12">관리</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filteredStores.length === 0 ? (
                      <TR><TD colSpan={colSpan} className="text-center py-12 text-fg-3 text-[16px]">검색 결과가 없습니다</TD></TR>
                    ) : filteredStores.map((s, i) => {
                      const initial = (s.name || '?').charAt(0);
                      const isSelected = s.id === currentStore?.id;
                      const isClosed = !s.is_open;
                      const isChecked = checkedIds.has(s.id);
                      const isFavorite = favoriteIds.has(s.id);
                      const isDetailOpen = detailStore?.id === s.id;
                      const days = s.delivery_days ? s.delivery_days.split(',').filter(Boolean).map(d => DAY_LABELS[Number(d)]).join(' ') : '—';
                      return (
                        <Fragment key={s.id}>
                        <TR className={cn('fade-stagger', isClosed && 'muted-entity')} style={{ background: isChecked ? 'var(--purple-light)' : isClosed ? 'var(--bg-muted)' : undefined }}>
                          <TD>
                            <input type="checkbox" checked={isChecked} onChange={() => toggleOne(s.id)}
                              className="accent-[var(--purple)] cursor-pointer w-[15px] h-[15px]" />
                          </TD>
                          <TD className="text-fg-3 text-sm text-center">{i + 1}</TD>
                          <TD>
                            <div className="flex items-center gap-2">
                              <button type="button" className={`fav-star${isFavorite ? ' active' : ''}`}
                                onClick={e => { e.stopPropagation(); toggleFavorite(s.id); }}
                                title={isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}>
                                {isFavorite ? '★' : '☆'}
                              </button>
                              <div className={cn(avatarClass(s.id), 'w-[30px] h-[30px] text-[14px]')}>{initial}</div>
                              <button type="button" onClick={() => setDetailStore(isDetailOpen ? null : s)}
                                className={cn(
                                  'bg-transparent border-none p-0 text-[17px] font-semibold cursor-pointer inline-flex items-center gap-[6px]',
                                  isClosed ? 'text-fg-3' : 'text-fg'
                                )}>
                                {s.name}
                                {isSelected && <Badge tone="green" className="text-[11px]">선택됨</Badge>}
                                <span className={cn('text-[11px] text-fg-3 inline-block [transition:transform_0.18s_ease]', isDetailOpen && 'rotate-180')}>▾</span>
                              </button>
                            </div>
                          </TD>
                          <TD className={cn('text-fg-3', !s.owner_name && 'opacity-55')}>{s.owner_name || '—'}</TD>
                          <TD className={cn('text-fg-3', !s.phone && 'opacity-55')}>{s.phone || '—'}</TD>
                          <TD className={cn('text-fg-3', !s.business_number && 'opacity-55')}>{s.business_number || '—'}</TD>
                          {showOptional && <>
                            <TD className="text-fg-2 text-[16px]">{s.franchise_type || '—'}</TD>
                            <TD className={cn('text-fg-3', !s.assigned_user_name && 'opacity-55')}>{s.assigned_user_name || '—'}</TD>
                          </>}
                          <TD>
                            <div className="flex items-center gap-2">
                              <Badge tone={isClosed ? 'red' : 'green'} subtle>
                                {isClosed ? '폐점' : '오픈'}
                              </Badge>
                              {!isClosed && (
                                <Button variant="secondary" size="sm" className="text-[13px] px-[10px] py-[3px] whitespace-nowrap"
                                  onClick={e => { e.stopPropagation(); handleLogin(s); }}>
                                  가맹점 탭으로 이동
                                </Button>
                              )}
                            </div>
                          </TD>
                          {showOptional && <>
                            <TD className="text-fg-3 text-sm">{s.open_date || '—'}</TD>
                            <TD className="text-fg-3 text-[14px] max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap" title={s.address || ''}>{s.address || '—'}</TD>
                            <TD className="text-fg-3 text-sm">{s.order_deadline || '—'}</TD>
                            <TD className="text-fg-3 text-sm">{days}</TD>
                          </>}
                          <TD>
                            <div className="relative" onClick={e => e.stopPropagation()}>
                              <DropdownMenu
                                trigger={
                                  <button aria-label="관리 메뉴 열기"
                                    className="px-2 py-1 bg-transparent text-fg-3 border-none rounded-[6px] text-[18px] leading-none">
                                    ⋮
                                  </button>
                                }
                                items={[
                                  { label: '로그인', onSelect: () => handleLogin(s) },
                                  ...(canEdit ? [
                                    { label: '수정', onSelect: () => setModal({ edit: s }) },
                                    { label: '삭제', onSelect: () => handleDelete(s), tone: 'danger' },
                                  ] : []),
                                ]}
                              />
                            </div>
                          </TD>
                        </TR>
                        {isDetailOpen && (
                          <TR>
                            <TD colSpan={colSpan} className="p-0 bg-muted">
                              <div className="fade-stagger p-4">
                                <StoreDetailPanel store={detailStore} onClose={() => setDetailStore(null)} />
                              </div>
                            </TD>
                          </TR>
                        )}
                        </Fragment>
                      );
                    })}
                  </TBody>
                </Table>
              )}
            </div>
          </Card>
        </div>

        {/* 우측 사이드바 */}
        <div className="w-[300px] shrink-0 flex flex-col gap-4 sticky top-6">

          {/* 리스크 알림 카드 */}
          {hasRisks && (
            // .card.hoverable:hover의 translateY/box-shadow는 Card 프리미티브가 이미 내보내는
            // utilities 레이어 transition과 같은 CSS 레이어라 원본 클래스만으로는 죽는다.
            // 그래서 hoverable에 기대지 않고 Tailwind로 직접 표현하되, Card 기본 transition과
            // 합쳐서 하나의 transition 선언으로 넘긴다(같은 속성을 두 개로 나누면 뒤엣것만 남는다).
            <Card
              className="fade-stagger cursor-pointer hover:-translate-y-[2px] hover:shadow-[0_12px_28px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.4)] [transition:background-color_0.2s_ease,color_0.2s_ease,border-color_0.18s_ease,transform_0.18s_ease,box-shadow_0.18s_ease]"
              style={{ borderLeft: '3px solid #dc2626' }}
              onClick={() => navigate('/risks')}>
              <h3 className="text-md font-bold mb-[10px]">최근 리스크 알림</h3>
              {openRisks.slice(0, 5).map(r => (
                <div key={`risk-${r.id}`} className="flex items-center gap-[10px] py-[7px] border-b border-line">
                  <div className="w-7 h-7 rounded-[7px] bg-[#fee2e2] text-[#b91c1c] flex items-center justify-center shrink-0 text-[14px] font-bold">!</div>
                  <div className="flex-1 text-[13px] overflow-hidden text-ellipsis whitespace-nowrap leading-[1.4]">
                    <b>{r.store_name}</b> — {r.description || r.type}
                  </div>
                  <span className="text-[12px] text-fg-3 shrink-0">{new Date(r.created_at).toLocaleDateString('ko-KR')}</span>
                </div>
              ))}
              {auditStatus.map(s => (
                <div key={`audit-${s.store_id}`} className="flex items-center gap-[10px] py-[7px] border-b border-line">
                  <div className="w-7 h-7 rounded-[7px] bg-[#fee2e2] text-[#b91c1c] flex items-center justify-center shrink-0 text-[14px] font-bold">!</div>
                  <div className="flex-1 text-[13px] overflow-hidden text-ellipsis whitespace-nowrap leading-[1.4]">
                    <b>{s.store_name}</b> — 재고 실사 지연
                  </div>
                  <span className="text-[12px] text-fg-3 shrink-0">{s.daysSince}일 전</span>
                </div>
              ))}
              {orderStatus.map(s => (
                <div key={`order-${s.store_id}`} className="flex items-center gap-[10px] py-[7px] border-b border-line">
                  <div className="w-7 h-7 rounded-[7px] bg-[#fef3c7] text-[#92400e] flex items-center justify-center shrink-0 text-[13px]">△</div>
                  <div className="flex-1 text-[13px] overflow-hidden text-ellipsis whitespace-nowrap leading-[1.4]">
                    <b>{s.store_name}</b> — 발주 마감 임박
                  </div>
                  <span className="text-[12px] text-fg-3 shrink-0">
                    {s.diffMin <= 0 ? `${Math.abs(s.diffMin)}분 경과` : `${s.diffMin}분 전`}
                  </span>
                </div>
              ))}
            </Card>
          )}

          {/* 금일 전체 매출 스파크라인 */}
          <Card className="fade-stagger">
            <div className="text-[13px] text-fg-3 font-semibold mb-1">금일 전체 매출</div>
            <div className="count-up text-[26px] font-extrabold tracking-[-0.3px] text-fg">
              {todayRevenue !== null ? `₩${Math.round(todaySparkValue).toLocaleString()}` : '₩—'}
            </div>
          </Card>

          {/* 웹훅 URL 안내 (접힘) */}
          <details className="card fade-stagger">
            <summary className="cursor-pointer list-none flex justify-between items-center text-sm font-bold text-fg-2">
              웹훅 URL 안내 <span className="opacity-50">▾</span>
            </summary>
            <div className="mt-3 pt-3 border-t border-line text-[14px] text-fg-2 leading-[1.7]">
              각 가맹점별 웹훅 URL은 <b>백엔드주소/webhook/가맹점ID</b> 형식입니다.<br />
              토스플레이스 관리자에서 가맹점별로 웹훅 URL을 등록해주세요.
            </div>
          </details>
        </div>
      </div>

      {(modal === 'add' || modal?.edit) && (
        <StoreModal item={modal?.edit} onClose={() => setModal(null)} onSave={handleSave} />
      )}
      {bulkSyncOpen && (
        <BulkSyncModal stores={stores} onClose={() => setBulkSyncOpen(false)} />
      )}
    </div>
  );
}
