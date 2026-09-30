// 판매 채널 동기화 어댑터. 실제로 외부 API를 호출하는 건 토스플레이스 하나뿐이다 —
// 배민/쿠팡이츠/요기요는 매장이 토스플레이스에서 배달앱 연동을 켜두면 같은 동기화로
// 함께 들어오고, 각 주문의 channel 값(토스 주문 원본의 order.source)으로 구분된다.
// server/src/channels/toss.js 상단 주석 참고.
module.exports = { toss: require('./toss') };
