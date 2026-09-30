import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { StoreProvider, useStore } from './StoreContext';
import { ThemeProvider, useTheme } from './ThemeContext';
import {
  IconStore, IconBarChart, IconReceipt,
  IconTrendingUp, IconAlertTriangle,
  IconClipboardList, IconPackage,
  IconCheckSquare, IconShieldAlert,
  IconBell, IconUsers, IconHistory,
  IconDashboard, IconBox, IconUtensils,
  IconTrash, IconClipboardCheck,
  IconBookOpen, IconMoon, IconSun,
  IconLogOut, IconChevronLeft, IconChevronRight,
} from './icons';
import { api } from './api';
import Dashboard from './pages/Dashboard';
import Ingredients from './pages/Ingredients';
import Menus from './pages/Menus';
import MenuMapping from './pages/MenuMapping';
import Stores from './pages/Stores';
import Users from './pages/Users';
import HQOrders from './pages/HQOrders';
import StoreOrder from './pages/StoreOrder';
import PaymentResult from './pages/PaymentResult';
import StoreStock from './pages/StoreStock';
import Waste from './pages/Waste';
import Risks from './pages/Risks';
import Notices from './pages/Notices';
import StockAdjustment from './pages/StockAdjustment';
import StockLedger from './pages/StockLedger';
import Products from './pages/Products';
import Analytics from './pages/Analytics';
import StoreRankings from './pages/StoreRankings';
import Settlement from './pages/Settlement';
import PurchaseAnomalies from './pages/PurchaseAnomalies';
import AuditLog from './pages/AuditLog';
import OrderInvoice from './pages/OrderInvoice';
import MyTasks from './pages/MyTasks';
import Login from './pages/Login';
import StockAlert from './components/StockAlert';
import NoticeBanner from './components/NoticeBanner';
import OrderAttentionBanner from './components/OrderAttentionBanner';
import ToastHost from './components/ToastHost';
import { ConfirmDialogHost, PromptDialogHost, Tip, TooltipProvider } from './components/ui';

function TopNavRight({ name, currentStore, onBackToAdmin }) {
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  return (
    <div className="topnav-right">
      {currentStore && (
        <span className="text-[14px] opacity-75 border-r border-r-white/20 pr-3 mr-0 whitespace-nowrap max-w-[120px] overflow-hidden text-ellipsis">
          {currentStore.name}
        </span>
      )}
      {onBackToAdmin && (
        <button onClick={onBackToAdmin} className="text-xs whitespace-nowrap">← 관리자</button>
      )}
      <span className="user-avatar">{name?.[0] || '?'}</span>
      <span className="text-[14px] whitespace-nowrap max-w-[100px] overflow-hidden text-ellipsis">{name}</span>
      <Tip label={theme === 'light' ? '다크 모드' : '라이트 모드'}>
        <button onClick={toggle} className="p-1">
          {theme === 'light' ? <IconMoon size={16} /> : <IconSun size={16} />}
        </button>
      </Tip>
      <Tip label="로그아웃">
        <button onClick={logout} className="p-1">
          <IconLogOut size={16} />
        </button>
      </Tip>
    </div>
  );
}

function NavTab({ to, end, label, count }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => 'topnav-tab' + (isActive ? ' active' : '')}>
      <span className="topnav-tab-label">{label}</span>
      {count > 0 && <span className="nav-badge">{count > 99 ? '99+' : count}</span>}
    </NavLink>
  );
}

// 관리자 페이지 메뉴 — 가맹점 선택 없이도 쓸 수 있는 그룹과, 특정 가맹점을 선택해야 의미가 있는 그룹으로 구분
// storeRequired: false = 가맹점 선택과 무관하게 전체 브랜드 단위로 보는 메뉴 (선택 전 화면에 노출)
// storeRequired: true = 특정 가맹점 데이터를 보는 메뉴 (가맹점 선택 후 화면에 노출)
// title은 storeRequired/hqAdminOnly 필터링 용도로만 쓰고, 대분류 탭으로는 노출하지 않음 —
// 상단 탭과 좌측 메뉴 모두 평면화된 전체 항목 목록을 그대로 보여준다
const SIDE_MENU_GROUPS = [
  { title: '가맹점', storeRequired: false, items: [
    { to: '/', end: true, label: '가맹점 목록', icon: IconStore },
    { to: '/rankings', end: true, label: '가맹점 순위', icon: IconBarChart },
    { to: '/settlement', end: true, label: '정산 리포트', icon: IconReceipt },
    { to: '/analytics', end: true, label: '매출 분석', icon: IconTrendingUp },
    { to: '/purchase-anomalies', end: true, label: '사입 이상 모니터링', icon: IconAlertTriangle },
    { to: '/menu-mapping', end: true, label: '메뉴 매핑', icon: IconUtensils },
  ] },
  { title: '주문 · 발주', storeRequired: false, items: [
    { to: '/orders', end: true, label: '주문 목록', icon: IconClipboardList },
    { to: '/products', end: true, label: '발주 상품', icon: IconPackage },
  ] },
  { title: '리스크 · 사용자', storeRequired: false, items: [
    { to: '/my-tasks', end: true, label: '내 업무', icon: IconCheckSquare },
    { to: '/risks', end: true, label: '리스크 알림', icon: IconShieldAlert },
    { to: '/notices', end: true, label: '공지사항', icon: IconBell },
    { to: '/users', end: true, label: '사용자 관리', icon: IconUsers, hqAdminOnly: true },
  ] },
  { title: '감사', storeRequired: false, hqAdminOnly: true, items: [
    { to: '/audit-log', end: true, label: '변경 이력', icon: IconHistory },
  ] },
  { title: '대시보드', storeRequired: true, items: [
    { to: '/dashboard', end: true, label: '대시보드 홈', icon: IconDashboard },
  ] },
  { title: '재고 · 메뉴', storeRequired: true, items: [
    { to: '/ingredients', end: true, label: '재료 목록', icon: IconBox },
    { to: '/menus', end: true, label: '메뉴 & 레시피', icon: IconUtensils },
    { to: '/waste', end: true, label: '폐기 내역', icon: IconTrash },
    { to: '/stock-adjustments', end: true, label: '실사 재고 조정', icon: IconClipboardCheck },
    { to: '/stock-ledger', end: true, label: '상품별 거래 수불', icon: IconBookOpen },
  ] },
];

function SideMenu({ collapsed, onToggle, groups, badgeCounts }) {
  return (
    <aside className={'side-menu' + (collapsed ? ' collapsed' : '')}>
      <button className="side-menu-collapse" onClick={onToggle} title={collapsed ? '펼치기' : '접기'}>
        {collapsed ? <IconChevronRight size={14} /> : <IconChevronLeft size={14} />}
      </button>
      <div className="side-menu-list">
        {groups.map((group, gi) => (
          <div key={gi} className="side-menu-group">
            {!collapsed && <div className="side-menu-group-title">{group.title}</div>}
            {group.items.map(item => {
              const Icon = item.icon;
              return (
                <NavLink key={item.to} to={item.to} end={item.end}
                  className={({ isActive }) => 'side-menu-item' + (isActive ? ' active' : '')}
                  title={collapsed ? item.label : undefined}>
                  <span className="flex items-center gap-2.5 min-w-0">
                    {Icon && <Icon size={18} className="shrink-0 opacity-75" />}
                    {!collapsed && <span className="overflow-hidden text-ellipsis whitespace-nowrap">{item.label}</span>}
                  </span>
                  {!collapsed && badgeCounts?.[item.to] > 0 && (
                    <span className="nav-badge">{badgeCounts[item.to] > 99 ? '99+' : badgeCounts[item.to]}</span>
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}

function HQLayout() {
  const { user } = useAuth();
  const { currentStore, clearStore } = useStore();
  const storeSelected = !!currentStore;
  const isHqAdmin = ['SUPER_ADMIN', 'HQ_ADMIN'].includes(user?.role);
  const [collapsed, setCollapsed] = useState(false);
  const [openRiskCount, setOpenRiskCount] = useState(0);
  const [myTaskCount, setMyTaskCount] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

  // 미확인 리스크 개수를 메뉴에 배지로 표시 — 1분마다 갱신
  useEffect(() => {
    const load = () => api.getRisks({ status: 'OPEN' }).then(rows => setOpenRiskCount(rows.length)).catch(() => {});
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  // 담당 가맹점의 처리할 일 개수도 리스크와 같은 방식으로 배지 표시 — 안 들어가보면 일이 있는지조차 몰랐던 문제
  useEffect(() => {
    const load = () => api.getMyTasks().then(data => {
      const total = (data.stores || []).reduce((s, st) => s + st.pendingReview + st.needsAttention + st.openRisks + (st.receiptIssues || 0), 0);
      setMyTaskCount(total);
    }).catch(() => {});
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  const badgeCounts = { '/risks': openRiskCount, '/my-tasks': myTaskCount };

  // 가맹점 선택 여부에 따라 상단 탭/좌측 메뉴 둘 다 같은 기준으로 전체 항목을 평면화해서 보여준다
  // 물류·회계 역할에게 '사용자 관리'가 보였고 들어가면 403이었다. 그룹 단위 플래그만 있어 항목 단위 예외를 표현할 수 없었다.
  const visibleGroups = SIDE_MENU_GROUPS
    .filter(g => (!g.hqAdminOnly || isHqAdmin) && g.storeRequired === storeSelected)
    .map(g => ({ ...g, items: g.items.filter(it => !it.hqAdminOnly || isHqAdmin) }))
    .filter(g => g.items.length > 0);
  const visibleItems = visibleGroups.flatMap(g => g.items);

  const backToAdmin = () => { clearStore(); navigate('/'); };

  return (
    <div className="kicc-layout">
      <header className="topnav">
        <NavLink to="/" className="topnav-brand no-underline text-white"><span className="brand-mark">P</span>포스모스</NavLink>
        <nav className="topnav-menu">
          {visibleItems.map(item => (
            <NavTab key={item.to} to={item.to} end={item.end} label={item.label} count={badgeCounts[item.to]} />
          ))}
        </nav>
        <TopNavRight name={user?.name} currentStore={currentStore} onBackToAdmin={storeSelected ? backToAdmin : null} />
      </header>
      <div className="kicc-body">
        <SideMenu collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} groups={visibleGroups} badgeCounts={badgeCounts} />
        <main className="kicc-main">
          <div className="kicc-main-inner tab-content" key={location.pathname}>
            <Routes>
              <Route path="/" element={<Stores />} />
              <Route path="/rankings" element={<StoreRankings />} />
              <Route path="/settlement" element={<Settlement />} />
              <Route path="/purchase-anomalies" element={<PurchaseAnomalies />} />
              <Route path="/menu-mapping" element={<MenuMapping />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/orders" element={<HQOrders />} />
              <Route path="/orders/:id/invoice" element={<OrderInvoice />} />
              <Route path="/risks" element={<Risks />} />
              <Route path="/my-tasks" element={<MyTasks />} />
              <Route path="/notices" element={<Notices />} />
              <Route path="/ingredients" element={<Ingredients />} />
              <Route path="/menus" element={<Menus />} />
              <Route path="/products" element={<Products />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/waste" element={<Waste />} />
              <Route path="/stock-adjustments" element={<StockAdjustment />} />
              <Route path="/stock-ledger" element={<StockLedger />} />
              {/* 메뉴는 hqAdminOnly로 숨겨져 있는데 Route는 열려 있어 URL 직접 입력으로 페이지가 열렸다
                  (서버가 auth.js에서 ADMIN_ROLES를 강제하므로 데이터는 안 나가지만 빈 화면과 403 토스트만 뜬다).
                  /audit-log가 이미 같은 패턴으로 가려져 있다. */}
              {isHqAdmin && <Route path="/users" element={<Users />} />}
              {isHqAdmin && <Route path="/audit-log" element={<AuditLog />} />}
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </div>
        </main>
      </div>
      {/* storeId 없이 마운트돼 getDashboard(undefined)가 브랜드 전체 재고부족을 돌려줬고, 본사 계정에 3분마다 전면 모달이 떴다. */}
      <StockAlert storeId={currentStore?.id} storeName={currentStore?.name} />
    </div>
  );
}

const STORE_MENU_GROUPS = [
  { title: '발주 · 재고', items: [
    { to: '/store', end: true, label: '발주하기', icon: IconPackage },
    { to: '/store/stock', end: false, label: '재고 확인', icon: IconBox },
    { to: '/store/waste', end: false, label: '폐기 입력', icon: IconTrash },
    { to: '/store/stock-adjustments', end: false, label: '실사 재고 조정', icon: IconClipboardCheck },
  ] },
];

function StoreLayout() {
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  return (
    <div className="kicc-layout">
      <header className="topnav">
        <div className="topnav-brand"><span className="brand-mark">P</span>포스모스</div>
        <nav className="topnav-menu">
          <NavTab to="/store" end label="발주하기" />
          <NavTab to="/store/stock" label="재고 확인" />
          <NavTab to="/store/waste" label="폐기 입력" />
          <NavTab to="/store/stock-adjustments" label="실사 재고 조정" />
        </nav>
        <TopNavRight name={user?.name} />
      </header>
      <div className="kicc-body">
        <SideMenu collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} groups={STORE_MENU_GROUPS} badgeCounts={{}} />
        <main className="kicc-main">
          <div className="kicc-main-inner tab-content" key={location.pathname}>
            <Routes>
              <Route path="/store" element={<StoreOrder />} />
              <Route path="/store/orders/:id/invoice" element={<OrderInvoice />} />
              <Route path="/store/payment/:id/result" element={<PaymentResult />} />
              <Route path="/store/stock" element={<StoreStock />} />
              <Route path="/store/waste" element={<Waste />} />
              <Route path="/store/stock-adjustments" element={<StockAdjustment />} />
              <Route path="*" element={<Navigate to="/store" />} />
            </Routes>
          </div>
        </main>
      </div>
      <StockAlert storeId={user?.store_id} storeName={user?.store_name} />
      <NoticeBanner storeId={user?.store_id} />
      <OrderAttentionBanner storeId={user?.store_id} />
    </div>
  );
}

function AppRoutes() {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen text-fg bg-bg">로딩 중...</div>;
  if (!user) return <Routes><Route path="*" element={<Login />} /></Routes>;
  if (['STORE_OWNER', 'STORE_STAFF'].includes(user.role)) return <StoreLayout />;
  return (
    <StoreProvider>
      <HQLayout />
    </StoreProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <TooltipProvider>
        <ThemeProvider>
          <AuthProvider>
            <AppRoutes />
            <ToastHost />
            <ConfirmDialogHost />
            <PromptDialogHost />
          </AuthProvider>
        </ThemeProvider>
      </TooltipProvider>
    </BrowserRouter>
  );
}
