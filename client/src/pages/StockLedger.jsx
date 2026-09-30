import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { useStore } from '../StoreContext';
import {
  Button, Badge, Card, EmptyState, Field, FieldRow, Input, Select,
  Table, THead, TBody, TR, TH, TD,
} from '../components/ui';

const TYPE_LABEL = {
  DELIVERY: '입고 (납품)', REFUND: '환불 (입고취소)',
  SALE: '판매 차감', SALE_CANCEL: '판매취소 복구',
  WASTE: '폐기', WASTE_CANCEL: '폐기취소 복구',
  ADJUSTMENT: '실사 조정',
};
const TYPE_COLOR = {
  DELIVERY: 'green', REFUND: 'red', SALE: 'red', SALE_CANCEL: 'green',
  WASTE: 'red', WASTE_CANCEL: 'green', ADJUSTMENT: 'yellow',
};

// Radix Select는 value="" 를 허용하지 않아 "전체"는 'ALL' sentinel로 표현하고
// 핸들러에서 API가 기대하는 빈 문자열(ingredientId)로 되돌린다.
const ALL_INGREDIENTS = 'ALL';

export default function StockLedger() {
  const { user } = useAuth();
  const storeCtx = useStore();
  const currentStore = storeCtx?.currentStore || (user?.store_id ? { id: user.store_id } : null);
  const [ingredients, setIngredients] = useState([]);
  const [rows, setRows] = useState([]);
  const [ingredientId, setIngredientId] = useState('');
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    if (!currentStore) return;
    api.getIngredients(currentStore.id).then(setIngredients).catch(() => {});
  }, [currentStore?.id]);

  const load = () => {
    if (!currentStore) return;
    api.getStockLedger({ store_id: currentStore.id, ingredient_id: ingredientId || undefined, from, to }).then(setRows).catch(() => {});
  };
  useEffect(() => { load(); }, [currentStore?.id]);

  if (!currentStore) return <EmptyState>가맹점을 선택해주세요</EmptyState>;

  return (
    <div>
      <div className="top-bar">
        <h2>상품별 거래 수불</h2>
      </div>

      <Card className="mb-5">
        <FieldRow>
          <Field label="재료">
            <Select
              value={ingredientId === '' ? ALL_INGREDIENTS : String(ingredientId)}
              onValueChange={v => setIngredientId(v === ALL_INGREDIENTS ? '' : v)}
              options={[{ value: ALL_INGREDIENTS, label: '전체' }, ...ingredients.map(i => ({ value: String(i.id), label: i.name }))]}
            />
          </Field>
          <Field label="시작일">
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </Field>
          <Field label="종료일">
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
          </Field>
          <Field>
            <Button variant="primary" onClick={load}>조회</Button>
          </Field>
        </FieldRow>
      </Card>

      <Card>
        {rows.length === 0 ? <EmptyState>조회된 내역이 없습니다</EmptyState> : (
          <Table>
            <THead><TR><TH>일시</TH><TH>재료</TH><TH>구분</TH><TH>변동량</TH><TH>변동 후 재고</TH><TH>메모</TH><TH>처리자</TH></TR></THead>
            <TBody>
              {rows.map(r => (
                <TR key={r.id}>
                  <TD className="text-muted text-[12px]">{new Date(r.created_at).toLocaleString('ko-KR')}</TD>
                  <TD><b>{r.ingredient_name}</b></TD>
                  <TD><Badge tone={TYPE_COLOR[r.type]}>{TYPE_LABEL[r.type] || r.type}</Badge></TD>
                  <TD style={{ color: r.quantity_delta > 0 ? '#16a34a' : r.quantity_delta < 0 ? '#dc2626' : undefined, fontWeight: 600 }}>
                    {r.quantity_delta > 0 ? '+' : ''}{r.quantity_delta} {r.unit}
                  </TD>
                  <TD>{r.after_stock != null ? `${r.after_stock} ${r.unit}` : '-'}</TD>
                  <TD className="text-muted text-xs">{r.memo || '-'}</TD>
                  <TD className="text-muted text-xs">{r.created_by_name || '-'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
