import { toast } from '../toast';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { exportCsv } from '../exportCsv';
import {
  Button, Badge, Card, ElevatedCard, EmptyState,
  Table, THead, TBody, TR, TH, TD, Select, Input, confirmDialog, promptDialog,
} from '../components/ui';
import { STATUS_LABEL, STATUS_COLOR, NEXT_STATUSES, ACTIVE_STATUSES, DONE_STATUSES, ITEM_STATUS } from '../constants/orderStatus';

const LOGISTICS_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN', 'HQ_LOGISTICS'];

// 환불 사유를 자유 텍스트로만 받으면 나중에 "어떤 사유가 잦은지" 통계를 낼 수 없어서
// 코드를 같이 받는다 — 자유 텍스트(reason)는 그대로 두고, 분류용 코드만 추가로 선택받는다.
const REFUND_REASON_CODES = [
  { code: 'DAMAGED', label: '파손/불량' },
  { code: 'WRONG_ITEM', label: '오배송' },
  { code: 'OUT_OF_STOCK', label: '품절' },
  { code: 'STORE_REQUEST', label: '가맹점 요청 취소' },
  { code: 'OTHER', label: '기타' },
];

async function promptReasonCode() {
  const value = await promptDialog({
    title: '환불 사유 분류를 선택하세요',
    defaultValue: REFUND_REASON_CODES[0].code,
    options: REFUND_REASON_CODES.map(r => ({ value: r.code, label: r.label })),
  });
  if (value === null) return undefined;
  return value || 'OTHER';
}

function exportExcel(detail) {
  const rows = [
    ['발주서 #' + detail.id, detail.store_name, STATUS_LABEL[detail.status], new Date(detail.created_at).toLocaleDateString('ko-KR')],
    [],
    ['상품명', '단위', '발주량', '확정량', '단가', '금액', '상태', '대체메모'],
    ...(detail.items || []).map(i => [
      i.product_name, i.unit, i.quantity, i.confirmed_quantity ?? i.quantity,
      i.unit_price, i.amount, i.status === 'OUT_OF_STOCK' ? '품절' : '정상', i.substitute_note || '',
    ]),
    [],
    ['', '', '', '', '', '확정금액', detail.confirmed_amount ?? detail.total_amount],
  ];
  exportCsv(`발주서_${detail.id}_${detail.store_name}.csv`, rows);
}

function exportOrderList(orders) {
  const rows = [
    ['가맹점', '발주일', '상태', '금액'],
    ...orders.map(o => [
      o.store_name, new Date(o.created_at).toLocaleDateString('ko-KR'),
      STATUS_LABEL[o.status], o.confirmed_amount ?? o.total_amount,
    ]),
  ];
  exportCsv(`발주_목록_${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

// 상태별 색상이 브랜드 팔레트(red/green/yellow)로 고정된 Badge 프리미티브 범위를 넘어서므로
// (주문 상태는 12가지 색을 데이터 기반으로 매핑) 색상만 인라인 style로 유지한다.
function StatusBadge({ status }) {
  const c = STATUS_COLOR[status] || '#64748b';
  return (
    <span
      className="inline-flex items-center rounded-[6px] px-[9px] py-[3px] text-[12px] font-semibold"
      style={{ background: c + '22', color: c }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export default function HQOrders() {
  const { user } = useAuth();
  const canEdit = LOGISTICS_ROLES.includes(user?.role);
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState('active');
  const [refundQty, setRefundQty] = useState({});

  const load = () => api.getOrders().then(setOrders).catch(() => {});
  useEffect(() => { load(); }, []);

  const loadDetail = async (id) => {
    const d = await api.getOrder(id);
    setDetail(d);
    setSelected(id);
    setRefundQty({});
  };

  const reject = async (order) => {
    const reason = await promptDialog({ title: '수정 요청 사유를 입력하세요' });
    if (!reason) return;
    try {
      await api.changeOrderStatus(order.id, 'REVISION_REQUESTED', reason);
      load();
    } catch (e) {
      toast(e.message || '상태 변경에 실패했습니다', 'error');
    }
  };

  const refund = async (order) => {
    const total = Math.round(order.confirmed_amount ?? order.total_amount);
    const remaining = total - Math.round(order.refunded_amount || 0);
    const amountInput = await promptDialog({
      title: `환불 금액을 입력하세요 (전액: ${remaining.toLocaleString()}원)`,
      defaultValue: String(remaining),
      inputType: 'number',
    });
    if (amountInput === null) return;
    const amount = Number(amountInput.replace(/[^0-9]/g, ''));
    if (!amount || amount <= 0 || amount > remaining) { toast('환불 금액이 올바르지 않습니다', 'error'); return; }
    const reason = await promptDialog({ title: '환불 사유를 입력하세요' });
    if (!reason) return;
    const reasonCode = await promptReasonCode();
    if (reasonCode === undefined) return;
    const ok = await confirmDialog({ title: `${amount.toLocaleString()}원이 환불됩니다. 실제 카드 결제가 취소됩니다. 진행하시겠습니까?` });
    if (!ok) return;
    try {
      await api.refundOrder(order.id, reason, amount, reasonCode);
      toast('환불이 완료되었습니다', 'success');
      loadDetail(order.id);
      load();
    } catch (e) {
      toast(e.message || '환불에 실패했습니다', 'error');
    }
  };

  const refundItems = async (order) => {
    const items = Object.entries(refundQty)
      .map(([item_id, qty]) => ({ item_id: Number(item_id), quantity: Number(qty) }))
      .filter(i => i.quantity > 0);
    if (items.length === 0) { toast('환불할 품목의 수량을 입력해주세요', 'error'); return; }
    const total = items.reduce((s, i) => {
      const item = order.items.find(x => x.id === i.item_id);
      return s + (item ? item.unit_price * i.quantity : 0);
    }, 0);
    const reason = await promptDialog({
      title: `선택한 품목 환불 금액: ${total.toLocaleString()}원`,
      description: '환불 사유를 입력하세요',
    });
    if (!reason) return;
    const reasonCode = await promptReasonCode();
    if (reasonCode === undefined) return;
    const ok = await confirmDialog({ title: `${total.toLocaleString()}원이 환불됩니다. 실제 카드 결제가 취소됩니다. 진행하시겠습니까?` });
    if (!ok) return;
    try {
      await api.refundOrderItems(order.id, reason, items, reasonCode);
      toast('환불이 완료되었습니다', 'success');
      loadDetail(order.id);
      load();
    } catch (e) {
      toast(e.message || '환불에 실패했습니다', 'error');
    }
  };

  const visibleOrders = orders.filter(o =>
    tab === 'active' ? ACTIVE_STATUSES.includes(o.status) : DONE_STATUSES.includes(o.status)
  );

  const [refundStats, setRefundStats] = useState(null);
  const toggleRefundStats = async () => {
    if (refundStats) { setRefundStats(null); return; }
    try {
      const rows = await api.getRefundReasons();
      setRefundStats(rows);
    } catch (e) {
      toast(e.message || '환불 사유 통계를 불러오지 못했습니다', 'error');
    }
  };

  // 가맹점 담당자로 지정 안 된 본사 계정도 검수 이상신고를 놓치지 않도록, 발주관리 화면에서
  // 전체 가맹점 기준으로 한 번에 모아 보여준다 (담당자별로만 보이던 "내 업무"의 사각지대 보완)
  const [receiptIssues, setReceiptIssues] = useState([]);
  const [showReceiptIssues, setShowReceiptIssues] = useState(false);
  const loadReceiptIssues = () => api.getReceiptIssues().then(setReceiptIssues).catch(() => {});
  useEffect(() => { loadReceiptIssues(); }, []);
  const resolveIssue = async (orderId) => {
    try {
      await api.resolveReceiptIssue(orderId);
      toast('처리완료로 표시되었습니다', 'success');
      loadReceiptIssues();
      load();
    } catch (e) {
      toast(e.message || '처리에 실패했습니다', 'error');
    }
  };

  return (
    <div className="split-layout grid gap-5" style={{ gridTemplateColumns: detail ? '1fr 480px' : '1fr' }}>
      <div>
        <div className="top-bar">
          <h2>주문 관리</h2>
          <div className="flex items-center gap-2">
            <Button variant={tab === 'active' ? 'primary' : 'secondary'} onClick={() => { setTab('active'); setDetail(null); setSelected(null); }}>
              처리중 {orders.filter(o => ACTIVE_STATUSES.includes(o.status)).length > 0 && `(${orders.filter(o => ACTIVE_STATUSES.includes(o.status)).length})`}
            </Button>
            <Button variant={tab === 'done' ? 'primary' : 'secondary'} onClick={() => { setTab('done'); setDetail(null); setSelected(null); }}>
              완료/취소
            </Button>
            <div className="w-px h-5 bg-line mx-1" />
            <Button variant="secondary" onClick={toggleRefundStats}>환불 사유 통계</Button>
            <Button variant="secondary" onClick={() => setShowReceiptIssues(v => !v)}>
              검수 이상신고{receiptIssues.length > 0 && ` (${receiptIssues.length})`}
            </Button>
            <Button variant="secondary" onClick={() => exportOrderList(visibleOrders)}>⬇ 엑셀 다운로드</Button>
          </div>
        </div>
        {showReceiptIssues && (
          <Card className="mb-4">
            <div className="font-bold mb-2">처리 대기 중인 검수 이상신고</div>
            {receiptIssues.length === 0
              ? <EmptyState>처리할 이상신고가 없습니다</EmptyState>
              : receiptIssues.map(r => (
                <div key={r.id} className="flex justify-between items-center text-xs mb-2 gap-[10px]">
                  <div>
                    <b>{r.store_name}</b> — 발주서 #{r.id}
                    <div className="text-muted mt-0.5">{r.receipt_issue_note}</div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => resolveIssue(r.id)}>처리완료</Button>
                </div>
              ))}
          </Card>
        )}
        {refundStats && (
          <Card className="mb-4">
            <div className="font-bold mb-2">환불 사유 통계 (최근 30일)</div>
            {refundStats.length === 0
              ? <EmptyState>환불 사유 데이터가 없습니다</EmptyState>
              : refundStats.map(r => (
                <div key={r.reason_code} className="flex justify-between text-xs mb-1">
                  <span>{REFUND_REASON_CODES.find(c => c.code === r.reason_code)?.label || r.reason_code}</span>
                  <span className="font-bold">{r.count}건</span>
                </div>
              ))}
          </Card>
        )}
        <Card className="tab-content" key={tab}>
          {visibleOrders.length === 0
            ? <EmptyState>{tab === 'active' ? '처리할 주문 없음' : '완료된 주문 없음'}</EmptyState>
            : <Table>
              <THead>
                <TR><TH>가맹점</TH><TH>발주일</TH><TH>상태</TH><TH>금액</TH>{tab === 'active' && canEdit && <TH>상태 변경</TH>}</TR>
              </THead>
              <TBody>
                {visibleOrders.map(o => (
                  <TR key={o.id} className="cursor-pointer" style={{ background: selected === o.id ? 'var(--bg-elevated)' : '' }}
                    onClick={() => loadDetail(o.id)}>
                    <TD><b>{o.store_name}</b></TD>
                    <TD className="text-sub text-xs">{new Date(o.created_at).toLocaleDateString('ko-KR')}</TD>
                    <TD>
                      <StatusBadge status={o.status} />
                      {o.status === 'PAYMENT_PENDING' && o.updated_at && !isNaN(new Date(o.updated_at)) && (Date.now() - new Date(o.updated_at).getTime() > 24 * 3600000) && (
                        <Badge tone="red" className="ml-1.5" title="결제대기 24시간 이상 경과">방치</Badge>
                      )}
                      {o.receipt_issue_note && !o.receipt_issue_resolved_at && (
                        <Badge tone="red" className="ml-1.5" title="가맹점이 수령 이상을 신고함">검수이상</Badge>
                      )}
                    </TD>
                    <TD>{(o.confirmed_amount ?? o.total_amount).toLocaleString()}원</TD>
                    {tab === 'active' && canEdit && (
                      <TD onClick={e => e.stopPropagation()}>
                        <Select
                          value={o.status}
                          onValueChange={async next => {
                            if (next === o.status) return;
                            if (next === 'REVISION_REQUESTED') { reject(o); return; }
                            try {
                              await api.changeOrderStatus(o.id, next);
                              load();
                              if (selected === o.id) loadDetail(o.id);
                            } catch (e) {
                              toast(e.message || '상태 변경에 실패했습니다', 'error');
                            }
                          }}
                          className="w-auto px-2 py-[5px] text-[12px]"
                          options={[
                            { value: o.status, label: STATUS_LABEL[o.status] },
                            // 예전엔 STATUS_FLOW.slice(indexOf+1)이라 REVIEWING에서 SHIPPED로 몇 단계든
                            // 건너뛸 수 있었고, 서버 검증이 없던 시절엔 이게 유일한 가드였다. 이제 서버
                            // (orderStatusFlow.js)가 같은 표로 검증하며, 화면은 다음 단계만 노출한다.
                            ...(NEXT_STATUSES[o.status] || [])
                              .filter(s => s !== 'CANCELED')
                              .map(s => ({ value: s, label: STATUS_LABEL[s] })),
                          ]}
                        />
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          }
        </Card>
      </div>

      {detail && (
        <Card className="sticky top-0 max-h-[90vh] overflow-y-auto">
          <div className="flex justify-between mb-1">
            <div className="font-bold text-[16px]">발주서 #{detail.id} — {detail.store_name}</div>
            <div className="flex gap-1.5">
              <Button variant="secondary" size="sm" onClick={() => window.open(`/orders/${detail.id}/invoice`, '_blank')}>거래명세서</Button>
              <Button variant="secondary" size="sm" onClick={() => { setDetail(null); setSelected(null); }}>닫기</Button>
            </div>
          </div>
          {(detail.created_by_name || detail.assigned_user_name) && (
            <div className="text-muted text-[12.5px] mb-3">
              {detail.created_by_name && <>작성자: {detail.created_by_name}</>}
              {detail.created_by_name && detail.assigned_user_name && ' · '}
              {detail.assigned_user_name && <>담당자: {detail.assigned_user_name}</>}
            </div>
          )}

          <div className="mb-4 flex items-center gap-[10px]">
            <StatusBadge status={detail.status} />
            {detail.refunded_amount > 0 && (
              <Badge tone="yellow">환불 {detail.refunded_amount.toLocaleString()}원</Badge>
            )}
            {detail.receipt_confirmed_at && <Badge tone="green">수령확인 완료</Badge>}
            {canEdit && ['PAID', 'PREPARING_SHIPMENT', 'SHIPPED', 'DELIVERED', 'CLOSED'].includes(detail.status) && (
              <Button variant="secondary" size="sm" onClick={() => refund(detail)}>
                {detail.refunded_amount > 0 ? '추가 금액 환불' : '금액 환불'}
              </Button>
            )}
          </div>
          {detail.receipt_issue_note && (
            <ElevatedCard className="p-[10px] text-xs mb-4 border-l-[3px] border-l-[#ef4444]">
              <div className="font-bold text-[#ef4444] mb-1">가맹점 검수 이상신고</div>
              {detail.receipt_issue_note}
              {!detail.receipt_issue_resolved_at && canEdit && (
                <div className="mt-2">
                  <Button variant="secondary" size="sm" onClick={async () => {
                    try {
                      await api.resolveReceiptIssue(detail.id);
                      toast('처리완료로 표시되었습니다', 'success');
                      loadDetail(detail.id);
                      load();
                    } catch (e) {
                      toast(e.message || '처리에 실패했습니다', 'error');
                    }
                  }}>처리완료로 표시</Button>
                </div>
              )}
              {detail.receipt_issue_resolved_at && <div className="text-sub mt-1.5">처리완료됨</div>}
            </ElevatedCard>
          )}
          {canEdit && ['PAID', 'PREPARING_SHIPMENT', 'SHIPPED', 'DELIVERED', 'CLOSED'].includes(detail.status) && (
            <div className="text-muted text-[12px] mb-2">
              아래 표에서 반품된 품목의 수량을 입력하면 해당 품목만 환불(재고도 함께 차감)됩니다.
            </div>
          )}

          <Table className="mb-4">
            <THead><TR><TH>상품</TH><TH>단위</TH><TH>발주량</TH><TH>확정량</TH><TH>상태</TH><TH>대체/메모</TH><TH>금액</TH>
              {canEdit && ['PAID', 'PREPARING_SHIPMENT', 'SHIPPED', 'DELIVERED', 'CLOSED'].includes(detail.status) && <TH>환불수량</TH>}
            </TR></THead>
            <TBody>
              {detail.items?.map(item => {
                const editable = canEdit && ['REVIEWING', 'CONFIRMED'].includes(detail.status);
                const isOOS = item.status === ITEM_STATUS.OUT_OF_STOCK;
                const refundable = canEdit && ['PAID', 'PREPARING_SHIPMENT', 'SHIPPED', 'DELIVERED', 'CLOSED'].includes(detail.status);
                const maxRefundQty = (item.confirmed_quantity ?? item.quantity) - (item.refunded_quantity || 0);
                return (
                  <TR key={item.id} className={isOOS ? 'opacity-50' : ''}>
                    <TD>{item.product_name}</TD>
                    <TD>{item.unit}</TD>
                    <TD>{item.quantity}</TD>
                    <TD>
                      {editable
                        ? <Input type="number" defaultValue={item.confirmed_quantity ?? item.quantity}
                            className="w-[70px]"
                            onBlur={async e => {
                              const raw = e.target.value;
                              const q = Number(raw);
                              const original = item.confirmed_quantity ?? item.quantity;
                              if (raw === '' || !Number.isFinite(q) || q < 0 || q > item.quantity) {
                                toast(`확정 수량은 0 이상 ${item.quantity} 이하의 숫자여야 합니다`, 'error');
                                e.target.value = original;
                                return;
                              }
                              if (q === original) return;
                              try {
                                await api.updateOrderItem(detail.id, item.id, { confirmed_quantity: q });
                                loadDetail(detail.id);
                              } catch (err) {
                                toast(err.message || '수량 변경에 실패했습니다', 'error');
                                e.target.value = original;
                              }
                            }} />
                        : (item.confirmed_quantity ?? item.quantity)
                      }
                    </TD>
                    <TD>
                      {editable ? (
                        <Button
                          variant={isOOS ? 'primary' : 'secondary'}
                          size="sm"
                          className={isOOS ? 'bg-[#dc2626] hover:bg-[#dc2626]' : ''}
                          onClick={async () => {
                            try {
                              await api.updateOrderItem(detail.id, item.id, { status: isOOS ? ITEM_STATUS.NORMAL : ITEM_STATUS.OUT_OF_STOCK });
                              loadDetail(detail.id);
                            } catch (e) {
                              toast(e.message || '상태 변경에 실패했습니다', 'error');
                            }
                          }}
                        >
                          {isOOS ? '품절' : '정상'}
                        </Button>
                      ) : (
                        <Badge tone={isOOS ? 'red' : 'green'}>{isOOS ? '품절' : '정상'}</Badge>
                      )}
                    </TD>
                    <TD>
                      {editable ? (
                        <Input
                          defaultValue={item.substitute_note || ''}
                          placeholder="대체 메모"
                          className="w-[120px] text-[12px]"
                          onBlur={async e => {
                            // 값이 안 바뀌었으면 요청을 보내지 않는다 — blur마다 매번 갱신 요청이
                            // 나가면 방문 순서에 따라 뒤늦게 도착한 요청이 최신 값을 덮어쓸 수 있다.
                            if (e.target.value === (item.substitute_note || '')) return;
                            try {
                              await api.updateOrderItem(detail.id, item.id, { substitute_note: e.target.value });
                            } catch (err) {
                              toast(err.message || '메모 변경에 실패했습니다', 'error');
                            }
                          }}
                        />
                      ) : (
                        <span className="text-sub text-[12px]">{item.substitute_note || '-'}</span>
                      )}
                    </TD>
                    <TD>{(item.amount ?? Math.round(item.unit_price * (item.confirmed_quantity ?? item.quantity))).toLocaleString()}원</TD>
                    {refundable && (
                      <TD>
                        {maxRefundQty > 0 ? (
                          <Input type="number" min={0} max={maxRefundQty} placeholder="0"
                            value={refundQty[item.id] ?? ''}
                            onChange={e => setRefundQty(q => ({ ...q, [item.id]: e.target.value }))}
                            className="w-[60px] text-center" />
                        ) : (
                          <Badge tone="yellow" className="text-[11px]">전량 환불됨</Badge>
                        )}
                      </TD>
                    )}
                  </TR>
                );
              })}
            </TBody>
          </Table>

          {canEdit && ['PAID', 'PREPARING_SHIPMENT', 'SHIPPED', 'DELIVERED', 'CLOSED'].includes(detail.status) && (
            <div className="mb-4">
              <Button variant="secondary" size="sm" onClick={() => refundItems(detail)}>선택 품목 환불</Button>
            </div>
          )}

          <div className="flex justify-between items-center mb-4">
            <div className="font-bold">
              확정금액: {(detail.confirmed_amount ?? detail.total_amount).toLocaleString()}원
            </div>
            <Button variant="secondary" size="sm" onClick={() => exportExcel(detail)}>⬇ 엑셀 다운로드</Button>
          </div>

          {detail.memo && (
            <ElevatedCard className="p-3 text-xs mb-4">
              메모: {detail.memo}
            </ElevatedCard>
          )}

          {detail.history?.length > 0 && (
            <>
              <div className="font-semibold mb-2">처리 이력</div>
              {detail.history.map(h => (
                <div key={h.id} className="text-muted text-[12px] mb-1">
                  {new Date(h.created_at).toLocaleString('ko-KR')} — {h.changed_by_name || '시스템'}: {h.action}
                  {h.reason && ` (${h.reason})`}
                </div>
              ))}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
