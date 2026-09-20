// 团长收货信息的整段粘贴解析：提取手机号，剩余第一个词作为收货人，其余拼回收货地址。
export function parseAddressPaste(text) {
  const result = { recipient: '', phone: '', address: '' };
  if (!text || !String(text).trim()) return result;

  let rest = String(text).replace(/\s+/g, ' ').trim();
  const phoneMatch = rest.match(/1[3-9]\d{9}/);
  if (phoneMatch) {
    result.phone = phoneMatch[0];
    rest = rest.replace(phoneMatch[0], ' ').trim();
  }

  const parts = rest.split(/[，,、;；。\s]+/).filter(Boolean);
  if (parts.length > 0) result.recipient = parts.shift();
  result.address = parts.join('');
  return result;
}

export function formatYuan(cents) {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return '--';
  return (Number(cents) / 100).toFixed(2);
}

const shanghaiFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatShanghaiTime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return shanghaiFormatter.format(date);
}

export function formatCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours >= 24
    ? `${Math.floor(hours / 24)} 天 ${pad(hours % 24)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function specDisplayLabel(spec) {
  return `${spec.gender === 'male' ? '公' : '母'}${spec.weightLabel}`;
}
