import { toast } from '../toast';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { Button, Badge, Card, EmptyState, ProgressBar, Table, THead, TBody, TR, TH, TD, Input } from '../components/ui';

// 제어 input에서 빈 문자열을 무시하면 백스페이스로 지우는 순간 값이 되살아나 아예 비울 수 없었고,
// onBlur의 빈값 분기는 도달 불가였다. 목록 map 안에서는 훅을 쓸 수 없어 컴포넌트로 뺀다.
function CartQtyInput({ qty, onChange }) {
  const [raw, setRaw] = useState(String(qty));
  useEffect(() => { if (Number(raw) !== qty) setRaw(String(qty)); }, [qty]);
  return (
    <Input type="number" min={1} className="w-[60px] text-center" value={raw}
      onChange={e => { const v = e.target.value; setRaw(v); const n = Number(v); if (v !== '' && Number.isInteger(n) && n >= 1) onChange(n); }}
      onBlur={() => { const n = Number(raw); if (raw === '' || !Number.isInteger(n) || n < 1) { setRaw('1'); onChange(1); } else setRaw(String(n)); }} />
  );
}

export default function StoreStock() {
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [qty, setQty] = useState({});
  const [cart, setCart] = useState([]); // [{ product, quantity, ingredientName }]
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    if (!user?.store_id) return;
    api.getIngredients(user.store_id).then(setList).catch(() => {});
    api.getProducts().then(setProducts).catch(() => {});
  };

  useEffect(() => { load(); }, [user?.store_id]);

  const findProduct = (ingredient) =>
    products.find(p => p.ingredient_id === ingredient.id) ||
    products.find(p => p.name === ingredient.name);

  const addToCart = (ingredient) => {
    const product = findProduct(ingredient);
    if (!product) { toast('연결된 발주 상품이 없어 자동 주문할 수 없습니다. 매입발주 메뉴에서 상품을 등록해주세요.', 'error'); return; }
    const quantity = Number(qty[ingredient.id]) || 1;
    setCart(c => {
      const existing = c.find(e => e.product.id === product.id);
      if (existing) return c.map(e => e.product.id === product.id ? { ...e, quantity: e.quantity + quantity } : e);
      return [...c, { product, quantity, ingredientName: ingredient.name }];
    });
    setQty(q => ({ ...q, [ingredient.id]: '' }));
  };

  const updateCartQty = (productId, quantity) => {
    if (quantity <= 0) setCart(c => c.filter(e => e.product.id !== productId));
    else setCart(c => c.map(e => e.product.id === productId ? { ...e, quantity } : e));
  };

  const removeFromCart = (productId) => setCart(c => c.filter(e => e.product.id !== productId));

  const cartTotal = cart.reduce((s, e) => s + e.product.price * e.quantity, 0);

  const submitCart = async () => {
    if (cart.length === 0) return;
    setSubmitting(true);
    try {
      await api.createOrder({
        submit: true,
        memo: '재고관리에서 추가주문',
        items: cart.map(e => ({
          product_id: e.product.id, product_name: e.product.name,
          unit: e.product.unit, unit_price: e.product.price, quantity: e.quantity,
        })),
      });
      toast('발주가 완료되었습니다', 'success');
      setCart([]);
    } catch (e) {
      toast(e.message || '발주에 실패했습니다', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="top-bar">
        <h2>재고 확인</h2>
        <Button variant="secondary" onClick={load}>새로고침</Button>
      </div>

      <div className="split-layout grid grid-cols-[1fr_320px] gap-5">
        <Card>
          {list.length === 0 ? (
            <EmptyState>등록된 재고 없음 (납품 완료 시 자동 등록됩니다)</EmptyState>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>식자재명</TH>
                  <TH>현재 재고</TH>
                  <TH>알림 기준</TH>
                  <TH>상태</TH>
                  <TH>장바구니 담기</TH>
                </TR>
              </THead>
              <TBody>
                {list.map(i => {
                  const low = i.threshold > 0 && i.stock <= i.threshold;
                  const pct = i.threshold > 0 ? Math.min((i.stock / (i.threshold * 2)) * 100, 100) : 50;
                  const product = findProduct(i);
                  return (
                    <TR key={i.id}>
                      <TD><b>{i.name || <span className="text-alert">(이름 없음)</span>}</b></TD>
                      <TD>
                        {i.stock} {i.unit}
                        <ProgressBar pct={pct} color={low ? 'var(--color-danger)' : 'var(--color-success)'} />
                      </TD>
                      <TD>{i.threshold > 0 ? `${i.threshold} ${i.unit}` : <span className="text-[#64748b] text-[12px]">미설정</span>}</TD>
                      <TD>
                        <Badge tone={low ? 'red' : 'green'}>{low ? '부족' : '정상'}</Badge>
                      </TD>
                      <TD>
                        {product ? (
                          <div className="flex gap-1.5 items-center">
                            <Input type="number" min={1} placeholder="수량"
                              value={qty[i.id] ?? ''}
                              onChange={e => setQty(q => ({ ...q, [i.id]: e.target.value }))}
                              className="w-[60px] text-center" />
                            <span className="text-sub text-[12px]">{product.unit}</span>
                            <Button variant="primary" size="sm" onClick={() => addToCart(i)}>담기</Button>
                          </div>
                        ) : (
                          <span className="text-[#94a3b8] text-[12px]">연결 상품 없음</span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>

        <Card className="sticky top-0 self-start">
          <div className="font-bold mb-3">장바구니</div>
          {cart.length === 0 ? (
            <EmptyState>담은 항목이 없습니다</EmptyState>
          ) : (
            <>
              {cart.map(e => (
                <div key={e.product.id} className="flex items-center gap-2 mb-2.5">
                  <div className="flex-1 text-[14px]">{e.product.name}</div>
                  <CartQtyInput qty={e.quantity} onChange={n => updateCartQty(e.product.id, n)} />
                  <div className="text-sub text-xs min-w-[70px] text-right">
                    {(e.product.price * e.quantity).toLocaleString()}원
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => removeFromCart(e.product.id)}>×</Button>
                </div>
              ))}
              <div className="border-t border-line mt-3 pt-3 font-bold text-right">
                합계: {cartTotal.toLocaleString()}원
              </div>
              <Button variant="primary" className="w-full mt-3" disabled={submitting} onClick={submitCart}>
                {submitting ? '발주 중...' : '발주하기'}
              </Button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
