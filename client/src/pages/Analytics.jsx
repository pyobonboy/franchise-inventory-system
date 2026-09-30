import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../StoreContext';
import { toast } from '../toast';
import { Select, Button, Card, EmptyState, LoadingState, Badge, Table, THead, TBody, TR, TH, TD } from '../components/ui';

function DailyChart({ dailyRevenue, stores }) {
  const [tooltip, setTooltip] = useState(null);

  if (!dailyRevenue || dailyRevenue.length === 0) {
    return <EmptyState className="p-8">판매 데이터 없음 (POS 웹훅 연결 필요)</EmptyState>;
  }

  const dates = [...new Set(dailyRevenue.map(r => r.date))].sort();
  const storeIds = [...new Set(dailyRevenue.map(r => r.store_id))];
  const COLORS = ['#0064ff', '#06b6d4', '#16a34a', '#f59e0b', '#ef4444', '#ec4899'];

  const byDate = {};
  for (const r of dailyRevenue) {
    if (!byDate[r.date]) byDate[r.date] = {};
    byDate[r.date][r.store_id] = Number(r.revenue);
  }

  const maxRevenue = Math.max(...Object.values(byDate).map(d => Object.values(d).reduce((a, b) => a + b, 0)), 1);
  const CHART_H = 180;

  // Y축 눈금 계산
  const yTicks = 4;
  const tickStep = Math.ceil(maxRevenue / yTicks / 1000) * 1000;
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => i * tickStep);

  const fmtWon = v => v >= 10000 ? `${(v / 10000).toFixed(v % 10000 === 0 ? 0 : 1)}만` : `${v.toLocaleString()}`;

  return (
    <div>
      {/* 범례 */}
      <div className="flex gap-4 mb-3 flex-wrap">
        {storeIds.map((sid, i) => {
          const store = stores.find(s => s.id === sid);
          return (
            <div key={sid} className="flex items-center gap-1.5 text-xs">
              <div className="w-2.5 h-2.5 rounded-[2px]" style={{ background: COLORS[i % COLORS.length] }} />
              {store?.name || `매장 ${sid}`}
            </div>
          );
        })}
      </div>

      {/* 차트 영역 */}
      <div className="flex">
        {/* Y축 */}
        <div className="flex flex-col-reverse justify-between pb-7 pr-1.5 min-w-[44px]">
          {ticks.map(t => (
            <div key={t} className="text-2xs text-fg-3 text-right leading-none">{fmtWon(t)}</div>
          ))}
        </div>

        {/* 막대 + 눈금선 */}
        <div className="flex-1 overflow-x-auto relative">
          {/* 수평 눈금선 */}
          <div className="absolute top-0 left-0 right-0 pointer-events-none" style={{ height: CHART_H }}>
            {ticks.map(t => (
              <div key={t} className={'absolute left-0 right-0 border-b' + (t === 0 ? ' border-line' : ' border-dashed border-line')}
                style={{ bottom: `${(t / (tickStep * yTicks)) * 100}%` }} />
            ))}
          </div>

          <div className="flex items-end gap-1" style={{ minWidth: Math.max(dates.length * 44, 300), height: CHART_H + 28 }}>
            {dates.map(date => {
              const total = storeIds.reduce((s, sid) => s + (byDate[date]?.[sid] || 0), 0);
              return (
                <div key={date} className="flex-1 flex flex-col items-center"
                  onMouseMove={e => setTooltip({ date, total, x: e.pageX, y: e.pageY })}
                  onMouseLeave={() => setTooltip(null)}
                >
                  {/* 스택 막대 */}
                  <div className="w-[80%] flex flex-col-reverse justify-start cursor-default" style={{ height: CHART_H }}>
                    {storeIds.map((sid, i) => {
                      const rev = byDate[date]?.[sid] || 0;
                      if (!rev) return null;
                      const h = Math.round((rev / (tickStep * yTicks)) * CHART_H);
                      return (
                        <div key={sid} className={'w-full' + (i === storeIds.length - 1 ? ' rounded-t-[3px]' : '')}
                          style={{ height: Math.max(h, 2), background: COLORS[i % COLORS.length] }} />
                      );
                    })}
                  </div>
                  {/* 날짜 */}
                  <div className="text-2xs text-fg-3 mt-1 whitespace-nowrap">
                    {date.slice(5).replace('-', '/')}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 툴팁 */}
          {tooltip && (
            <div className="absolute bg-elevated border border-line rounded-[8px] px-3 py-2 text-xs pointer-events-none shadow-[0_4px_12px_rgba(0,0,0,0.15)] z-[200] [transform:translate(-50%,-110%)]"
              style={{ left: tooltip.x, top: tooltip.y }}>
              <div className="font-bold mb-0.5">{tooltip.date}</div>
              <div className="text-brand font-bold">{tooltip.total.toLocaleString()}원</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const QUICK_RANGES = [
  { label: '당일', days: 0 },
  { label: '전일', days: 1, offset: 1 },
  { label: '1주일', days: 7 },
  { label: '1개월', days: 30 },
];

const ALL_STORES = 'ALL';

export default function Analytics() {
  const { currentStore, stores } = useStore();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedStore, setSelectedStore] = useState(ALL_STORES);
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);

  const applyQuickRange = (r) => {
    const end = new Date(Date.now() - (r.offset || 0) * 86400000);
    const start = new Date(end.getTime() - r.days * 86400000);
    setFromDate(start.toISOString().split('T')[0]);
    setToDate(end.toISOString().split('T')[0]);
  };

  // AbortController가 fetch에 연결되어 있지 않아 signal.aborted가 영원히 false였다 — 취소 로직이
  // 통째로 장식이었고, 실제 레이스(느린 이전 요청이 나중에 도착해 최신 결과를 덮어씀)는 그대로 남아
  // 있었다. client/src/api.js가 signal을 받지 않으므로, API 계층을 건드리지 않고 세대 카운터로
  // 같은 목적을 달성한다.
  const loadSeqRef = useRef(0);
  const load = async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const params = {
        from: new Date(fromDate).toISOString(),
        to: new Date(toDate + 'T23:59:59').toISOString(),
      };
      if (selectedStore && selectedStore !== ALL_STORES) params.store_id = selectedStore;
      else if (currentStore) params.store_id = currentStore.id;
      const result = await api.getAnalytics(params);
      if (seq === loadSeqRef.current) setData(result);
    } catch (e) {
      if (seq === loadSeqRef.current) toast('분석 데이터를 불러오지 못했습니다', 'error');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  };

  useEffect(() => { load(); }, [currentStore?.id]);

  const totalRevenue = data?.salesByMenu.reduce((s, m) => s + m.total_amount, 0) || 0;
  const totalQty = data?.salesByMenu.reduce((s, m) => s + m.sold_qty, 0) || 0;

  const getRatioColor = (r) => {
    if (r === null) return 'var(--text-3)';
    if (r > 2) return 'var(--color-danger)';
    if (r > 1.3) return 'var(--color-warning)';
    if (r < 0.7) return 'var(--color-info)';
    return 'var(--color-success)';
  };

  return (
    <div>
      <h2 className="mb-4">판매 분석</h2>

      {/* 필터 바 */}
      {/* 레거시 .analytics-filter-bar가 자체 padding/border-bottom을 갖고 있는데, Card 프리미티브를 쓰면
          Tailwind utilities 레이어가 항상 legacy.css의 components 레이어를 이겨서 그 값이 깨진다.
          그래서 Card 대신 raw div + .card 레거시 클래스를 그대로 쓴다. */}
      <div className="card analytics-filter-bar">
        <div className="filter-field">
          <label>매장</label>
          <Select
            className="px-[10px] py-[7px] rounded-sm"
            value={selectedStore}
            onValueChange={setSelectedStore}
            options={[{ value: ALL_STORES, label: '전체 매장' }, ...stores.map(s => ({ value: String(s.id), label: s.name }))]}
          />
        </div>
        <div className="filter-field">
          <label>조회 기간</label>
          <div className="flex items-center gap-1.5">
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
            <span className="text-sub">~</span>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
        </div>
        <div className="filter-field">
          <label>&nbsp;</label>
          <div className="flex gap-1.5">
            {QUICK_RANGES.map(r => (
              <Button key={r.label} type="button" size="sm" onClick={() => applyQuickRange(r)}>{r.label}</Button>
            ))}
          </div>
        </div>
        <Button variant="primary" className="analytics-search-btn" onClick={load} disabled={loading}>
          {loading ? '조회 중...' : '조회'}
        </Button>
      </div>

      {/* 요약 카드 */}
      {data && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3 mb-5">
          <Card className="p-5">
            <div className="text-muted text-[12px] mb-1">총 매출</div>
            <div className="text-[22px] font-extrabold text-brand">{totalRevenue.toLocaleString()}원</div>
          </Card>
          <Card className="p-5">
            <div className="text-muted text-[12px] mb-1">총 판매수량</div>
            <div className="text-[22px] font-extrabold">{totalQty.toLocaleString()}개</div>
          </Card>
          <Card className="p-5">
            <div className="text-muted text-[12px] mb-1">판매 메뉴 종류</div>
            <div className="text-[22px] font-extrabold">{data.salesByMenu.length}종</div>
          </Card>
          <Card className="p-5">
            <div className="text-muted text-[12px] mb-1">평균 객단가</div>
            <div className="text-[22px] font-extrabold">
              {totalQty > 0 ? Math.round(totalRevenue / totalQty).toLocaleString() : 0}원
            </div>
          </Card>
        </div>
      )}

      {/* 일별 매출 차트 */}
      <Card className="mb-5">
        <div className="font-bold mb-4">일별 매출</div>
        {loading ? <LoadingState>데이터를 불러오는 중...</LoadingState> : (
          <DailyChart dailyRevenue={data?.dailyRevenue} stores={stores} />
        )}
      </Card>

      {data && !loading && (
        <>
          {/* 메뉴별 판매량 */}
          <Card className="mb-5">
            <div className="font-bold mb-3">메뉴별 판매량</div>
            {data.salesByMenu.length === 0 ? (
              <EmptyState>판매 데이터 없음</EmptyState>
            ) : (
              <Table>
                <THead>
                  <TR><TH>메뉴명</TH><TH>핵심</TH><TH>판매량</TH><TH>매출</TH><TH>주문건수</TH><TH>주요 식자재 예상 소진</TH></TR>
                </THead>
                <TBody>
                  {data.salesByMenu.map((m, i) => (
                    <TR key={i}>
                      <TD><b>{m.menu_name}</b></TD>
                      <TD>{m.is_key ? <Badge tone="yellow">핵심</Badge> : '-'}</TD>
                      <TD><span className="font-bold text-brand">{m.sold_qty.toLocaleString()}</span>개</TD>
                      <TD>{m.total_amount.toLocaleString()}원</TD>
                      <TD className="text-sub">{m.order_count}건</TD>
                      <TD className="text-sub text-[12px]">
                        {m.ingredients.length === 0 ? <Badge tone="yellow">레시피 없음</Badge> :
                          m.ingredients.slice(0, 3).map(i => `${i.name} ${Math.round(i.estimated_usage)}${i.unit}`).join(', ')}
                        {m.ingredients.length > 3 && ` 외 ${m.ingredients.length - 3}종`}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          {/* 식자재 예상 소진 vs 발주 비교 */}
          <Card>
            <div className="font-bold mb-1">식자재 예상 소진 vs 발주량 비교</div>
            <div className="text-muted text-[12px] mb-3">
              비율 2.0 초과 → 과다 사입 의심 &nbsp;|&nbsp; 0.7 미만 → 발주 부족 가능성
            </div>
            {data.comparison.length === 0 ? (
              <EmptyState>비교 데이터 없음 (레시피 등록 필요)</EmptyState>
            ) : (
              <Table>
                <THead>
                  <TR><TH>식자재명</TH><TH>예상 소진</TH><TH>실제 발주</TH><TH>비율</TH><TH>평가</TH></TR>
                </THead>
                <TBody>
                  {data.comparison.map((c, i) => (
                    <TR key={i}>
                      <TD><b>{c.name}</b></TD>
                      <TD className="text-sub">{Math.round(c.estimated).toLocaleString()} {c.unit}</TD>
                      <TD className="text-sub">{Math.round(c.total_ordered).toLocaleString()} {c.unit}</TD>
                      <TD><span className="font-bold" style={{ color: getRatioColor(c.ratio) }}>{c.ratio !== null ? `${c.ratio}x` : '-'}</span></TD>
                      <TD>
                        {c.ratio === null ? <Badge tone="neutral">미비교</Badge>
                          : c.ratio > 2 ? <Badge tone="red">과다 사입</Badge>
                          : c.ratio > 1.3 ? <Badge tone="yellow">약간 과다</Badge>
                          : c.ratio < 0.7 ? <Badge tone="red">발주 부족</Badge>
                          : <Badge tone="green">적정</Badge>}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
