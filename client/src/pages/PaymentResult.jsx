import { toast } from '../toast';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { api } from '../api';
import { payForOrder } from '../payment';
import { Button, Card, confirmDialog } from '../components/ui';

export default function PaymentResult() {
  const [params] = useSearchParams();
  const { id } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState('processing'); // processing, success, fail
  const [message, setMessage] = useState('결제 승인 처리 중입니다...');
  const [retrying, setRetrying] = useState(false);
  const confirmedRef = useRef(false);

  useEffect(() => {
    // dev StrictMode가 effect를 2회 실행해 confirmPayment가 두 번 나갔고, 두 번째의 '이미 결제 완료' 400이
    // 첫 번째 성공 메시지를 덮어써 개발 중 결제가 실패한 것처럼 보였다(운영 빌드에는 영향 없음).
    if (confirmedRef.current) return;
    confirmedRef.current = true;
    const failMessage = params.get('message');
    if (failMessage) {
      setStatus('fail');
      setMessage(failMessage);
      return;
    }
    const paymentKey = params.get('paymentKey');
    const orderId = params.get('orderId');
    const amount = Number(params.get('amount'));
    if (!paymentKey || !orderId || !amount) {
      setStatus('fail');
      setMessage('결제 정보가 올바르지 않습니다');
      return;
    }
    api.confirmPayment(id, { paymentKey, orderId, amount })
      .then(() => { setStatus('success'); setMessage('결제가 완료되었습니다'); })
      .catch(e => { setStatus('fail'); setMessage(e.message || '결제 승인에 실패했습니다'); });
  }, [id]);

  const retry = async () => {
    setRetrying(true);
    try {
      const order = await api.getOrder(id);
      await payForOrder(order);
    } catch (e) {
      toast(e.message || '결제 재시도에 실패했습니다', 'error');
    } finally {
      setRetrying(false);
    }
  };

  const cancelOrder = async () => {
    if (!await confirmDialog({ title: '발주를 취소하시겠습니까?' })) return;
    try {
      await api.cancelOrder(id);
      navigate('/store');
    } catch (e) {
      toast(e.message || '취소에 실패했습니다', 'error');
    }
  };

  return (
    <Card className="max-w-[420px] mx-auto my-[60px] text-center p-8">
      <div className="font-bold mb-2 text-[16px]">{message}</div>
      {status === 'fail' && (
        <div className="flex gap-2 justify-center mt-4">
          <Button variant="secondary" onClick={cancelOrder}>발주 취소</Button>
          <Button variant="primary" disabled={retrying} onClick={retry}>{retrying ? '결제 시도 중...' : '다시 결제하기'}</Button>
        </div>
      )}
      {status === 'success' && (
        <Button variant="primary" className="mt-4" onClick={() => navigate('/store')}>발주 내역으로 돌아가기</Button>
      )}
    </Card>
  );
}
