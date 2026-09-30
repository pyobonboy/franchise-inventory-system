import { toast } from '../toast';
import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../api';
import { payForOrder } from '../payment';
import { cn } from '../lib/cn';
import {
  Button, Badge, Card, ElevatedCard, Input, Textarea,
  confirmDialog, promptDialog, Tip,
  Table, THead, TBody, TR, TH, TD, EmptyState,
} from '../components/ui';
import { STATUS_LABEL, STATUS_COLOR, ITEM_STATUS } from '../constants/orderStatus';

function StatusBadge({ status }) {
  const c = STATUS_COLOR[status] || '#64748b';
  return (
    <span className="px-2 py-0.5 rounded-[6px] text-[12px] font-semibold" style={{ background: c + '22', color: c }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/* ── 수량 스텝퍼 ─────────────────────────────────────── */
function QtyControl({ qty, onMinus, onPlus, onChange }) {
  // 제어 input에서 빈 문자열을 무시하면(예전 `if (v === '') return`) 백스페이스로 지우는 순간 값이
  // 되살아나 아예 비울 수 없었고, onBlur의 빈값 분기는 도달조차 하지 않았다. 화면에 보이는 값은
  // raw(문자열)로 따로 들고, 유효한 정수일 때만 부모 상태에 반영한다.
  const [raw, setRaw] = useState(String(qty));
  // 부모가 qty를 바꾼 경우(+/− 버튼, 템플릿 불러오기)만 따라간다. 타이핑 중인 값을 덮어쓰지 않도록
  // "현재 raw를 숫자로 읽은 값과 다를 때"만 동기화한다.
  useEffect(() => { if (Number(raw) !== qty) setRaw(String(qty)); }, [qty]);
  return (
    <div className="flex items-center border border-line rounded-sm overflow-hidden shrink-0">
      <button type="button" className="qty-btn w-8 h-8 bg-muted border-none rounded-none text-[18px] font-light text-fg-2 cursor-pointer flex items-center justify-center p-0 shrink-0" onClick={onMinus}>
        −
      </button>
      <input type="number" className="qty-input w-11 h-8 text-center border-none border-x border-line rounded-none text-[14px] font-bold p-0 outline-none bg-card shadow-none" value={raw} min={1}
        onChange={e => {
          const v = e.target.value;
          setRaw(v);
          const n = Number(v);
          if (v !== '' && Number.isInteger(n) && n >= 1) onChange(n);
        }}
        onBlur={() => {
          const n = Number(raw);
          if (raw === '' || !Number.isInteger(n) || n < 1) { setRaw('1'); onChange(1); }
          else setRaw(String(n));
        }}
      />
      <button type="button" className="qty-btn w-8 h-8 bg-muted border-none rounded-none text-[18px] font-light text-fg-2 cursor-pointer flex items-center justify-center p-0 shrink-0" onClick={onPlus}>
        +
      </button>
    </div>
  );
}

/* ── 장바구니 패널 ────────────────────────────────────── */
function CartPanel({ cart, total, updateQty, memo, setMemo, submitOrder, submitting, saveAsTemplate, templates, loadTemplateToCart, deleteTemplate, editingOrderId, onClose, isMobileDrawer }) {
  const isEmpty = cart.length === 0;

  return (
    <div className={cn('flex flex-col', isMobileDrawer && 'h-full')}>
      {/* 헤더 */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
        <div className="flex items-center gap-2">
          <span className="cart-title text-md font-extrabold text-fg">장바구니</span>
          {cart.length > 0 && (
            <span className="bg-brand text-white rounded-full min-w-[20px] h-5 inline-flex items-center justify-center text-2xs font-bold px-[5px]">
              {cart.length}
            </span>
          )}
        </div>
        <div className="flex gap-1.5 items-center">
          {editingOrderId && <span className="text-2xs text-[#f59e0b] font-semibold">#{editingOrderId} 수정 중</span>}
          {isMobileDrawer && (
            <button type="button" onClick={onClose}
              className="bg-transparent border-none text-[20px] text-fg-3 cursor-pointer px-1 py-0 leading-none">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 아이템 목록 */}
      <div className={cn('flex-1 overflow-y-auto', !isEmpty && 'py-2')}>
        {isEmpty ? (
          <div className="text-center py-12 px-5 text-fg-3">
            <div className="text-[36px] mb-3 opacity-30">🛒</div>
            <div className="text-[14px] font-medium">담은 상품이 없습니다</div>
            <div className="text-[12px] mt-1 opacity-70">상품 목록에서 상품을 선택해주세요</div>
          </div>
        ) : (
          cart.map((item, idx) => (
            <div key={item.product.id} className={cn('py-[14px] px-5 flex flex-col gap-2.5', idx < cart.length - 1 && 'border-b border-line')}>
              {/* 상품명 + 삭제 */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="cart-item-name text-[14px] font-semibold text-fg leading-[1.4]">{item.product.name}</div>
                  <div className="cart-item-unit text-[12px] text-fg-3 mt-0.5">{item.product.unit}</div>
                </div>
                <Tip label="삭제">
                  <button type="button" onClick={() => updateQty(item.product.id, 0)}
                    className="bg-transparent border-none text-fg-3 text-[16px] cursor-pointer px-0.5 py-0 leading-none shrink-0 opacity-60">
                    ✕
                  </button>
                </Tip>
              </div>
              {/* 수량 + 금액 */}
              <div className="flex items-center justify-between">
                <QtyControl
                  qty={item.quantity}
                  onMinus={() => updateQty(item.product.id, item.quantity - 1)}
                  onPlus={() => updateQty(item.product.id, item.quantity + 1)}
                  onChange={v => updateQty(item.product.id, v)}
                />
                <div className="cart-item-price text-sm font-bold text-fg">
                  {item.product.price > 0 ? `${(item.product.price * item.quantity).toLocaleString()}원` : '—'}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 템플릿 */}
      {templates.length > 0 && (
        <div className="py-3 px-5 border-t border-line shrink-0">
          <div className="text-[12px] font-bold text-fg-3 mb-2 uppercase tracking-[0.4px]">정기 발주 템플릿</div>
          <div className="flex flex-col gap-1.5">
            {templates.map(tpl => (
              <div key={tpl.id} className="flex items-center justify-between">
                <span className="text-[13px] text-fg-2">{tpl.name} <span className="text-fg-3 text-2xs">({tpl.items.length}개)</span></span>
                <div className="flex gap-1">
                  <Button variant="primary" size="sm" onClick={() => loadTemplateToCart(tpl)}>불러오기</Button>
                  <Button variant="danger" size="sm" onClick={() => deleteTemplate(tpl.id)}>삭제</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 메모 */}
      <div className="py-3 px-5 border-t border-line shrink-0">
        <Textarea value={memo} onChange={e => setMemo(e.target.value)}
          placeholder="메모 (선택)" rows={2}
          className="resize-none text-[13px]" />
      </div>

      {/* 합계 + 버튼 */}
      <div className="py-4 px-5 border-t-2 border-line bg-card shrink-0">
        {!isEmpty && (
          <>
            <div className="flex justify-between items-center mb-3.5">
              <span className="text-[14px] text-fg-2">총 {cart.length}종 {cart.reduce((s, i) => s + i.quantity, 0)}개</span>
              <span className="text-[18px] font-extrabold text-fg">{total.toLocaleString()}원</span>
            </div>
            <Button variant="secondary" size="sm" onClick={saveAsTemplate} className="w-full mb-2">+ 템플릿으로 저장</Button>
          </>
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => submitOrder(true)} disabled={submitting || isEmpty} className="flex-1">임시저장</Button>
          <Button variant="primary" onClick={() => submitOrder(false)} disabled={submitting || isEmpty} className="flex-[2]">
            {submitting ? '처리 중...' : isEmpty ? '상품을 담아주세요' : `발주하기 (${total.toLocaleString()}원)`}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function StoreOrder() {
  const [tab, setTab] = useState('new');
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [orders, setOrders] = useState([]);
  const [memo, setMemo] = useState('');
  const [editingOrderId, setEditingOrderId] = useState(null);
  const [editingOrderUpdatedAt, setEditingOrderUpdatedAt] = useState(null);
  const [editingOrderStatus, setEditingOrderStatus] = useState(null);
  const [detailOrder, setDetailOrder] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [recommendations, setRecommendations] = useState({});
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('전체');
  const [templates, setTemplates] = useState([]);
  const [myStore, setMyStore] = useState(null);
  const [cartOpen, setCartOpen] = useState(false); // 모바일 장바구니 드로어
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const cartRestoredRef = useRef(false);
  const autosaveTimerRef = useRef(null);
  const autosaveInFlightRef = useRef(false);
  const autosavePendingRef = useRef(false);
  // 자동저장이 참조하는 "지금 값". 렌더마다 갱신한다.
  const latestRef = useRef({});
  latestRef.current = { cart, memo, editingOrderId, editingOrderUpdatedAt, editingOrderStatus };

  const loadOrders = () => api.getOrders().then(o => { setOrders(o); setOrdersLoaded(true); }).catch(() => setOrdersLoaded(true));
  const loadTemplates = () => api.getOrderTemplates().then(setTemplates).catch(() => {});

  useEffect(() => {
    api.getProducts().then(p => { setProducts(p); setProductsLoaded(true); }).catch(() => setProductsLoaded(true));
    api.getProductRecommendations().then(setRecommendations).catch(() => {});
    api.getMyStore().then(setMyStore).catch(() => {});
    loadTemplates();
    loadOrders();
  }, []);

  // 장바구니를 서버의 임시저장(DRAFT) 발주서로 보관 — 기기를 바꿔도, 다시 로그인해도 그대로 남아있도록
  // 가장 최근 DRAFT를 자동으로 장바구니에 복원한다 (최초 1회만)
  useEffect(() => {
    if (cartRestoredRef.current || !productsLoaded || !ordersLoaded) return;
    cartRestoredRef.current = true;
    const draft = orders.find(o => o.status === 'DRAFT');
    if (draft) loadOrderToCart(draft).catch(() => {});
  }, [productsLoaded, ordersLoaded, orders]);

  // 자동저장 본체. 렌더마다 새로 만들어지는 클로저가 아니라 항상 latestRef에서 최신 값을 읽는다 —
  // 예전엔 800ms 저장이 in-flight인 동안 걸린 pending 재실행이 "그 시점의 낡은 클로저"를 다시 불렀고,
  // 그 클로저의 editingOrderId는 아직 null이라 createOrder를 한 번 더 호출해 DRAFT가 2개 생겼다.
  // 그 사이 담은 상품은 첫 DRAFT에만 남아 유실됐다(응답이 800ms를 넘으면 재현).
  //
  // 전체 상태 머신: 담기(cart 변경) → 800ms 뒤 자동저장 예약 → 저장 in-flight 중 또 담기가 오면
  // pendingRef로 표시만 하고 건너뜀 → 저장 완료 → pendingRef가 서 있으면 즉시 재실행(setTimeout 0) →
  // 재실행 시점에 setState는 아직 반영 전일 수 있으므로 latestRef.current를 직접 갱신해 최신
  // id/updated_at을 즉시 흘려보냄 → 사용자가 '발주하기'를 누르면 submitOrder가 이 in-flight 여부를
  // 먼저 확인해 끝날 때까지 기다린 뒤 최신 updated_at으로 제출한다(아래 submitOrder 참고).
  const runAutosave = useCallback(async () => {
    // in-flight 중에 담기를 또 누르면 두 번째 호출도 `editingOrderId`가 아직 null이라
    // `createOrder`를 한 번 더 불러 DRAFT가 2개 생겼다. 겹치는 실행은 건너뛰되, 저장이
    // 800ms 넘게 걸려 그 사이 걸린 타이머가 발화한 경우엔 pendingRef로 표시해둔다 —
    // 안 그러면 진행 중인 저장이 끝난 뒤 cart가 더 바뀌지 않는 한 마지막 변경이 서버에
    // 영영 반영되지 않는다. 표시해두면 finally에서 저장이 끝난 직후 한 번 더 실행한다.
    if (autosaveInFlightRef.current) {
      autosavePendingRef.current = true;
      return;
    }
    autosaveInFlightRef.current = true;
    try {
      const { cart, memo, editingOrderId, editingOrderUpdatedAt, editingOrderStatus } = latestRef.current;
      if (cart.length === 0) {
        // REVISION_REQUESTED 발주서를 '이어하기'로 열어 항목을 전부 지우면, 확인 한 번 없이 그
        // 발주서가 취소되어 버렸다. 자동 취소는 이 화면이 스스로 만든 DRAFT에 한정한다.
        if (editingOrderId && editingOrderStatus === 'DRAFT') {
          await api.cancelOrder(editingOrderId).catch(() => {});
          setEditingOrderId(null);
          setEditingOrderUpdatedAt(null);
          setEditingOrderStatus(null);
          loadOrders();
        }
        return;
      }
      const payload = {
        memo, submit: false,
        items: cart.map(i => ({
          product_id: i.product.id, product_name: i.product.name,
          unit: i.product.unit, unit_price: i.product.price, quantity: i.quantity,
        })),
        updated_at: editingOrderUpdatedAt,
      };
      if (editingOrderId) {
        const res = await api.updateOrder(editingOrderId, payload);
        setEditingOrderUpdatedAt(res.updated_at);
        // setState는 다음 렌더까지 반영되지 않는다 — pending 재실행이나 submitOrder의 대기 해제가
        // 렌더 flush 이전에 latestRef를 읽으면 낡은 updated_at으로 PUT을 보내 서버 409를 받는다.
        latestRef.current.editingOrderUpdatedAt = res.updated_at;
      } else {
        const res = await api.createOrder(payload);
        setEditingOrderId(res.id);
        setEditingOrderStatus('DRAFT');
        latestRef.current.editingOrderId = res.id;
        latestRef.current.editingOrderStatus = 'DRAFT';
        const fresh = await api.getOrder(res.id);
        setEditingOrderUpdatedAt(fresh.updated_at || null);
        latestRef.current.editingOrderUpdatedAt = fresh.updated_at || null;
      }
      loadOrders();
    } catch {
      // 자동 저장 실패는 조용히 넘어감 — "발주하기"를 직접 누를 때 다시 시도됨
    } finally {
      autosaveInFlightRef.current = false;
      if (autosavePendingRef.current) {
        autosavePendingRef.current = false;
        autosaveTimerRef.current = setTimeout(runAutosave, 0);   // 이제 runAutosave가 고정 참조라 안전
      }
    }
    // loadOrders는 api와 setter만 참조하므로 첫 렌더에서 캡처한 참조로도 충분하다 — 의존성에 넣지 않는다.
  }, []);   // 의존성 없음 — 모든 값은 latestRef/ref에서 읽는다. 이것이 이 수정의 핵심이다.

  // 장바구니/메모가 바뀔 때마다 잠시 후 서버에 DRAFT로 자동 저장 — "임시저장" 버튼을 누르지 않아도
  // 다음에 와서(다른 기기 포함) 이어서 결제할 수 있게 함
  useEffect(() => {
    if (!cartRestoredRef.current) return;
    clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(runAutosave, 800);
    return () => clearTimeout(autosaveTimerRef.current);
  }, [cart, memo, editingOrderStatus, runAutosave]);

  // 언마운트 시 남은 타이머 정리 — 화면을 떠난 뒤 저장이 발화하면 이미 사라진 상태로 서버를 부른다.
  useEffect(() => () => clearTimeout(autosaveTimerRef.current), []);

  const addToCart = (product) => {
    setCart(c => {
      const existing = c.find(i => i.product.id === product.id);
      if (existing) return c.map(i => i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...c, { product, quantity: 1 }];
    });
  };

  const updateQty = (id, qty) => {
    if (qty <= 0) setCart(c => c.filter(i => i.product.id !== id));
    else setCart(c => c.map(i => i.product.id === id ? { ...i, quantity: qty } : i));
  };

  const total = cart.reduce((s, i) => s + i.product.price * i.quantity, 0);

  const loadOrderToCart = async (order) => {
    const detail = await api.getOrder(order.id);
    const newCart = detail.items.map(item => {
      const product = products.find(p => p.id === item.product_id) || {
        id: item.product_id, name: item.product_name, unit: item.unit, price: item.unit_price,
      };
      return { product, quantity: item.quantity };
    });
    setCart(newCart);
    setMemo(detail.memo || '');
    setEditingOrderId(order.id);
    setEditingOrderUpdatedAt(detail.updated_at || null);
    setEditingOrderStatus(detail.status);
    setTab('new');
  };

  const resetCart = () => { setCart([]); setMemo(''); setEditingOrderId(null); setEditingOrderUpdatedAt(null); setEditingOrderStatus(null); };

  const reorderFromOrder = async (order) => {
    const detail = await api.getOrder(order.id);
    const newCart = [];
    const skipped = [];
    for (const item of detail.items) {
      const product = products.find(p => p.id === item.product_id);
      if (!product) { skipped.push(item.product_name); continue; }
      const qty = item.confirmed_quantity ?? item.quantity;
      const existing = newCart.find(i => i.product.id === product.id);
      if (existing) existing.quantity += qty;
      else newCart.push({ product, quantity: qty });
    }
    if (newCart.length === 0) { toast('현재 판매 중인 상품이 없어 다시 담을 수 없습니다', 'error'); return; }
    setCart(newCart);
    setMemo('');
    setEditingOrderId(null);
    setEditingOrderUpdatedAt(null);
    setTab('new');
    if (skipped.length > 0) toast(`${skipped.join(', ')}은 현재 판매 중인 상품이 아니라 제외되었습니다`, 'info');
    else toast('지난 발주 내용을 장바구니에 담았습니다', 'success');
  };

  const submitOrder = async (draft) => {
    if (cart.length === 0) { toast('상품을 선택해주세요', 'error'); return; }
    if (submitting) return;
    setSubmitting(true);
    clearTimeout(autosaveTimerRef.current); // 아직 예약만 된 자동저장은 취소 — 이미 진행 중인 저장은 아래에서 기다린다
    // autosave가 in-flight인 채로 제출하면 같은 updated_at으로 PUT 두 개가 겹쳐 하나가 409("다른
    // 직원이 먼저 수정")를 받는다. 진행 중인 저장이 latestRef의 id/updated_at을 최신화할 때까지
    // 50ms 간격으로 대기한다(최대 5초 — 네트워크가 죽어 영영 안 끝나는 경우 화면이 잠기지 않도록).
    let waited = 0;
    while (autosaveInFlightRef.current && waited < 5000) {
      await new Promise(r => setTimeout(r, 50));
      waited += 50;
    }
    const { editingOrderId, editingOrderUpdatedAt } = latestRef.current;
    const payload = {
      memo, submit: !draft,
      items: cart.map(i => ({
        product_id: i.product.id, product_name: i.product.name,
        unit: i.product.unit, unit_price: i.product.price, quantity: i.quantity,
      })),
      updated_at: editingOrderUpdatedAt,
    };
    try {
      if (editingOrderId) await api.updateOrder(editingOrderId, payload);
      else await api.createOrder(payload);
      toast(draft ? '임시저장 완료' : '발주 완료', 'success');
      resetCart();
      setCartOpen(false);
      loadOrders();
      if (!draft) setTab('history');
    } catch (e) {
      toast(e.message || '저장에 실패했습니다. 새로고침 후 다시 시도해주세요', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const pendingOrders = orders.filter(o => ['DRAFT', 'REVISION_REQUESTED'].includes(o.status));
  const draftOrders = orders.filter(o => o.status === 'DRAFT');

  const deadlineWarning = (() => {
    if (!myStore?.order_deadline || draftOrders.length === 0) return null;
    const [h, m] = myStore.order_deadline.split(':').map(Number);
    if (Number.isNaN(h)) return null;
    const deadline = new Date();
    deadline.setHours(h, m || 0, 0, 0);
    const diffMin = (deadline.getTime() - Date.now()) / 60000;
    if (diffMin <= 0 || diffMin > 60) return null;
    return Math.ceil(diffMin);
  })();

  const saveAsTemplate = async () => {
    if (cart.length === 0) { toast('템플릿으로 저장할 상품이 없습니다', 'error'); return; }
    const name = await promptDialog({ title: '템플릿 이름을 입력하세요', defaultValue: '정기 발주' });
    if (!name) return;
    try {
      await api.createOrderTemplate({
        name,
        items: cart.map(i => ({ product_id: i.product.id, product_name: i.product.name, unit: i.product.unit, unit_price: i.product.price, quantity: i.quantity })),
      });
      toast('템플릿으로 저장되었습니다', 'success');
      loadTemplates();
    } catch (e) {
      toast(e.message || '저장에 실패했습니다', 'error');
    }
  };

  const loadTemplateToCart = (tpl) => {
    const skipped = [];
    const newCart = [];
    for (const item of tpl.items) {
      const product = products.find(p => p.id === item.product_id);
      if (!product) { skipped.push(item.product_name); continue; }
      newCart.push({ product, quantity: item.quantity });
    }
    if (newCart.length === 0) { toast('현재 판매 중인 상품이 없어 담을 수 없습니다', 'error'); return; }
    setCart(newCart);
    setTab('new');
    if (skipped.length > 0) toast(`${skipped.join(', ')}은 현재 판매 중인 상품이 아니라 제외되었습니다`, 'info');
    else toast('템플릿을 장바구니에 담았습니다', 'success');
  };

  const deleteTemplate = async (id) => {
    if (!(await confirmDialog({ title: '이 템플릿을 삭제하시겠습니까?' }))) return;
    await api.deleteOrderTemplate(id);
    loadTemplates();
  };

  const confirmReceipt = async (ok) => {
    let note;
    if (!ok) {
      note = await promptDialog({ title: '수령 시 어떤 문제가 있었나요? (예: 2개 누락, 박스 파손 등)', multiline: true });
      if (!note || !note.trim()) return;
    } else if (!(await confirmDialog({ title: '받은 물량이 발주 내용과 모두 일치합니까?' }))) {
      return;
    }
    try {
      await api.confirmReceipt(detailOrder.id, ok, note);
      toast(ok ? '수령확인 처리되었습니다' : '이상신고가 접수되었습니다', 'success');
      const d = await api.getOrder(detailOrder.id);
      setDetailOrder(d);
      loadOrders();
    } catch (e) {
      toast(e.message || '처리에 실패했습니다', 'error');
    }
  };

  const categories = ['전체', ...new Set(products.map(p => p.category).filter(Boolean))];
  const visibleProducts = products.filter(p => {
    if (activeCategory !== '전체' && p.category !== activeCategory) return false;
    if (search.trim() && !p.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

  const cartProps = {
    cart, total, updateQty, memo, setMemo, submitOrder, submitting,
    saveAsTemplate, templates, loadTemplateToCart, deleteTemplate, editingOrderId,
  };

  return (
    <div className="store-order-page pb-20">
      <style>{`
        @media (max-width: 768px) {
          .store-order-page { padding-left: 4px; padding-right: 4px; }
          .store-order-page h2 { font-size: 18px !important; }
          .store-order-page .cart-desktop-panel { display: none !important; }
          .store-order-page .split-layout { grid-template-columns: 1fr !important; }
          .store-order-page .product-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)) !important; gap: 8px !important; }
          .store-order-page .product-card { padding: 10px 12px !important; }
          .store-order-page .product-name { font-size: 13px !important; }
          .store-order-page .product-unit { font-size: 11px !important; }
          .store-order-page .product-price { font-size: 12px !important; }
          .store-order-page .cart-title { font-size: 15px !important; }
          .store-order-page .cart-item-name { font-size: 13px !important; }
          .store-order-page .cart-item-unit { font-size: 11px !important; }
          .store-order-page .cart-item-price { font-size: 14px !important; }
          .store-order-page .qty-btn { width: 28px !important; height: 28px !important; font-size: 16px !important; }
          .store-order-page .qty-input { width: 36px !important; height: 28px !important; font-size: 13px !important; }
          .store-order-page .cart-mobile-btn { font-size: 13px !important; padding: 12px 14px !important; }
          .store-order-page .table-scroll { overflow-x: auto; }
          .store-order-page table { font-size: 12px !important; }
          .store-order-page table th, .store-order-page table td { padding: 6px 4px !important; }
          .store-order-page .hide-mobile { display: none !important; }
        }
      `}</style>
      <h2>발주하기</h2>

      {deadlineWarning !== null && (
        <Card className="border-l-4 border-l-[#ef4444] mb-4 bg-[#fef2f2]">
          <div className="font-bold text-[#ef4444]">
            발주 마감 {deadlineWarning}분 전입니다 — 임시저장된 발주 {draftOrders.length}건을 마감 전에 제출해주세요
          </div>
        </Card>
      )}

      {pendingOrders.length > 0 && tab !== 'new' && (
        <Card className="border-l-4 border-l-[#f59e0b] mb-4">
          <div className="font-bold mb-2 text-[#f59e0b]">미완료 발주 {pendingOrders.length}건</div>
          {pendingOrders.map(o => (
            <div key={o.id} className="flex items-center justify-between mb-1.5">
              <span className="text-[13px] flex items-center gap-2">
                <StatusBadge status={o.status} />
                <span className="text-sub">{new Date(o.created_at).toLocaleDateString('ko-KR')} — {o.total_amount.toLocaleString()}원</span>
              </span>
              <Button variant="primary" size="sm" onClick={() => loadOrderToCart(o)}>이어하기</Button>
            </div>
          ))}
        </Card>
      )}

      <div className="flex gap-2 mb-5">
        <Button variant={tab === 'new' ? 'primary' : 'secondary'} onClick={() => { if (tab !== 'new') resetCart(); setTab('new'); }}>새 발주</Button>
        <Button variant={tab === 'history' ? 'primary' : 'secondary'} onClick={() => setTab('history')}>발주 내역</Button>
      </div>

      {tab === 'new' && (
        <div className="tab-content" key="new">
          {/* 데스크탑: 좌우 분할 / 모바일: 상품 목록만 */}
          <div className="split-layout grid grid-cols-[1fr_360px] gap-5">
            {/* 상품 목록 */}
            <Card>
              <div className="font-bold mb-3">상품 목록</div>
              {products.length > 0 && (
                <div className="mb-3">
                  <Input value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="상품명 검색" className="mb-2" />
                  {categories.length > 1 && (
                    <div className="flex gap-1.5 flex-wrap">
                      {categories.map(c => (
                        <Button key={c} type="button"
                          variant={activeCategory === c ? 'primary' : 'secondary'} size="sm"
                          onClick={() => setActiveCategory(c)}>
                          {c}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {products.length === 0
                ? <EmptyState>등록된 상품 없음</EmptyState>
                : visibleProducts.length === 0
                ? <EmptyState>검색 결과가 없습니다</EmptyState>
                : <div className="product-grid grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2.5">
                  {visibleProducts.map(p => {
                    const inCart = cart.find(i => i.product.id === p.id);
                    const recommendedQty = recommendations[p.id];
                    return (
                      <ElevatedCard key={p.id}
                        className={cn(
                          'product-card px-4 py-[14px] cursor-pointer relative shrink-0',
                          '[transition:border-color_0.15s,box-shadow_0.15s]',
                          'hover:border-brand',
                          inCart ? 'border-brand shadow-[0_0_0_2px_var(--purple-light)]' : 'border-line'
                        )}
                        onClick={() => addToCart(p)}
                      >
                        {inCart && (
                          <span className="absolute top-2 right-2 bg-brand text-white rounded-full w-[22px] h-[22px] flex items-center justify-center text-2xs font-bold shadow-[0_2px_6px_rgba(0,100,255,0.4)]">
                            {inCart.quantity}
                          </span>
                        )}
                        <div className="product-name font-semibold mb-1 text-[14px]">{p.name}</div>
                        <div className="text-sub product-unit text-[12px]">{p.unit}</div>
                        <div className="product-price text-[13px] text-brand font-bold mt-1.5">
                          {p.price > 0 ? `${p.price.toLocaleString()}원` : '단가 미설정'}
                        </div>
                        {recommendedQty > 0 && (
                          <div
                            onClick={e => { e.stopPropagation(); if (!inCart) addToCart(p); updateQty(p.id, recommendedQty); }}
                            className="mt-2 text-2xs font-bold text-[#16a34a] bg-[#dcfce7] rounded-[6px] px-2 py-[3px] inline-block cursor-pointer"
                          >
                            추천 {recommendedQty}{p.unit}
                          </div>
                        )}
                      </ElevatedCard>
                    );
                  })}
                </div>
              }
            </Card>

            {/* 데스크탑 장바구니 패널 */}
            <div className="cart-desktop-panel sticky top-5 self-start">
              <Card className="p-0 overflow-hidden max-h-[85vh] flex flex-col">
                <CartPanel {...cartProps} isMobileDrawer={false} />
              </Card>
            </div>
          </div>

          {/* ── 모바일 하단 장바구니 바 ── */}
          <div className="cart-mobile-bar fixed bottom-0 left-0 right-0 z-[200] bg-card border-t border-line shadow-[0_-4px_24px_rgba(0,0,0,0.12)] px-4 py-3 flex items-center gap-3">
            <button type="button" className={cn(
              'cart-mobile-btn flex-1 flex items-center justify-between border-none rounded-xl px-[18px] py-[14px] text-sm font-bold cursor-pointer',
              cart.length > 0 ? 'bg-brand text-white shadow-[0_4px_16px_rgba(0,100,255,0.35)]' : 'bg-muted text-fg-3 shadow-none'
            )} onClick={() => setCartOpen(true)}>
              <span className="flex items-center gap-2">
                🛒
                {cart.length > 0
                  ? <span>장바구니 <span className="bg-white/25 rounded-full px-[7px] py-px text-[12px]">{cart.length}</span></span>
                  : '장바구니 비어있음'
                }
              </span>
              {cart.length > 0 && <span>{total.toLocaleString()}원 →</span>}
            </button>
          </div>

          {/* ── 모바일 장바구니 드로어 ── */}
          {cartOpen && (
            <>
              <div onClick={() => setCartOpen(false)} className="fixed inset-0 bg-black/45 backdrop-blur-[4px] z-[300]" />
              <div className="fixed bottom-0 left-0 right-0 z-[400] bg-card rounded-t-[20px] shadow-[0_-8px_40px_rgba(0,0,0,0.2)] max-h-[88vh] flex flex-col animate-[slideUp_0.25s_cubic-bezier(0.34,1.1,0.64,1)]">
                {/* 드래그 핸들 */}
                <div className="flex justify-center pt-[10px] pb-1">
                  <div className="w-9 h-1 rounded-full bg-line" />
                </div>
                <CartPanel {...cartProps} isMobileDrawer onClose={() => setCartOpen(false)} />
              </div>
            </>
          )}

          <style>{`
            @keyframes slideUp {
              from { transform: translateY(100%); opacity: 0.6; }
              to   { transform: translateY(0);    opacity: 1; }
            }
            /* 데스크탑에서 모바일 바 숨기기 */
            @media (min-width: 769px) {
              .cart-mobile-bar { display: none !important; }
            }
          `}</style>
        </div>
      )}

      {tab === 'history' && (
        <div className={cn('split-layout tab-content grid gap-5', detailOrder ? 'grid-cols-[1fr_400px]' : 'grid-cols-1')} key="history">
          <Card>
            {orders.length === 0
              ? <EmptyState>발주 내역 없음</EmptyState>
              : <div className="table-scroll">
                <Table>
                <THead><TR><TH>발주일</TH><TH>상태</TH><TH>금액</TH><TH className="hide-mobile">메모</TH><TH className="w-[150px]"></TH></TR></THead>
                <TBody>
                  {orders.map(o => (
                    <TR key={o.id} className={cn('cursor-pointer', detailOrder?.id === o.id && 'bg-elevated')}
                      onClick={async () => { const d = await api.getOrder(o.id); setDetailOrder(d); }}>
                      <TD>{new Date(o.created_at).toLocaleDateString('ko-KR')}</TD>
                      <TD>
                        <StatusBadge status={o.status} />
                        {o.status === 'DELIVERED' && !o.receipt_confirmed_at && !o.receipt_issue_note && (
                          <Badge tone="yellow" className="ml-1.5">수령확인 필요</Badge>
                        )}
                      </TD>
                      <TD>{(o.confirmed_amount ?? o.total_amount).toLocaleString()}원</TD>
                      <TD className="text-muted hide-mobile text-[13px]">{o.memo || '-'}</TD>
                      <TD>
                        <div className="flex gap-1 justify-end">
                          {['DRAFT', 'REVISION_REQUESTED'].includes(o.status) && (
                            <Button variant="primary" size="sm" onClick={e => { e.stopPropagation(); loadOrderToCart(o); }}>이어하기</Button>
                          )}
                          <Button variant="secondary" size="sm" onClick={e => { e.stopPropagation(); reorderFromOrder(o); }}>재주문</Button>
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
                </Table>
              </div>
            }
          </Card>

          {detailOrder && (
            <Card className="sticky top-0 max-h-[90vh] overflow-y-auto">
              <div className="flex justify-between mb-4">
                <div className="font-bold">발주서 #{detailOrder.id}</div>
                <div className="flex gap-1.5">
                  <Button variant="secondary" size="sm" onClick={() => window.open(`/store/orders/${detailOrder.id}/invoice`, '_blank')}>거래명세서</Button>
                  <Button variant="secondary" size="sm" onClick={() => setDetailOrder(null)}>닫기</Button>
                </div>
              </div>
              <div className="mb-3 flex items-center gap-2.5 flex-wrap">
                <StatusBadge status={detailOrder.status} />
                {['CONFIRMED', 'PAYMENT_PENDING'].includes(detailOrder.status) && (
                  <Button variant="primary" size="sm" onClick={() => payForOrder(detailOrder).catch(e => toast(e.message || '결제 실패', 'error'))}>
                    {detailOrder.status === 'PAYMENT_PENDING' ? '다시 결제하기' : '결제하기'}
                  </Button>
                )}
                {detailOrder.status === 'PAYMENT_PENDING' && (
                  <Button variant="secondary" size="sm" onClick={async () => {
                    if (!(await confirmDialog({ title: '발주를 취소하시겠습니까?' }))) return;
                    try {
                      await api.cancelOrder(detailOrder.id);
                      setDetailOrder(null);
                      loadOrders();
                    } catch (e) {
                      toast(e.message || '취소에 실패했습니다', 'error');
                    }
                  }}>발주 취소</Button>
                )}
                {detailOrder.status === 'DELIVERED' && !detailOrder.receipt_confirmed_at && !detailOrder.receipt_issue_note && (
                  <>
                    <Button variant="primary" size="sm" onClick={() => confirmReceipt(true)}>수령확인</Button>
                    <Button variant="danger" size="sm" onClick={() => confirmReceipt(false)}>이상신고</Button>
                  </>
                )}
                {detailOrder.receipt_confirmed_at && <Badge tone="green">수령확인 완료</Badge>}
                {detailOrder.receipt_issue_note && (
                  <Badge tone="red">{detailOrder.receipt_issue_resolved_at ? '이상신고 처리완료' : '이상신고 접수됨'}</Badge>
                )}
              </div>
              {detailOrder.receipt_issue_note && (
                <ElevatedCard className="p-[10px] text-[13px] mb-3 border-l-[3px] border-l-[#ef4444]">
                  신고 내용: {detailOrder.receipt_issue_note}
                </ElevatedCard>
              )}
              <div className="table-scroll">
                <Table className="mb-3">
                <THead><TR><TH>상품</TH><TH>수량</TH><TH>금액</TH></TR></THead>
                <TBody>
                  {detailOrder.items?.map(item => {
                    const changed = item.confirmed_quantity != null && item.confirmed_quantity !== item.quantity;
                    return (
                      <TR key={item.id}>
                        <TD>
                          {item.product_name}
                          {/* 서버 상수(`PURCHASE_ORDER_ITEM_STATUSES.OUT_OF_STOCK`)와 값이 달라 가맹점 화면에 품절 배지가 단 한 번도 뜨지 않았다. */}
                          {item.status === ITEM_STATUS.OUT_OF_STOCK && <Badge tone="red" className="ml-1.5">품절</Badge>}
                          {item.substitute_note && (
                            <div className="text-muted text-[12px] mt-0.5">본사 메모: {item.substitute_note}</div>
                          )}
                        </TD>
                        <TD>
                          {changed && <span className="text-muted line-through mr-1">{item.quantity}{item.unit}</span>}
                          <span className={changed ? 'font-bold' : 'font-normal'}>{item.confirmed_quantity ?? item.quantity} {item.unit}</span>
                          {changed && <Badge tone="yellow" className="ml-1.5">변경됨</Badge>}
                        </TD>
                        {/* `amount`가 null인 옛 발주 행 하나로 상세 모달 전체가 흰 화면이 됐다(다른 두 곳은 이미 폴백이 있다). */}
                        <TD>{(item.amount ?? Math.round((item.unit_price || 0) * (item.confirmed_quantity ?? item.quantity ?? 0))).toLocaleString()}원</TD>
                      </TR>
                    );
                  })}
                </TBody>
                </Table>
              </div>
              <div className="font-bold text-right mb-3">
                {detailOrder.confirmed_amount
                  ? `확정금액: ${detailOrder.confirmed_amount.toLocaleString()}원`
                  : `총 금액: ${detailOrder.total_amount.toLocaleString()}원`}
              </div>
              {detailOrder.created_by_name && (
                <div className="text-muted text-[12px] mb-2">작성자: {detailOrder.created_by_name}</div>
              )}
              {detailOrder.memo && (
                <ElevatedCard className="p-[10px] text-[13px] mb-3">메모: {detailOrder.memo}</ElevatedCard>
              )}
              {detailOrder.history?.length > 0 && (
                <>
                  <div className="font-semibold mb-1.5 text-[13px]">처리 이력</div>
                  {detailOrder.history.map(h => (
                    <div key={h.id} className="text-muted text-[12px] mb-[3px]">
                      {new Date(h.created_at).toLocaleString('ko-KR')} — {h.action}{h.reason && ` (${h.reason})`}
                    </div>
                  ))}
                </>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
