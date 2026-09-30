import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, LoadingState, Table, THead, TBody, TR, TH, TD } from '../components/ui';
import { STATUS_LABEL } from '../constants/orderStatus';

// 브라우저 인쇄(window.print())만으로 거래명세서를 출력할 수 있게 한 별도 페이지.
// PDF 라이브러리 없이 @media print 규칙으로 네비/사이드메뉴를 숨기고 이 영역만 인쇄되게 한다.
export default function OrderInvoice() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);

  useEffect(() => { api.getOrder(id).then(setOrder).catch(() => {}); }, [id]);

  if (!order) return <LoadingState>불러오는 중...</LoadingState>;

  // `purchase_order_items.amount`가 생성 시점 값으로 굳어 수량 조정 후 행 금액·합계가 어긋났다.
  // 서버(`PUT /:id/items/:itemId`)가 이제 amount를 함께 갱신하므로 정상 경로에서는 값이 맞고,
  // 이 폴백은 아직 갱신되지 않은 과거 행을 위한 것이다.
  const rowAmount = (item) => item.amount ?? Math.round(item.unit_price * (item.confirmed_quantity ?? item.quantity));
  // items가 빈 배열이면 reduce가 0을 반환해 `??` 폴백이 발동하지 않으므로 길이로 먼저 분기한다.
  const total = order.items?.length ? order.items.reduce((sum, item) => sum + rowAmount(item), 0) : (order.confirmed_amount ?? order.total_amount);

  return (
    <div>
      <div className="no-print mb-4 flex gap-2">
        <Button variant="primary" onClick={() => window.print()}>인쇄</Button>
      </div>
      <Card className="print-invoice max-w-[720px] mx-auto p-8">
        <div className="flex justify-between items-start mb-6">
          <div>
            <div className="text-[22px] font-extrabold">거래명세서</div>
            <div className="text-sub text-xs mt-1">발주서 #{order.id}</div>
          </div>
          <div className="text-sub text-right text-xs">
            <div>발주일: {new Date(order.created_at).toLocaleDateString('ko-KR')}</div>
            <div>상태: {STATUS_LABEL[order.status] || order.status}</div>
          </div>
        </div>

        <div className="flex justify-between mb-5 text-xs">
          <div>
            <div className="text-sub">가맹점</div>
            <div className="font-bold">{order.store_name || '-'}</div>
          </div>
          <div>
            <div className="text-sub">작성자</div>
            <div className="font-bold">{order.created_by_name || '-'}</div>
          </div>
        </div>

        <Table className="mb-4">
          <THead>
            <TR><TH>상품</TH><TH>수량</TH><TH>단가</TH><TH>금액</TH></TR>
          </THead>
          <TBody>
            {order.items?.map(item => (
              <TR key={item.id}>
                <TD>{item.product_name}</TD>
                <TD>{(item.confirmed_quantity ?? item.quantity)} {item.unit}</TD>
                <TD>{item.unit_price.toLocaleString()}원</TD>
                <TD>{rowAmount(item).toLocaleString()}원</TD>
              </TR>
            ))}
          </TBody>
        </Table>

        <div className="text-right text-[16px] font-extrabold border-t-2 border-line pt-3">
          합계: {total.toLocaleString()}원
        </div>

        {order.memo && (
          <div className="mt-5 text-xs">
            <div className="text-sub">메모</div>
            <div>{order.memo}</div>
          </div>
        )}
      </Card>
    </div>
  );
}
