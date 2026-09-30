import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useStore } from '../StoreContext';
import { useAuth } from '../AuthContext';
import { toast } from '../toast';
import { useCountUp } from '../useCountUp';
import PaymentHistoryList from '../components/PaymentHistoryList';
import { Badge, Card, EmptyState, ProgressBar } from '../components/ui';
import { riskTypeLabel, RISK_SEVERITY_COLOR } from '../constants/riskTypes';

// 판매분석·가맹점순위 등 브랜드 전체를 보는 화면은 본사 탭(가맹점 미선택 메뉴)에 이미 있어 여기서는 제외 —
// 이 대시보드는 '한 가맹점' 단위 화면이므로, 그 가맹점에 한정된 작업으로만 구성
const QUICK_LINKS = [
  { to: '/ingredients', label: '재료 관리' },
  { to: '/menus', label: '메뉴 & 레시피' },
  { to: '/waste', label: '폐기 관리' },
];

const won = (v) => `${Math.round(v || 0).toLocaleString()}원`;

// 값이 갑자기 바뀌는 대신 짧게 카운트업되며 채워지도록 — 숫자 표시 자리에만 적용
function CountUpValue({ value, format }) {
  const display = useCountUp(value);
  return <span className="count-up">{format(display)}</span>;
}

// 하루 단위로 끊어진 이산 데이터라서, 점 사이를 곡선으로 이으면 실제론 존재하지 않는 "중간값"이
// 있는 것처럼 보여 오해를 줄 수 있음 — 직선으로 또렷하게 점만 정확히 잇는다
function linePathOf(points) {
  if (points.length < 2) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

function WeeklyTrendChart({ weekly }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(700);

  // svg에 preserveAspectRatio="none"을 쓰면 viewBox 비율과 실제 렌더링 박스 비율이 달라질 때
  // 내부 좌표계 전체가 가로/세로로 다르게 늘어나면서 숫자 글씨까지 일그러져 보였음(가로로 찌그러짐).
  // 실제 렌더링 너비를 그대로 viewBox 너비로 써서 1px = 1단위로 맞추면 늘어남 자체가 없어짐
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!weekly || weekly.length === 0) return null;
  // H는 .dash-trend-svg의 css height(190px)와 반드시 같아야 한다 — 다르면 세로 방향으로도
  // 똑같이 늘어남이 생겨서 글씨가 일그러짐
  const W = width, H = 190, PAD_X = 14, PAD_TOP = 38, PAD_BOTTOM = 10;
  const values = weekly.map(w => w.revenue || 0);
  const max = Math.max(...values, 1);
  const step = (W - PAD_X * 2) / (weekly.length - 1 || 1);
  const points = values.map((v, i) => ({
    x: PAD_X + step * i,
    y: PAD_TOP + (H - PAD_TOP - PAD_BOTTOM) * (1 - v / max),
    v,
  }));
  const peakIdx = values.indexOf(max);
  const lastIdx = points.length - 1;

  const linePath = linePathOf(points);
  const baseY = H - PAD_BOTTOM;
  const areaPath = `${linePath} L ${points[lastIdx].x.toFixed(1)} ${baseY} L ${points[0].x.toFixed(1)} ${baseY} Z`;

  // 모든 점에 숫자를 박으면 빽빽해서 지저분해 보이므로, 가장 중요한 두 지점(최고 매출일·오늘)만 강조해서 보여준다
  const highlightIdxs = new Set([peakIdx, lastIdx]);

  return (
    <div className="dash-trend-chart" ref={containerRef}>
      <div className="dash-section-title mb-1 pb-0 border-b-0">최근 7일 매출 추이</div>
      <svg className="dash-trend-svg" viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <linearGradient id="dashTrendGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--purple)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--purple)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="dashTrendStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--purple-dark)" />
            <stop offset="100%" stopColor="var(--purple)" />
          </linearGradient>
        </defs>
        <line className="dash-trend-baseline" x1={PAD_X} y1={baseY} x2={W - PAD_X} y2={baseY} />
        <path className="dash-trend-area" d={areaPath} />
        <path className="dash-trend-line" d={linePath} />
        {points.map((p, i) => {
          const isHighlight = highlightIdxs.has(i) && p.v > 0;
          const label = `${Math.round(p.v).toLocaleString()}원`;
          const boxW = label.length * 7 + 16;
          const cx = Math.min(Math.max(p.x, boxW / 2 + 2), W - boxW / 2 - 2);
          const cy = Math.max(p.y - 26, 16);
          return (
            <g key={i}>
              {isHighlight && (
                <g>
                  <rect className={'dash-trend-value-bg' + (i === peakIdx ? ' peak' : '')}
                    x={cx - boxW / 2} y={cy - 11} width={boxW} height={20} rx={10} />
                  <text className={'dash-trend-value' + (i === peakIdx ? ' peak' : '')} x={cx} y={cy + 4}>
                    {label}
                  </text>
                </g>
              )}
              {p.v > 0 && (
                <circle className={'dash-trend-dot' + (i === peakIdx ? ' peak' : i === lastIdx ? ' current' : '')}
                  cx={p.x} cy={p.y} r={isHighlight ? 5 : 3} />
              )}
            </g>
          );
        })}
      </svg>
      <div className="dash-trend-labels">
        {weekly.map(w => (
          <div key={w.date} className={
            'dash-trend-label' + (w.weekday === '토' ? ' weekend-sat' : w.weekday === '일' ? ' weekend-sun' : '')
          }>
            {w.date.slice(5)}<span className="dash-trend-weekday">{w.weekday}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { currentStore } = useStore();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [payments, setPayments] = useState([]);
  const [channelBreakdown, setChannelBreakdown] = useState(null);

  useEffect(() => {
    if (!currentStore) return;
    setData(null);
    setError(null);
    setChannelBreakdown(null);
    api.getDashboard(currentStore.id).then(setData).catch(e => {
      setError(e.message || '대시보드를 불러오지 못했습니다');
      toast(e.message || '대시보드를 불러오지 못했습니다', 'error');
    });
    api.getStorePayments(currentStore.id).then(setPayments).catch(() => setPayments([]));
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    api.getChannelBreakdown({ store_id: currentStore.id, from })
      .then(r => setChannelBreakdown(r.breakdown))
      .catch(() => setChannelBreakdown(null));
  }, [currentStore?.id]);

  if (!currentStore) return <EmptyState>가맹점을 선택해주세요</EmptyState>;
  if (error) return <EmptyState>{error}</EmptyState>;
  if (!data) return (
    <div className="dash-layout" key="dash-skeleton">
      <div className="dash-side">
        <div className="skeleton h-[150px] rounded-[18px] mb-4" />
        <div className="dash-stat-tiles">
          {[...Array(5)].map((_, i) => <div key={i} className="skeleton h-[70px]" />)}
        </div>
        <div className="skeleton h-[90px] mt-4 rounded-[16px]" />
      </div>
      <div className="dash-main">
        <div className="skeleton h-[280px] rounded-[16px]" />
        <div className="skeleton h-[200px] mt-4 rounded-[16px]" />
      </div>
    </div>
  );

  const cmp = data.salesComparison || {};
  const weekly = (data.weeklyStats || []).filter(d => d && d.date);

  const statTiles = [
    { label: '재고부족', value: data.lowStock.length, warn: data.lowStock.length > 0 },
    { label: '검토대기발주', value: data.pendingOrders, warn: data.pendingOrders > 0 },
    { label: '결제대기발주', value: data.paymentPending, warn: data.paymentPending > 0 },
    { label: '결제방치(24h+)', value: (data.paymentOverdue || []).length, warn: (data.paymentOverdue || []).length > 0 },
    { label: '미처리리스크', value: data.risks.length, warn: data.risks.length > 0 },
  ];

  const todayVsYesterday = cmp.yesterday?.revenue > 0
    ? Math.round(((data.todayRevenue - cmp.yesterday.revenue) / cmp.yesterday.revenue) * 1000) / 10
    : null;

  return (
    <div className="dash-layout tab-content" key="dash-loaded">
      {/* 좌측 패널 */}
      <div className="dash-side">
        <div className="dash-info-card fade-stagger">
          <div className="dash-info-avatar">{currentStore.name?.slice(0, 1)}</div>
          <div className="dash-date">{new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
          <div className="dash-store-name">{currentStore.name}</div>
          <div className="dash-user-name">{user?.name} 님</div>
        </div>

        <div className="dash-stat-tiles">
          {statTiles.map((t, i) => (
            <div key={t.label} className={'dash-stat-tile fade-stagger' + (t.warn ? ' warn' : '')} style={{ animationDelay: `${i * 30}ms` }}>
              <span className="dash-stat-value"><CountUpValue value={t.value} format={v => Math.round(v)} /></span>
              <span className="dash-stat-label">{t.label}</span>
            </div>
          ))}
        </div>

        <div className="dash-revenue-card fade-stagger">
          <div className="dash-revenue-label">오늘 매출</div>
          <div className="dash-revenue-amount"><CountUpValue value={data.todayRevenue} format={won} /></div>
          {todayVsYesterday !== null && (
            <div className={'dash-revenue-trend' + (todayVsYesterday >= 0 ? ' up' : ' down')}>
              {todayVsYesterday >= 0 ? '▲' : '▼'} 전일 대비 {Math.abs(todayVsYesterday)}%
            </div>
          )}
        </div>

        <div className="dash-revenue-card fade-stagger">
          <div className="dash-revenue-label">재고 자산가치</div>
          <div className="dash-revenue-amount text-[22px]"><CountUpValue value={data.stockValue} format={won} /></div>
          <div className="text-muted text-[11.5px] mt-2">현재 재고 × 발주 단가 기준 추정값</div>
        </div>

        <div className="dash-quicklinks fade-stagger">
          {QUICK_LINKS.map(l => (
            <Link key={l.to} to={l.to} className="dash-quicklink">
              <span>{l.label}</span>
              <span className="dash-quicklink-arrow">&rarr;</span>
            </Link>
          ))}
        </div>
      </div>

      {/* 우측 메인 */}
      <div className="dash-main">
        {/* 전주/전일 매출현황 + 최근 결제내역 */}
        <Card className="fade-stagger">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="dash-section-title">전주/전일 매출현황</div>
              <table className="dash-table dash-table-finance">
                <thead>
                  <tr><th>항목</th><th>전주 동요일</th><th>전일</th><th>당일</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>총매출액</td>
                    <td>{won(cmp.lastWeekSameDay?.revenue)}</td>
                    <td>{won(cmp.yesterday?.revenue)}</td>
                    <td><b>{won(cmp.today?.revenue)}</b></td>
                  </tr>
                  <tr>
                    <td>순매출액</td>
                    <td>{won(cmp.lastWeekSameDay?.netAmount)}</td>
                    <td>{won(cmp.yesterday?.netAmount)}</td>
                    <td><b>{won(cmp.today?.netAmount)}</b></td>
                  </tr>
                  <tr>
                    <td>현금금액</td>
                    <td>{won(cmp.lastWeekSameDay?.cashAmount)}</td>
                    <td>{won(cmp.yesterday?.cashAmount)}</td>
                    <td><b>{won(cmp.today?.cashAmount)}</b></td>
                  </tr>
                  <tr>
                    <td>카드금액</td>
                    <td>{won(cmp.lastWeekSameDay?.cardAmount)}</td>
                    <td>{won(cmp.yesterday?.cardAmount)}</td>
                    <td><b>{won(cmp.today?.cardAmount)}</b></td>
                  </tr>
                  <tr>
                    <td>주문건수</td>
                    <td>{(cmp.lastWeekSameDay?.orderCount || 0).toLocaleString()}</td>
                    <td>{(cmp.yesterday?.orderCount || 0).toLocaleString()}</td>
                    <td><b>{(cmp.today?.orderCount || 0).toLocaleString()}</b></td>
                  </tr>
                </tbody>
              </table>

              <WeeklyTrendChart weekly={weekly} />
            </div>

            <div>
              <div className="dash-section-title">최근 결제내역</div>
              <PaymentHistoryList payments={payments} limit={12} />
            </div>
          </div>
        </Card>

        {/* 1주일간 매출통계 */}
        <Card className="fade-stagger">
          <div className="dash-section-title">1주일간 매출통계</div>
          <table className="dash-table dash-table-finance">
            <thead>
              <tr><th>일자</th><th className="text-left">요일</th><th>총매출액</th><th>순매출액</th><th>NET매출액</th><th>건수</th></tr>
            </thead>
            <tbody>
              {weekly.map(w => {
                const color = w.weekday === '토' ? '#2563eb' : w.weekday === '일' ? '#dc2626' : undefined;
                return (
                  <tr key={w.date}>
                    <td style={{ color }}>{w.date}</td>
                    <td className="text-left" style={{ color }}>{w.weekday}</td>
                    <td>{won(w.revenue)}</td>
                    <td>{won(w.netAmount)}</td>
                    <td>{won(w.supplyAmount)}</td>
                    <td>{w.orderCount.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        {/* 채널별 매출 (최근 30일) — 토스플레이스 동기화가 가져온 주문의 실제 channel 값(order.source) 기준.
            배달앱 연동을 켜둔 매장은 여기에 배민/쿠팡이츠/요기요가 자동으로 나타남 (server/src/channels/toss.js 참고) */}
        {channelBreakdown && channelBreakdown.length > 0 && (
          <Card className="fade-stagger">
            <div className="dash-section-title">채널별 매출 (최근 30일)</div>
            <table className="dash-table dash-table-finance">
              <thead>
                <tr><th className="text-left">채널</th><th>매출</th><th>주문건수</th></tr>
              </thead>
              <tbody>
                {channelBreakdown.map(ch => (
                  <tr key={ch.channel}>
                    <td className="text-left">{ch.label}</td>
                    <td>{won(ch.revenue)}</td>
                    <td>{ch.order_count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {data.lowStock.length > 0 && (
          <Card className="fade-stagger border-l-4 border-l-[#dc2626] bg-[linear-gradient(135deg,var(--bg-card)_0%,rgba(220,38,38,0.025)_100%)]">
            <div className="dash-section-title text-[#dc2626]">재고 부족 재료</div>
            <table className="dash-table">
              <thead>
                <tr><th>재료명</th><th>현재 재고</th><th>알림 기준</th><th>상태</th></tr>
              </thead>
              <tbody>
                {data.lowStock.map(i => {
                  const pct = i.threshold > 0 ? Math.min((i.stock / i.threshold) * 100, 100) : 0;
                  return (
                    <tr key={i.id}>
                      <td><b>{i.name}</b></td>
                      <td>{i.stock} {i.unit}</td>
                      <td>{i.threshold} {i.unit}</td>
                      <td>
                        <Badge tone="red">부족</Badge>
                        <ProgressBar pct={pct} color="#dc2626" className="w-20" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}

        {data.risks.length > 0 && (
          <Card className="fade-stagger border-l-4 border-l-[#ef4444] bg-[linear-gradient(135deg,var(--bg-card)_0%,rgba(239,68,68,0.02)_100%)]">
            <div className="flex justify-between items-center mb-3">
              <div className="dash-section-title text-[#ef4444] mb-0 pb-0 border-b-0">리스크 알림 (미처리)</div>
              <Link to="/risks" className="text-[12.5px]">전체 보기 &rarr;</Link>
            </div>
            <table className="dash-table">
              <thead><tr><th>심각도</th><th>유형</th><th>가맹점</th><th>내용</th><th>발생일</th></tr></thead>
              <tbody>
                {data.risks.map(r => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => navigate('/risks')}>
                    <td><span className="font-bold text-xs" style={{ color: RISK_SEVERITY_COLOR[r.severity] }}>{r.severity}</span></td>
                    <td><Badge tone="yellow">{riskTypeLabel(r.type)}</Badge></td>
                    <td className="text-xs">{r.store_name || '-'}</td>
                    <td className="text-xs">{r.description}</td>
                    <td className="text-muted text-[12px]">{new Date(r.created_at).toLocaleDateString('ko-KR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        <Card className="fade-stagger">
          <div className="dash-section-title">최근 재고 알림 내역</div>
          {data.recentAlerts.length === 0 ? (
            <EmptyState>알림 내역 없음</EmptyState>
          ) : (
            <table className="dash-table">
              <thead><tr><th>재료</th><th>발송 시점 재고</th><th>발송 시각</th></tr></thead>
              <tbody>
                {data.recentAlerts.map(a => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>{a.stock_at_alert} {a.unit}</td>
                    <td className="text-muted">{new Date(a.sent_at).toLocaleString('ko-KR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
