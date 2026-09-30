import { toast } from '../toast';
import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  Button, Card, Badge, EmptyState, Field, Input, Textarea, Select,
  Table, THead, TBody, TR, TH, TD, Modal, confirmDialog,
} from '../components/ui';

export default function Notices() {
  const [notices, setNotices] = useState([]);
  const [stores, setStores] = useState([]);
  const [modal, setModal] = useState(null); // null | { editing: notice|null }
  const [form, setForm] = useState({ title: '', content: '', store_id: 'ALL' });
  const [saving, setSaving] = useState(false);

  const load = () => api.getNotices().then(setNotices).catch(() => {});
  useEffect(() => {
    load();
    api.getStores().then(setStores).catch(() => {});
  }, []);

  const openCreate = () => {
    setForm({ title: '', content: '', store_id: 'ALL' });
    setModal({ editing: null });
  };
  const openEdit = (n) => {
    setForm({ title: n.title, content: n.content, store_id: n.store_id ? String(n.store_id) : 'ALL' });
    setModal({ editing: n });
  };

  const save = async () => {
    if (!form.title.trim()) { toast('제목을 입력해주세요', 'error'); return; }
    if (!form.content.trim()) { toast('내용을 입력해주세요', 'error'); return; }
    if (saving) return;
    setSaving(true);
    try {
      if (modal.editing) {
        await api.updateNotice(modal.editing.id, { title: form.title, content: form.content });
      } else {
        await api.createNotice({ title: form.title, content: form.content, store_id: form.store_id === 'ALL' ? null : form.store_id });
      }
      toast('저장되었습니다', 'success');
      setModal(null);
      load();
    } catch (e) {
      toast(e.message || '저장에 실패했습니다', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (n) => {
    try {
      await api.updateNotice(n.id, { is_active: !n.is_active });
      load();
    } catch (e) {
      toast(e.message || '처리에 실패했습니다', 'error');
    }
  };

  const remove = async (n) => {
    if (!await confirmDialog({ title: '이 공지를 삭제하시겠습니까?' })) return;
    try {
      await api.deleteNotice(n.id);
      load();
    } catch (e) {
      toast(e.message || '삭제에 실패했습니다', 'error');
    }
  };

  const targetCount = (n) => n.store_id ? 1 : stores.length;

  return (
    <div>
      <div className="top-bar">
        <h2>공지사항</h2>
        <Button variant="primary" onClick={openCreate}>+ 공지 작성</Button>
      </div>

      <Card>
        {notices.length === 0 ? <EmptyState>등록된 공지가 없습니다</EmptyState> : (
          <Table>
            <THead><TR><TH>제목</TH><TH>대상</TH><TH>확인</TH><TH>상태</TH><TH>작성일</TH><TH>관리</TH></TR></THead>
            <TBody>
              {notices.map(n => (
                <TR key={n.id}>
                  <TD><b>{n.title}</b><div className="text-muted text-[12px] mt-[2px] max-w-[320px]">{n.content}</div></TD>
                  <TD>{n.store_id ? n.store_name : '전체 가맹점'}</TD>
                  <TD>{n.read_count} / {targetCount(n)}</TD>
                  <TD>
                    <Badge tone={n.is_active ? 'green' : 'yellow'}>{n.is_active ? '게시중' : '숨김'}</Badge>
                  </TD>
                  <TD className="text-muted text-[12px]">{new Date(n.created_at).toLocaleDateString('ko-KR')}</TD>
                  <TD className="flex gap-1">
                    <Button variant="secondary" size="sm" onClick={() => openEdit(n)}>수정</Button>
                    <Button variant="secondary" size="sm" onClick={() => toggleActive(n)}>{n.is_active ? '숨기기' : '게시'}</Button>
                    <Button variant="danger" size="sm" onClick={() => remove(n)}>삭제</Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal
        open={!!modal}
        onOpenChange={(open) => { if (!open) setModal(null); }}
        title={modal?.editing ? '공지 수정' : '공지 작성'}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setModal(null)}>취소</Button>
            <Button variant="primary" onClick={save} disabled={saving}>{saving ? '저장 중...' : '저장'}</Button>
          </>
        )}
      >
        {!modal?.editing && (
          <Field label="대상 가맹점" className="mb-3">
            <Select
              value={form.store_id}
              onValueChange={v => setForm(f => ({ ...f, store_id: v }))}
              options={[{ value: 'ALL', label: '전체 가맹점' }, ...stores.map(s => ({ value: String(s.id), label: s.name }))]}
            />
          </Field>
        )}

        <Field label="제목" className="mb-3">
          <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} autoFocus />
        </Field>

        <Field label="내용" className="mb-4">
          <Textarea rows={5} value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} />
        </Field>
      </Modal>
    </div>
  );
}
