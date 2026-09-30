import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../toast';
import { exportCsv } from '../exportCsv';
import Loading from '../components/Loading';
import { Button, Card, EmptyState, ProgressBar, Table, THead, TBody, TR, TH, TD, Badge } from '../components/ui';

const QUICK_RANGES = [
  { label: '1주일', days: 7 },
  { label: '1개월', days: 30 },
  { label: '3개월', days: 90 },
];

const won = (v) => `${Math.round(v || 0).toLocaleString()}원`;

export default function StoreRankings() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [nameQuery, setNameQuery] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.getStoreRankings({ from: fromDate, to: new Date(toDate + 'T23:59:59').toISOString() });
      setData(result);
    } catch (e) {
      // 조회 실패 시 catch가 없어 서버 400/403이 unhandled rejection으로 사라지고 화면은 '데이터 없음'만 보여줬다 — 사용자는 기간을 잘못 넣은 건지 권한이 없는 건지 알 수 없었다.
      toast(e.message || '조회에 실패했습니다', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const applyQuickRange = (days) => {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    setFromDate(start.toISOString().split('T')[0]);
    setToDate(end.toISOString().split('T')[0]);
  };

  const filterByName = (rows) => nameQuery.trim()
    ? rows.filter(r => r.store_name?.toLowerCase().includes(nameQuery.trim().toLowerCase()))
    : rows;
  const salesRanking = filterByName(data?.salesRanking || []);
  const orderRanking = filterByName(data?.orderRanking || []);
  const efficiencyRanking = filterByName(data?.efficiencyRanking || []);

  const maxRevenue = Math.max(1, ...salesRanking.map(r => r.revenue));
  const maxOrderAmt = Math.max(1, ...orderRanking.map(r => r.order_amount));

  const exportRankings = () => {
    if (!data) return;
    const rows = [
      [`조회기간: ${fromDate} ~ ${toDate}`],
      [],
      ['매출 순위'],
      ['순위', '가맹점', '매출', '주문건수'],
      ...data.salesRanking.map((r, i) => [i + 1, r.store_name, r.revenue, r.order_count]),
      [],
      ['발주 순위'],
      ['순위', '가맹점', '발주금액', '발주건수'],
      ...data.orderRanking.map((r, i) => [i + 1, r.store_name, r.order_amount, r.order_count]),
      [],
      ['매출 대비 발주율'],
      ['순위', '가맹점', '매출', '발주금액', '발주율(%)'],
      ...data.efficiencyRanking.map((r, i) => [i + 1, r.store_name, r.revenue, r.order_amount, r.ratio ?? '']),
    ];
    exportCsv(`가맹점_순위_${fromDate}_${toDate}.csv`, rows);
  };

  return (
    <div>
      <div className="top-bar">
        <h2 className="mb-0">가맹점 순위</h2>
        <Button variant="secondary" onClick={exportRankings} disabled={!data}>⬇ 엑셀 다운로드</Button>
      </div>

      {/* 전용 검색 패널 레이아웃(kicc-search-panel/kicc-search-row/filter-field)은 legacy CSS 그대로 유지 */}
      <div className="card kicc-search-panel">
        <div className="kicc-search-row">
          <div className="filter-field">
            <label>가맹점명</label>
            <input value={nameQuery} onChange={e => setNameQuery(e.target.value)} placeholder="가맹점명 검색" />
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
                <Button key={r.label} type="button" variant="secondary" size="sm" onClick={() => applyQuickRange(r.days)}>{r.label}</Button>
              ))}
            </div>
          </div>
          <Button variant="primary" className="kicc-search-btn" onClick={load} disabled={loading}>
            {loading ? '조회 중...' : '조회'}
          </Button>
        </div>
      </div>

      <Card>
        <div className="font-bold mb-3">매출 순위</div>
        {loading ? <Loading /> : !data || salesRanking.length === 0 ? (
          <EmptyState>데이터 없음</EmptyState>
        ) : (
          <Table>
            <THead>
              <TR><TH>순위</TH><TH>가맹점</TH><TH>매출</TH><TH>주문건수</TH><TH></TH></TR>
            </THead>
            <TBody>
              {salesRanking.map((r, i) => (
                <TR key={r.store_id}>
                  <TD><b>{i + 1}</b></TD>
                  <TD>{r.store_name}</TD>
                  <TD><b className="text-brand">{won(r.revenue)}</b></TD>
                  <TD className="text-sub">{r.order_count.toLocaleString()}건</TD>
                  <TD className="w-[160px]">
                    <ProgressBar pct={(r.revenue / maxRevenue) * 100} color="var(--purple)" />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <div className="font-bold mb-3">발주 순위</div>
        {loading ? <Loading /> : !data || orderRanking.length === 0 ? (
          <EmptyState>데이터 없음</EmptyState>
        ) : (
          <Table>
            <THead>
              <TR><TH>순위</TH><TH>가맹점</TH><TH>발주금액</TH><TH>발주건수</TH><TH></TH></TR>
            </THead>
            <TBody>
              {orderRanking.map((r, i) => (
                <TR key={r.store_id}>
                  <TD><b>{i + 1}</b></TD>
                  <TD>{r.store_name}</TD>
                  <TD><b className="text-caution">{won(r.order_amount)}</b></TD>
                  <TD className="text-sub">{r.order_count.toLocaleString()}건</TD>
                  <TD className="w-[160px]">
                    <ProgressBar pct={(r.order_amount / maxOrderAmt) * 100} color="var(--color-warning)" />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <div className="font-bold mb-1">매출 대비 발주율</div>
        <div className="text-muted text-[12px] mb-3">
          발주율 = 발주금액 ÷ 매출. 매출에 비해 발주(원가 지출)가 얼마나 큰지 보여줍니다 — 높을수록 마진이 줄어들거나 과다 발주일 가능성, 매출이 있는데 발주율이 너무 낮으면 재고 소진/품절 위험이 있을 수 있습니다.
        </div>
        {loading ? <Loading /> : !data || efficiencyRanking.length === 0 ? (
          <EmptyState>데이터 없음</EmptyState>
        ) : (
          <Table>
            <THead>
              <TR><TH>가맹점</TH><TH>매출</TH><TH>발주금액</TH><TH>발주율</TH><TH>평가</TH></TR>
            </THead>
            <TBody>
              {efficiencyRanking.map(r => (
                <TR key={r.store_id}>
                  <TD>{r.store_name}</TD>
                  <TD>{won(r.revenue)}</TD>
                  <TD>{won(r.order_amount)}</TD>
                  <TD>
                    <b style={{ color: r.ratio === null ? 'var(--text-3)' : r.ratio > 80 ? '#dc2626' : r.ratio < 30 ? '#dc2626' : 'var(--text)' }}>
                      {r.ratio === null ? '-' : `${r.ratio}%`}
                    </b>
                  </TD>
                  <TD>
                    {r.ratio === null
                      ? <Badge tone="neutral">매출 없음</Badge>
                      : r.ratio > 80 ? <Badge tone="red">발주 과다 의심</Badge>
                      : r.ratio < 30 ? <Badge tone="red">발주 부족 의심</Badge>
                      : r.ratio <= 50 ? <Badge tone="green">양호</Badge>
                      : <Badge tone="yellow">주의</Badge>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
