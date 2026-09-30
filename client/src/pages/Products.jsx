import { toast } from '../toast';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import {
  Button, Card, EmptyState, Badge, Modal, Field, FieldRow, Input, Select,
  Table, THead, TBody, TR, TH, TD, confirmDialog,
} from '../components/ui';

const LOGISTICS_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN', 'HQ_LOGISTICS'];

const UNIT_OPTIONS = ['박스', '봉', '통', '묶음', 'kg', 'L', '개', '팩'].map(u => ({ value: u, label: u }));
const BASE_UNIT_OPTIONS = ['g', 'kg', 'ml', 'L', '개'].map(u => ({ value: u, label: u }));

function ProductModal({ item, ingredients, onClose, onSave }) {
  const [form, setForm] = useState(item || { name: '', unit: '박스', base_unit: 'g', unit_conversion: 1, price: 0, ingredient_id: '', category: '' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Radix Select는 value="" 를 허용하지 않으므로 '선택 안함' 상태를 'NONE' sentinel로 표현하고
  // 핸들러에서 빈 문자열로 되돌린다 (원본 <option value="">선택 안함</option> 과 동일한 동작).
  const INGREDIENT_OPTIONS = [
    { value: 'NONE', label: '선택 안함' },
    ...ingredients.map(i => ({ value: String(i.id), label: `${i.name} (${i.unit})` })),
  ];

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={item ? '상품 수정' : '상품 추가'}
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" onClick={() => onSave(form)}>저장</Button>
        </>
      }
    >
      <Field label="상품명" className="mb-3">
        <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="예: 김치 10kg 박스" />
      </Field>
      <Field label="카테고리 (선택 — 가맹점 발주 화면 검색/필터에 사용)" className="mb-3">
        <Input value={form.category || ''} onChange={e => set('category', e.target.value)} placeholder="예: 채소류" />
      </Field>
      <FieldRow>
        <Field label="발주 단위">
          <Select value={form.unit} onValueChange={v => set('unit', v)} options={UNIT_OPTIONS} />
        </Field>
        <Field label="기본 단위">
          <Select value={form.base_unit} onValueChange={v => set('base_unit', v)} options={BASE_UNIT_OPTIONS} />
        </Field>
      </FieldRow>
      <Field label={`단위 환산 (1${form.unit} = ? ${form.base_unit})`} className="mb-3">
        <Input type="number" value={form.unit_conversion} onChange={e => set('unit_conversion', e.target.value)} placeholder="예: 10000" />
      </Field>
      <Field label={`단가 (원 / ${form.unit})`} className="mb-3">
        <Input type="number" value={form.price} onChange={e => set('price', e.target.value)} placeholder="0" />
      </Field>
      <Field label="연결 식자재 (선택 — 납품 시 재고 자동 반영)">
        <Select
          value={form.ingredient_id ? String(form.ingredient_id) : 'NONE'}
          onValueChange={v => set('ingredient_id', v === 'NONE' ? '' : v)}
          options={INGREDIENT_OPTIONS}
        />
      </Field>
    </Modal>
  );
}

export default function Products() {
  const { user } = useAuth();
  const canEdit = LOGISTICS_ROLES.includes(user?.role);
  const [products, setProducts] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [modal, setModal] = useState(null);

  const load = () => api.getProducts().then(setProducts).catch(() => {});
  useEffect(() => {
    load();
    api.getIngredients().then(setIngredients).catch(() => {});
  }, []);

  const handleSave = async (form) => {
    if (!form.name?.trim()) { toast('상품명을 입력해주세요', 'error'); return; }
    const data = {
      ...form,
      unit_conversion: Number(form.unit_conversion),
      price: Number(form.price),
      ingredient_id: form.ingredient_id ? Number(form.ingredient_id) : null,
    };
    try {
      if (modal?.edit) await api.updateProduct(modal.edit.id, data);
      else await api.createProduct(data);
      setModal(null);
      load();
    } catch (e) {
      toast(e.message || '저장에 실패했습니다', 'error');
    }
  };

  const handleDelete = async (id) => {
    if (!(await confirmDialog({ title: '삭제하시겠습니까?' }))) return;
    await api.deleteProduct(id);
    load();
  };

  return (
    <div>
      <div className="top-bar">
        <h2>발주 상품 관리</h2>
        {canEdit && <Button variant="primary" onClick={() => setModal('add')}>+ 상품 추가</Button>}
      </div>

      <Card>
        {products.length === 0 ? (
          <EmptyState>발주 상품을 추가해주세요</EmptyState>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>상품명</TH>
                <TH>카테고리</TH>
                <TH>발주 단위</TH>
                <TH>단위 환산</TH>
                <TH>단가</TH>
                <TH>연결 식자재</TH>
                {canEdit && <TH>관리</TH>}
              </TR>
            </THead>
            <TBody>
              {products.map(p => (
                <TR key={p.id}>
                  <TD><b>{p.name}</b></TD>
                  <TD className="text-fg-2 tracking-[0.1px]">{p.category || '-'}</TD>
                  <TD>{p.unit}</TD>
                  <TD className="text-[13px] text-[#94a3b8]">
                    1{p.unit} = {p.unit_conversion}{p.base_unit}
                  </TD>
                  <TD>{p.price > 0 ? `${p.price.toLocaleString()}원` : <Badge tone="yellow">미설정</Badge>}</TD>
                  <TD className="text-[13px] text-[#94a3b8]">
                    {ingredients.find(i => i.id === p.ingredient_id)?.name || '-'}
                  </TD>
                  {canEdit && (
                    <TD className="flex gap-1.5">
                      <Button size="sm" onClick={() => setModal({ edit: p })}>수정</Button>
                      <Button variant="danger" size="sm" onClick={() => handleDelete(p.id)}>삭제</Button>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {(modal === 'add' || modal?.edit) && (
        <ProductModal
          item={modal?.edit}
          ingredients={ingredients}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
