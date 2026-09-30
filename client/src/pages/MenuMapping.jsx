import { toast } from '../toast';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { useStore } from '../StoreContext';
import {
  Button, Card, EmptyState, LoadingState, Badge, Modal, Field, FieldRow, Input, Select,
  Table, THead, TBody, TR, TH, TD, Checkbox,
} from '../components/ui';

const LOGISTICS_ROLES = ['SUPER_ADMIN', 'HQ_ADMIN', 'HQ_LOGISTICS'];
const DAY_OPTIONS = [
  { value: '7', label: '최근 7일' },
  { value: '30', label: '최근 30일' },
  { value: '90', label: '최근 90일' },
];
// suggestRecipeSource(server/src/routes/api.js)가 매기는 근거별 표시 — 확신도가 높을수록 초록에 가깝게.
const BASIS_LABEL = { exact: '이름 일치', contains: '이름 포함', similar: '유사' };
const BASIS_TONE = { exact: 'green', contains: 'yellow', similar: 'neutral' };

// 세트 구성(menu_components) 등록/삭제 모달. 하나라도 등록되면 서버의 whereNotExists 조건에 걸려
// 이 메뉴는 다음 조회부터 미지정 목록에서 빠진다 — 그래서 닫을 때 항상 목록을 새로고침한다.
function SetComponentsModal({ menu, componentOptions, onClose }) {
  const [components, setComponents] = useState(null);
  const [form, setForm] = useState({ component_menu_id: 'NONE', quantity: '' });

  const load = () => api.getMenuComponents(menu.menu_id).then(setComponents).catch(() => setComponents([]));
  useEffect(() => { load(); }, [menu.menu_id]);

  const OPTIONS = [{ value: 'NONE', label: '선택' }, ...componentOptions];

  const addComponent = async () => {
    if (form.component_menu_id === 'NONE' || !form.quantity) return;
    try {
      await api.addMenuComponent(menu.menu_id, { component_menu_id: Number(form.component_menu_id), quantity: Number(form.quantity) });
      setForm({ component_menu_id: 'NONE', quantity: '' });
      load();
    } catch (e) {
      toast(e.message || '구성 추가에 실패했습니다', 'error');
    }
  };

  const removeComponent = async (componentMenuId) => {
    try {
      await api.deleteMenuComponent(menu.menu_id, componentMenuId);
      load();
    } catch (e) {
      toast(e.message || '구성 삭제에 실패했습니다', 'error');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`세트 구성 — ${menu.menu_name}`}
      footer={<Button onClick={onClose}>닫기</Button>}
    >
      <div className="mb-4">
        {components === null ? (
          <LoadingState />
        ) : components.length === 0 ? (
          <EmptyState className="p-4">구성 메뉴가 없습니다</EmptyState>
        ) : (
          <Table>
            <THead><TR><TH>구성 메뉴</TH><TH>수량</TH><TH></TH></TR></THead>
            <TBody>
              {components.map(c => (
                <TR key={c.component_menu_id}>
                  <TD>{c.component_menu_name}</TD>
                  <TD>{c.quantity}개</TD>
                  <TD><Button variant="danger" size="sm" onClick={() => removeComponent(c.component_menu_id)}>삭제</Button></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      <div className="font-semibold mb-2">구성 메뉴 추가</div>
      <FieldRow>
        <Field label="구성 메뉴 (표준 메뉴)">
          <Select
            value={form.component_menu_id}
            onValueChange={v => setForm(f => ({ ...f, component_menu_id: v }))}
            options={OPTIONS}
          />
        </Field>
        <Field label="수량" className="max-w-[120px]">
          <Input type="number" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} placeholder="1" />
        </Field>
        <Button variant="primary" className="mt-5" onClick={addComponent}>추가</Button>
      </FieldRow>
    </Modal>
  );
}

export default function MenuMapping() {
  const { user } = useAuth();
  const canEdit = LOGISTICS_ROLES.includes(user?.role);
  const { stores } = useStore();
  const [storeFilter, setStoreFilter] = useState('ALL');
  const [days, setDays] = useState('30');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [allMenus, setAllMenus] = useState([]);
  // menu_id -> { sourceId: string('NONE' 포함), confirmed: bool } — confirmed가 true인 행만 저장 대상.
  // 추천을 select에 미리 채워두더라도 confirmed는 항상 false로 시작해서, 사람이 체크박스를 눌러야만
  // (=확인했다는 뜻) 실제로 저장된다. 값을 바꾸면 다시 false로 되돌려 재확인을 강제한다.
  const [rowState, setRowState] = useState({});
  const [componentModal, setComponentModal] = useState(null);
  const [saving, setSaving] = useState(false);

  // storeFilter/days를 빠르게 바꾸면 이전 요청이 나중에 도착해 최신 결과를 덮어쓸 수 있다 —
  // 세대 카운터로 마지막에 시작한 요청의 응답만 반영한다.
  const loadSeqRef = useRef(0);
  const load = () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    const params = { days };
    if (storeFilter !== 'ALL') params.store_id = storeFilter;
    api.getUnassignedMenus(params)
      .then(result => {
        if (seq !== loadSeqRef.current) return;
        setData(result);
        setRowState(prev => {
          const next = {};
          for (const m of result.menus) {
            const top = m.suggestions[0];
            next[m.menu_id] = prev[m.menu_id]?.sourceId
              ? prev[m.menu_id]
              : { sourceId: top ? String(top.menu_id) : 'NONE', confirmed: false };
          }
          return next;
        });
      })
      .catch(e => { if (seq === loadSeqRef.current) toast(e.message || '조회에 실패했습니다', 'error'); })
      .finally(() => { if (seq === loadSeqRef.current) setLoading(false); });
  };

  useEffect(() => { load(); }, [storeFilter, days]);
  // 표준 메뉴 드롭다운/세트 구성 후보는 브랜드 전체 메뉴 중 매장에 속하지 않은(store_id 없는) 것만 —
  // 매장별 메뉴를 표준 메뉴로 잘못 고르면 그 매장 하나의 레시피가 다른 매장 재고까지 차감하게 된다.
  useEffect(() => { api.getMenus().then(setAllMenus).catch(() => {}); }, []);

  const standardMenuOptions = useMemo(() => (
    allMenus
      .filter(m => !m.store_id)
      .map(m => ({ value: String(m.id), label: m.recipes?.length ? `${m.name} (재료 ${m.recipes.length}종)` : `${m.name} · 레시피 없음` }))
  ), [allMenus]);

  const setSourceId = (menuId, sourceId) => {
    setRowState(prev => ({ ...prev, [menuId]: { sourceId, confirmed: false } }));
  };
  const setConfirmed = (menuId, confirmed) => {
    setRowState(prev => ({ ...prev, [menuId]: { ...prev[menuId], confirmed } }));
  };

  const readyToSave = data?.menus.filter(m => {
    const row = rowState[m.menu_id];
    return row?.confirmed && row.sourceId !== 'NONE';
  }) || [];

  const handleSave = async () => {
    if (readyToSave.length === 0) return;
    setSaving(true);
    try {
      const links = readyToSave.map(m => ({ menu_id: m.menu_id, recipe_source_menu_id: Number(rowState[m.menu_id].sourceId) }));
      const result = await api.updateMenuRecipeLinks(links);
      toast(`${result.updated}건 연결되었습니다`, 'success');
      load();
    } catch (e) {
      // 순환 참조·다른 브랜드 메뉴 등 서버가 400으로 거부하는 사유를 그대로 보여준다.
      toast(e.message || '저장에 실패했습니다', 'error');
    } finally {
      setSaving(false);
    }
  };

  const storeOptions = [{ value: 'ALL', label: '전체 가맹점' }, ...stores.map(s => ({ value: String(s.id), label: s.name }))];

  return (
    <div>
      <div className="top-bar">
        <h2>메뉴 매핑</h2>
      </div>
      <p className="text-muted mb-4 text-xs">
        판매는 됐는데 레시피도, 표준 메뉴 연결도, 세트 구성도 없어 재고가 전혀 차감되지 않은 매장 메뉴 목록입니다.
        판매량이 많을수록 재고 왜곡이 크므로 위에 있는 것부터 먼저 처리하세요.
      </p>

      <div className="card kicc-search-panel">
        <div className="kicc-search-row">
          <div className="filter-field">
            <label>가맹점</label>
            <Select value={storeFilter} onValueChange={setStoreFilter} options={storeOptions} />
          </div>
          <div className="filter-field">
            <label>조회 기간</label>
            <Select value={days} onValueChange={setDays} options={DAY_OPTIONS} />
          </div>
        </div>
      </div>

      <Card>
        <div className="top-bar mb-3">
          <div className="font-bold">미지정 메뉴</div>
          {canEdit && (
            <Button variant="primary" onClick={handleSave} disabled={saving || readyToSave.length === 0}>
              {saving ? '저장 중...' : `선택 ${readyToSave.length}건 저장`}
            </Button>
          )}
        </div>

        {loading ? (
          <LoadingState />
        ) : !data || data.menus.length === 0 ? (
          <EmptyState>전부 지정되었습니다 — 조회 기간 내 레시피 미지정 메뉴가 없습니다</EmptyState>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>메뉴명</TH>
                <TH>가맹점</TH>
                <TH>최근 판매량</TH>
                <TH>표준 메뉴 연결</TH>
                {canEdit && <TH>저장</TH>}
                {canEdit && <TH>세트 구성</TH>}
              </TR>
            </THead>
            <TBody>
              {data.menus.map(m => {
                const row = rowState[m.menu_id] || { sourceId: 'NONE', confirmed: false };
                const top = m.suggestions[0];
                return (
                  <TR key={m.menu_id}>
                    <TD>
                      <b>{m.menu_name}</b>
                      {m.auto_discovered && <Badge tone="yellow" className="ml-2">자동발견</Badge>}
                    </TD>
                    <TD className="text-fg-2 tracking-[0.1px] text-[13px]">{m.store_name}</TD>
                    <TD>
                      {m.recent_sales_qty > 0
                        ? <Badge tone="red">{m.recent_sales_qty}개 · {m.recent_order_count}건</Badge>
                        : <span className="text-sub">0개</span>}
                    </TD>
                    <TD>
                      {canEdit ? (
                        <div className="min-w-[220px]">
                          <Select
                            value={row.sourceId}
                            onValueChange={v => setSourceId(m.menu_id, v)}
                            options={[{ value: 'NONE', label: '선택 안 함' }, ...standardMenuOptions]}
                          />
                          {top && (
                            <div className="mt-1">
                              <Badge tone={BASIS_TONE[top.basis] || 'neutral'} subtle>
                                추천: {top.menu_name} ({Math.round(top.score * 100)}% · {BASIS_LABEL[top.basis] || top.basis})
                              </Badge>
                            </div>
                          )}
                        </div>
                      ) : (top ? `추천: ${top.menu_name}` : '-')}
                    </TD>
                    {canEdit && (
                      <TD>
                        <Checkbox
                          checked={row.confirmed}
                          onCheckedChange={v => setConfirmed(m.menu_id, !!v)}
                          disabled={row.sourceId === 'NONE'}
                        />
                      </TD>
                    )}
                    {canEdit && (
                      <TD>
                        <Button size="sm" onClick={() => setComponentModal(m)}>세트 구성</Button>
                      </TD>
                    )}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      {componentModal && (
        <SetComponentsModal
          menu={componentModal}
          componentOptions={standardMenuOptions}
          onClose={() => { setComponentModal(null); load(); }}
        />
      )}
    </div>
  );
}
