import { loadTossPayments } from '@tosspayments/tosspayments-sdk';
import { api } from './api';

const TOSS_CLIENT_KEY = import.meta.env.VITE_TOSS_CLIENT_KEY;

export async function payForOrder(order) {
  if (!TOSS_CLIENT_KEY) throw new Error('결제 설정이 완료되지 않았습니다 (VITE_TOSS_CLIENT_KEY 미설정)');
  const { orderId, amount, orderName } = await api.preparePayment(order.id);
  const tossPayments = await loadTossPayments(TOSS_CLIENT_KEY);
  const widget = tossPayments.payment({ customerKey: `store-${order.store_id}` });
  const origin = window.location.origin;
  await widget.requestPayment({
    method: 'CARD',
    amount: { currency: 'KRW', value: amount },
    orderId,
    orderName,
    successUrl: `${origin}/store/payment/${order.id}/result`,
    failUrl: `${origin}/store/payment/${order.id}/result`,
  });
}
