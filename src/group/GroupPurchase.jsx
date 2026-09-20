import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchGroup,
  fetchGroupAmount,
  fetchCurrentConfig,
  addMember,
  updateMember,
  deleteMember,
  submitGroup,
} from './api';
// 普通包装今年不提供（只出礼盒）：团购的团长提交区也要跟着置灰，
// 共用选购页那一个开关，避免以后再出现「只改了一边」。
import { PLAIN_PACKAGING_ENABLED, isSpecOrderable, specClosedReason, itemsAvailabilityError } from '../storefront/purchase';
import {
  loadEditKeys,
  saveEditKey,
  removeEditKey,
  loadOrderCode,
  saveOrderCode,
} from './credentials';
import {
  parseAddressPaste,
  formatYuan,
  formatShanghaiTime,
  formatCountdown,
  specDisplayLabel,
} from './utils';
import SpecBadge from '../shared/SpecBadge';
import PosterShare from '../shared/PosterShare.jsx';
import './group.css';

function Icon({ name, size = 18 }) {
  const paths = {
    share: <><path d="M12 16V3m0 0L7 8m5-5 5 5" /><path d="M5 13v7h14v-7" /></>,
    crab: <><path d="M7 14a5 5 0 0 0 10 0M5 10a3 3 0 0 0-3 3M19 10a3 3 0 0 1 3 3M8 8a4 4 0 0 1 8 0v6H8V8Z" /><path d="M9 5 7 2M15 5l2-3M10 11h.01M14 11h.01" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" /></>,
    trash: <><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    paste: <><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /></>,
    alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 17h.01" /></>,
  };
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

function deriveBadge(group, amount) {
  if (!group) return { label: '加载中', kind: 'neutral' };
  if (group.status === 'cancelled') return { label: '已取消', kind: 'neutral' };
  if (group.status === 'closed') return { label: '已结单', kind: 'neutral' };
  if (group.status === 'submitted') {
    const shipped = amount?.phase === 'final' && amount.freightCents !== null;
    return shipped ? { label: '已发货', kind: 'blue' } : { label: '已提交', kind: 'warm' };
  }
  if (group.isAfterCutoff) return { label: '已截单', kind: 'warm' };
  if (group.remainingToNextTen === 0 && group.totalCount > 0) return group.canSubmit
    ? { label: '可成团', kind: 'live' }
    : { label: '需调整搭配', kind: 'warm' };
  return { label: '募集中', kind: 'live' };
}

function submitDisabledReason(group) {
  if (!group) return '';
  if (group.status !== 'open') return '拼团已结单';
  if (group.isAfterCutoff) return '已过截单时间';
  if (group.totalCount === 0) return '还没有成员提交';
  if (group.remainingToNextTen !== 0) return `还差 ${group.remainingToNextTen} 只凑满 10 的倍数`;
  return '';
}

function Countdown({ group, now }) {
  if (!group?.cutoffTime) return null;
  const cutoff = new Date(group.cutoffTime);
  if (Number.isNaN(cutoff.getTime())) return null;
  const remaining = cutoff.getTime() - now.getTime();
  const passed = group.isAfterCutoff || remaining <= 0;
  return (
    <div className={`gp-cutoff ${passed ? 'is-passed' : ''}`} role="status">
      <Icon name="clock" size={15} />
      {passed ? (
        <span>本团已截单 · {formatShanghaiTime(group.cutoffTime)}</span>
      ) : (
        <span>
          <strong>{formatShanghaiTime(group.cutoffTime)}</strong> 截单 ·
          <strong className="gp-countdown">{formatCountdown(remaining)}</strong>
        </span>
      )}
    </div>
  );
}

function SummaryCard({ group, amount }) {
  const finalPhase = amount?.phase === 'final';
  const estimated = group?.estimated;
  const totalCents = finalPhase ? amount.totalCents : estimated?.totalCents;
  const crabCents = finalPhase ? amount.crabCents : estimated?.crabCents;
  const packagingCents = finalPhase ? amount.packagingCents : estimated?.packagingCents;
  const freightCents = finalPhase ? amount.freightCents : null;
  const specsById = new Map(group.members.flatMap((member) => member.items || []).map((item) => [item.specId, item]));
  return (
    <section className="gp-card gp-summary" aria-label="采购汇总">
      <div className="gp-card-head">
        <h2>全团 <b>{group.totalCount}</b> 只</h2>
      </div>
      <ul className="gp-spec-list">
        {group.totalsBySpec.map((item) => {
          const spec = specsById.get(item.specId);
          return <li key={item.specId ?? item.label}>{spec ? <SpecBadge gender={spec.gender} weightLabel={spec.weightLabel} compact /> : <span>{item.label}</span>}<b>× {item.quantity}</b></li>;
        })}
        {group.totalsBySpec.length === 0 && <li className="gp-empty-line">暂无采购</li>}
      </ul>
      <div className={`gp-progress ${group.remainingToNextTen === 0 && group.totalCount > 0 ? 'is-ready' : ''}`}>
        {group.status !== 'open' ? (
          <><Icon name="check" size={16} /><span>{group.status === 'submitted' ? '团购订单已提交' : group.status === 'cancelled' ? '拼团已取消' : '拼团已结束'}</span></>
        ) : group.remainingToNextTen === 0 && group.totalCount > 0 ? (
          <><Icon name={group.canSubmit ? 'check' : 'alert'} size={16} /><span>{group.canSubmit ? '已凑齐，待团长提交' : '已凑齐，请检查截单时间及规格可售状态'}</span></>
        ) : (
          <span>成团还差 <b>{group.remainingToNextTen}</b> 只</span>
        )}
      </div>
      <div className="gp-money">
        <div><span>蟹款</span><b>¥ {formatYuan(crabCents)}</b></div>
        <div><span>包装费</span><b>¥ {formatYuan(packagingCents)}</b></div>
        {finalPhase && (
          <div><span>运费</span><b>{freightCents === null ? '发货后确认' : `¥ ${formatYuan(freightCents)}`}</b></div>
        )}
        <div className="gp-money-total">
          <span>{finalPhase ? '合计' : '预估'}</span>
          <strong>¥ {formatYuan(totalCents)}</strong>
        </div>
        {!finalPhase && <span className="gp-estimate-note">运费另计 · 发货后定价</span>}
      </div>
    </section>
  );
}

function memberSelection(member) {
  const items = member.items?.length ? member.items : [{ specId: member.specId, qty: member.quantity }];
  return Object.fromEntries(items.map((item) => [item.specId, item.qty]));
}

function selectedItems(selection) {
  return Object.entries(selection)
    .filter(([, qty]) => Number(qty) > 0)
    .map(([specId, qty]) => ({ specId: Number(specId), qty: Number(qty) }));
}

function selectionError(selection, specs) {
  const quantities = Object.values(selection);
  if (quantities.some((qty) => qty !== '' && (!Number.isSafeInteger(Number(qty)) || Number(qty) < 0))) {
    return '数量请填写 0 或正整数';
  }
  const items = selectedItems(selection);
  if (!items.length) return '请至少选择 1 只螃蟹';
  if (items.some((item) => !specs.some((spec) => spec.id === item.specId))) return '部分规格已下架，请调整后再提交';
  return itemsAvailabilityError(specs, items);
}

function CrabSelection({ specs, selection, onChange, disabled }) {
  const items = selectedItems(selection);
  const totalCount = items.reduce((sum, item) => sum + item.qty, 0);
  const crabCents = items.reduce((sum, item) => sum + item.qty * (specs.find((spec) => spec.id === item.specId)?.priceCents ?? 0), 0);
  const setQuantity = (specId, qty) => onChange({ ...selection, [specId]: qty });
  return (
    <fieldset className="gp-crab-selection" disabled={disabled}>
      <legend>自由搭配 · 1 只起拼</legend>
      <div className="gp-spec-options">
        {specs.map((spec) => {
          const quantity = selection[spec.id] ?? 0;
          const label = specDisplayLabel(spec);
          const orderable = isSpecOrderable(spec);
          return (
            <div className={`gp-spec-option${Number(quantity) > 0 ? ' is-selected' : ''}${orderable ? '' : ' is-unavailable'}`} key={spec.id}>
              <div className="gp-spec-copy"><SpecBadge gender={spec.gender} weightLabel={spec.weightLabel} compact /><span className="gp-unit-price">¥{formatYuan(spec.priceCents)} / 只</span>{!orderable && <span className="gp-spec-closed">{specClosedReason(spec)}</span>}</div>
              <div className="gp-stepper">
                <button type="button" aria-label={`减少${label}`} disabled={disabled || Number(quantity) <= 0}
                  onClick={() => setQuantity(spec.id, Math.max(0, Number(quantity) - 1))}>−</button>
                <input type="number" min="0" step="1" inputMode="numeric" value={quantity} disabled={!orderable} aria-label={`${label}数量`}
                  onChange={(e) => setQuantity(spec.id, e.target.value === '' ? '' : Number(e.target.value))} />
                <button type="button" aria-label={`增加${label}`} disabled={!orderable}
                  onClick={() => setQuantity(spec.id, Number(quantity) + 1)}>+</button>
              </div>
            </div>
          );
        })}
      </div>
      {items.filter((item) => !specs.some((spec) => spec.id === item.specId)).map((item) => (
        <p className="gp-disabled-note" key={item.specId}>原规格已下架（{item.qty} 只） <button type="button" className="gp-link-button" onClick={() => setQuantity(item.specId, 0)}>移除并重新搭配</button></p>
      ))}
      {specs.length === 0 && <p className="gp-disabled-note">暂无可选规格，请稍后重试。</p>}
      <div className="gp-selection-total" aria-live="polite"><span>本次共 <b>{totalCount}</b> 只</span><strong>蟹款 ¥{formatYuan(crabCents)}</strong></div>
    </fieldset>
  );
}

function MemberForm({ specs, disabled, disabledReason, onSubmitted }) {
  const [name, setName] = useState('');
  const [selection, setSelection] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (disabled || submitting) return;
    setError('');
    if (!name.trim()) { setError('请填写姓名'); return; }
    const validationError = selectionError(selection, specs);
    if (validationError) { setError(validationError); return; }
    setSubmitting(true);
    try {
      await onSubmitted({ name: name.trim(), items: selectedItems(selection) });
      setName('');
      setSelection({});
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="gp-card" aria-label="提交我的采购意向">
      <div className="gp-card-head">
        <h2><Icon name="crab" />我要参团</h2>
      </div>
      {disabled ? (
        <p className="gp-disabled-note">{disabledReason || '当前不可提交'}</p>
      ) : (
        <form className="gp-form" onSubmit={handleSubmit}>
          <label className="gp-field">
            <span>姓名</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="怎么称呼你" maxLength={50} disabled={submitting} />
          </label>
          <CrabSelection specs={specs} selection={selection} onChange={setSelection} disabled={submitting} />
          {error && <p className="gp-error" role="alert">{error}</p>}
          <button className="gp-button" type="submit" disabled={submitting || specs.length === 0}>
            {submitting ? '提交中…' : '提交我的意向'}
          </button>
        </form>
      )}
    </section>
  );
}

function MemberRow({ member, editKey, payable, readOnly, specs, onSaved, onDeleted, onError }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [selection, setSelection] = useState(() => memberSelection(member));
  const [busy, setBusy] = useState(false);

  const startEdit = () => {
    setName(member.name);
    setSelection(memberSelection(member));
    setEditing(true);
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) { onError('请填写姓名'); return; }
    const validationError = selectionError(selection, specs);
    if (validationError) { onError(validationError); return; }
    setBusy(true);
    try {
      await onSaved(member.id, {
        name: name.trim(),
        items: selectedItems(selection),
      }, editKey);
      setEditing(false);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (busy) return;
    if (!window.confirm(`确定删除「${member.name}」的 ${member.quantity} 只记录吗？`)) return;
    setBusy(true);
    try {
      await onDeleted(member.id, editKey);
    } catch (err) {
      onError(err.message);
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li className="gp-member is-editing">
        <form className="gp-form gp-edit-form" onSubmit={handleSave}>
          <label className="gp-field">
            <span>姓名</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} disabled={busy} />
          </label>
          <CrabSelection specs={specs} selection={selection} onChange={setSelection} disabled={busy} />
          <div className="gp-edit-actions">
            <button type="button" className="gp-link-button" onClick={() => setEditing(false)} disabled={busy}>取消</button>
            <button type="submit" className="gp-button gp-button-small" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="gp-member">
      <span className="gp-avatar">{member.name.slice(0, 1)}</span>
      <div className="gp-member-info">
        <div className="gp-member-title"><strong>{member.name}</strong><span>共 {member.quantity} 只</span></div>
        <div className="gp-member-items">{member.items?.length ? member.items.map((item) => (
          <span className="gp-member-item" key={item.specId}><SpecBadge gender={item.gender} weightLabel={item.weightLabel} compact /><b>× {item.qty}</b></span>
        )) : <span>{member.specLabel} × {member.quantity} 只</span>}</div>
        {payable && (
          <div className="gp-payable">
            <span>蟹款 ¥{formatYuan(payable.crabCents)}</span>
            <span>包装 ¥{formatYuan(payable.packagingShareCents)}</span>
            <span>{payable.freightShareCents === null ? '运费待定' : `运费 ¥${formatYuan(payable.freightShareCents)}`}</span>
            <b>应付 ¥{formatYuan(payable.totalCents)}</b>
          </div>
        )}
      </div>
      {!readOnly && editKey && (
        <div className="gp-member-actions">
          <button type="button" aria-label={`编辑 ${member.name} 的记录`} onClick={startEdit}><Icon name="edit" size={15} /></button>
          <button type="button" aria-label={`删除 ${member.name} 的记录`} className="is-danger" onClick={handleDelete}><Icon name="trash" size={15} /></button>
        </div>
      )}
    </li>
  );
}

function LeaderPanel({ group, specs, configError, onSubmitted, onError }) {
  const [orderCode, setOrderCode] = useState(() => loadOrderCode());
  const [recipient, setRecipient] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  // 今年只出礼盒（普通包装不提供），默认就选礼盒；与选购页共用 PLAIN_PACKAGING_ENABLED 开关。
  const [packaging, setPackaging] = useState('gift');
  const plainClosed = !PLAIN_PACKAGING_ENABLED;
  const [pasteText, setPasteText] = useState('');
  const [pasteHint, setPasteHint] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKeyRef = useRef(null);

  const reason = configError || submitDisabledReason(group) || itemsAvailabilityError(specs, group.members.flatMap(member => member.items || []));
  const canSubmit = group.canSubmit && !reason;

  const handleParse = () => {
    const parsed = parseAddressPaste(pasteText);
    if (!parsed.recipient && !parsed.phone && !parsed.address) {
      setPasteHint('没有识别到有效内容，请检查粘贴文本');
      return;
    }
    if (parsed.recipient) setRecipient(parsed.recipient);
    if (parsed.phone) setPhone(parsed.phone);
    if (parsed.address) setAddress(parsed.address);
    setPasteHint(`已识别：${parsed.recipient || '（未识别姓名）'} ${parsed.phone || '（未识别手机号）'}`);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    if (!orderCode.trim()) { onError('请先输入团长下单码'); return; }
    if (!recipient.trim() || !phone.trim() || !address.trim()) {
      onError('请完整填写收货人、电话和地址');
      return;
    }
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID();
    setSubmitting(true);
    saveOrderCode(orderCode.trim());
    try {
      await onSubmitted({
        recipient: recipient.trim(),
        phone: phone.trim(),
        address: address.trim(),
        packaging,
        idempotencyKey: idempotencyKeyRef.current,
      }, orderCode.trim());
    } catch (err) {
      idempotencyKeyRef.current = null;
      onError(err.code === 'NOT_GROUP_LEADER' ? '这个下单码不是本团团长的下单码' : err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <details className="gp-card gp-leader" aria-label="团长提交区">
      <summary><Icon name="send" /><span>团长提交</span><small>{canSubmit ? '可提交' : reason}</small></summary>
      <form className="gp-form" onSubmit={handleSubmit}>
        <label className="gp-field">
          <span>团长下单码</span>
          <input value={orderCode} onChange={(e) => setOrderCode(e.target.value)}
            placeholder="输入你的下单码" autoComplete="off" />
        </label>
        <label className="gp-field">
          <span>粘贴收货信息</span>
          <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)}
            placeholder="例如：张三 13800138000 上海市浦东新区张江路 88 号" rows={2} />
        </label>
        <button type="button" className="gp-link-button gp-parse" onClick={handleParse}>
          <Icon name="paste" size={15} /> 识别地址
        </button>
        {pasteHint && <p className="gp-helper">{pasteHint}</p>}
        <div className="gp-field-grid">
          <label className="gp-field">
            <span>收货人</span>
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={50} />
          </label>
          <label className="gp-field">
            <span>电话</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={30} />
          </label>
        </div>
        <label className="gp-field">
          <span>全团收货地址</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />
        </label>
        <fieldset className="gp-packaging">
          <legend>包装</legend>
          {/* 普通包装今年不提供：置灰不可选（跟选购页同一套口径，别只改一边）。
              此前这里默认值是 'plain' 且两个选项都能点，团购单因此能下出普通包装。 */}
          <label className={`${packaging === 'plain' ? 'is-selected' : ''}${plainClosed ? ' is-disabled' : ''}`}>
            <input type="radio" name="gp-packaging" value="plain" disabled={plainClosed}
              checked={packaging === 'plain'} onChange={() => setPackaging('plain')} />
            <span>普通包装{plainClosed ? ' · 暂不提供' : ''}</span>
          </label>
          <label className={packaging === 'gift' ? 'is-selected' : ''}>
            <input type="radio" name="gp-packaging" value="gift"
              checked={packaging === 'gift'} onChange={() => setPackaging('gift')} />
            <span>礼盒</span>
          </label>
        </fieldset>
        <span className="gp-helper">提交后锁定清单，安排发货。</span>
        <button className="gp-button" type="submit" disabled={!canSubmit || submitting}>
          <Icon name="send" size={16} />
          {submitting ? '提交中…' : '提交团购订单'}
        </button>
      </form>
    </details>
  );
}

export default function GroupPurchase({ token }) {
  const [group, setGroup] = useState(null);
  const [amount, setAmount] = useState(null);
  const [specs, setSpecs] = useState([]);
  const [shareBaseUrl, setShareBaseUrl] = useState('');
  const [showPoster, setShowPoster] = useState(false);
  const [editKeys, setEditKeys] = useState(() => loadEditKeys(token));
  const [loadError, setLoadError] = useState('');
  const [configError, setConfigError] = useState('');
  const [toast, setToast] = useState('');
  const [newEditKey, setNewEditKey] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const toastTimer = useRef(null);

  const showToast = useCallback((message) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [groupData, amountData, configResult] = await Promise.all([
        fetchGroup(token),
        fetchGroupAmount(token).catch(() => null),
        fetchCurrentConfig().then(config => ({ config }), error => ({ error })),
      ]);
      setGroup(groupData);
      setAmount(amountData);
      setLoadError('');
      if (configResult.error) {
        setConfigError('规格状态加载失败，请重试后再提交。');
      } else {
        setSpecs(Array.isArray(configResult.config?.specs) ? configResult.config.specs : []);
        setShareBaseUrl(configResult.config?.shareBaseUrl || '');
        setConfigError('');
      }
    } catch (err) {
      setLoadError(err.message);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const poll = window.setInterval(refresh, 10000);
    const tick = window.setInterval(() => setNow(new Date()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
      window.clearTimeout(toastTimer.current);
    };
  }, [refresh]);

  const badge = useMemo(() => deriveBadge(group, amount), [group, amount]);
  const readOnly = !group || group.status !== 'open';
  const memberFormDisabled = readOnly || group?.isAfterCutoff || Boolean(configError);
  const memberFormReason = configError || (!group
    ? ''
    : group.status !== 'open'
      ? '拼团已结单，成员记录只读'
      : group.isAfterCutoff
        ? '已过今日截单时间，不能再提交或修改'
        : '');

  const payableByMember = useMemo(() => {
    if (!amount || !Array.isArray(amount.members)) return new Map();
    return new Map(amount.members.map((m) => [m.id, m]));
  }, [amount]);

  const withAvailabilityRefresh = async (request) => {
    try { return await request(); } catch (error) {
      if (['SPEC_NOT_ORDERABLE', 'SPEC_INVALID'].includes(error.code)) await refresh();
      throw error;
    }
  };

  const handleAddMember = async (payload) => {
    const result = await withAvailabilityRefresh(() => addMember(token, payload));
    const map = saveEditKey(token, result.member.id, result.editKey);
    setEditKeys(map);
    setNewEditKey({ name: result.member.name, editKey: result.editKey });
    showToast(`已记录 ${result.member.name} 的 ${result.member.quantity} 只`);
    await refresh();
  };

  const handleUpdateMember = async (memberId, payload, editKey) => {
    await withAvailabilityRefresh(() => updateMember(token, memberId, payload, editKey));
    showToast('已保存修改');
    await refresh();
  };

  const handleDeleteMember = async (memberId, editKey) => {
    await deleteMember(token, memberId, editKey);
    setEditKeys(removeEditKey(token, memberId));
    showToast('已删除这条记录');
    await refresh();
  };

  const handleLeaderSubmit = async (payload, orderCode) => {
    await withAvailabilityRefresh(() => submitGroup(token, payload, orderCode));
    showToast('团购订单已提交，进入发货队列');
    await refresh();
  };

  if (loadError && !group) {
    return (
      <div className="gp-page">
        <div className="gp-shell">
          <div className="gp-card gp-load-error" role="alert">
            <span className="gp-state-icon gp-state-icon-error"><Icon name="alert" size={28} /></span>
            <h1>打不开这个拼团</h1>
            <p>{loadError}</p>
            <button className="gp-button" type="button" onClick={refresh}>重试</button>
          </div>
        </div>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="gp-page">
        <div className="gp-shell"><p className="gp-loading">正在打开拼团清单…</p></div>
      </div>
    );
  }

  return (
    <div className="gp-page">
      <div className="gp-shell">
        <nav className="gp-share-nav" aria-label="拼团导航">
          <a href="/?screen=groups"><Icon name="users" size={16} />我的团购</a>
          <button type="button" className="gp-link-button" onClick={() => setShowPoster(true)}><Icon name="share" size={17} />分享海报</button>
        </nav>
        <header className="gp-header">
          <div className="gp-brand">
            <span className="gp-state-icon"><Icon name="users" size={24} /></span>
            <div>
              <h1>{group.title}</h1>
            </div>
          </div>
          <span className={`gp-badge gp-badge-${badge.kind}`}><i />{badge.label}</span>
        </header>

        <Countdown group={group} now={now} />
        {configError && <p className="gp-error" role="alert">{configError} <button type="button" className="gp-link-button" onClick={refresh}>重试</button></p>}

        <SummaryCard group={group} amount={amount} />

        <section className="gp-card" aria-label="成员清单">
          <div className="gp-card-head gp-member-head">
            <h2><Icon name="users" size={17} />成员 <b>{group.members.length}</b> 人</h2>
          </div>
          {newEditKey && (
            <div className="gp-editkey-note" role="status">
              <strong>{newEditKey.name} · 编辑凭据</strong>
              <code>{newEditKey.editKey}</code>
              <span>本机已保存；换设备修改请保留此凭据。</span>
              <button type="button" className="gp-link-button" onClick={() => setNewEditKey(null)}>知道了</button>
            </div>
          )}
          <ul className="gp-members">
            {group.members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                editKey={editKeys[String(member.id)]}
                payable={payableByMember.get(member.id)}
                readOnly={memberFormDisabled}
                specs={specs}
                onSaved={handleUpdateMember}
                onDeleted={handleDeleteMember}
                onError={showToast}
              />
            ))}
            {group.members.length === 0 && <li className="gp-empty-line">暂无成员，分享链接邀请参团</li>}
          </ul>
        </section>

        {!readOnly && (
          <MemberForm
            specs={specs}
            disabled={memberFormDisabled}
            disabledReason={memberFormReason}
            onSubmitted={handleAddMember}
          />
        )}
        {!readOnly && (
          <LeaderPanel group={group} specs={specs} configError={configError} onSubmitted={handleLeaderSubmit} onError={showToast} />
        )}

        {readOnly && amount?.phase === 'final' && (
          <section className="gp-card gp-final" aria-label="最终金额">
            <div className="gp-card-head">
              <h2><Icon name="check" />已提交{amount.orderNo ? ` · ${amount.orderNo}` : ''}</h2>
              <p className="gp-helper">
                {amount.freightCents === null
                  ? '发货后显示每人运费。'
                  : '运费按规格重量分摊。'}
              </p>
            </div>
          </section>
        )}

        <footer className="gp-footer">
          <span>这批蟹价格已经尽量压低，我们会认真打包，但活鲜运输途中仍可能出现极少量损耗。按 10 只计算，我们最多只能承受 1 只死蟹的损耗，出现 2 只就会亏本；实际运输货损率很低。若您不能接受这类小概率风险，请先不要下单，感谢理解。</span>
          <a href="/?screen=groups">我的团购</a>
        </footer>
      </div>
      {showPoster && <PosterShare kind="group" token={token} title={group.title} baseUrl={shareBaseUrl} onClose={() => setShowPoster(false)} />}
      {toast && <div className="gp-toast" role="status"><Icon name="check" size={15} />{toast}</div>}
    </div>
  );
}
