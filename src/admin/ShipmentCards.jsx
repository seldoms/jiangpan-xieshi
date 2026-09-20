import { useCallback, useEffect, useRef, useState } from 'react';
import { Field, Icon, Modal, StateBlock, StatusPill, shipmentStatus } from './ui.jsx';
import { formatCents } from './format.js';
import SpecBadge from '../shared/SpecBadge.jsx';
import FreightModal from './FreightModal.jsx';

const FILTERS = [
  ['all', '全部'],
  ['fishing', '捕捞中'],
  ['packed', '已打包'],
  ['shipped', '已发货'],
];

/** items_json 兼容：定版 {copies, items:[…]}，早期纯数组视为自定义模式。 */
function normalizeItems(raw) {
  if (Array.isArray(raw)) return { copies: null, items: raw.map((it) => ({ ...it, qty: it.qty ?? it.quantity ?? 0 })) };
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return { copies: Number.isInteger(raw?.copies) ? raw.copies : null, items: items.map((it) => ({ ...it, qty: it.qty ?? it.quantity ?? 0 })) };
}

function ShipmentItems({ shipment }) {
  const { copies, items } = normalizeItems(shipment.items);
  return <span className="admin-spec-items">{items.map((item, index) => <span className="admin-spec-item" key={index}><SpecBadge gender={item.gender} weightLabel={item.weightLabel} compact textOnly /> ×{item.qty * (copies ?? 1)}</span>)}</span>;
}

function totalCents(shipment) {
  return (shipment.crabCents ?? 0) + (shipment.packagingCents ?? 0) + (shipment.freightCents ?? 0);
}

function packagingLabel(packaging) {
  return packaging === 'gift' ? '礼盒' : '普通包装';
}

/** 复制到剪贴板：优先 Clipboard API，失败降级到 execCommand（内网 http 调试没有前者）。 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch { return false; }
  }
}

/** 发货时要反复粘到快递系统的一条：姓名 电话 地址 */
const contactText = (shipment) => [shipment.recipient, shipment.phone, shipment.address].filter(Boolean).join(' ');

function GestureCard({ shipment, busy, shakeSignal, onOpen, onPrevious, onNext, onAdvance, onWithdraw, onFreight, onToast }) {
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [hint, setHint] = useState('');
  const [shaking, setShaking] = useState(false);
  const gesture = useRef({ startX: 0, startY: 0, moved: false });
  const status = shipmentStatus(shipment.status);
  const isShipped = shipment.status === 'shipped';
  const freightPending = shipment.freightCents == null;

  useEffect(() => {
    if (!shakeSignal) return undefined;
    setShaking(true);
    const timer = window.setTimeout(() => setShaking(false), 350);
    return () => window.clearTimeout(timer);
  }, [shakeSignal]);

  const resetDrag = () => setDrag({ x: 0, y: 0 });
  const handlePointerDown = (event) => {
    if (busy || event.target.closest('button, input, select, textarea, a')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    gesture.current = { ...gesture.current, startX: event.clientX, startY: event.clientY, moved: false, active: true };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handlePointerMove = (event) => {
    if (!gesture.current.active) return;
    const x = event.clientX - gesture.current.startX;
    const y = event.clientY - gesture.current.startY;
    if (Math.abs(x) > 8 || Math.abs(y) > 8) gesture.current.moved = true;
    setDrag({ x: Math.max(-130, Math.min(130, x)), y: Math.max(-80, Math.min(80, y)) });
  };

  const handleLeft = () => {
    if (busy) return;
    if (shipment.status === 'fishing') onAdvance(shipment, 'packed', '已完成打包，请核对数量后录入快递费');
    else if (shipment.status === 'packed') { onFreight(); setHint('请提交本单快递费，提交后自动标记已发货'); }
    else { setHint('这张单已发货，不能再推进'); onToast('已发货的订单不能再推进'); }
  };

  const handleRight = () => {
    if (busy) return;
    if (shipment.status === 'packed') {
      onWithdraw(shipment, 'fishing', '已撤回到捕捞中');
      return;
    }
    if (shipment.status === 'fishing') { setHint('已在捕捞队列中'); return; }
    if (isShipped) { setHint('已发货的订单不能撤回'); onToast('已发货的订单不能撤回'); return; }
    setHint('捕捞中只能完成打包后再登记快递费');
    onToast('请先完成打包，再登记快递费');
  };

  /** 发货时要反复把收货信息粘到快递系统：点一下就把「姓名 电话 地址」整条复制走。 */
  const copyContact = async (event) => {
    event.stopPropagation();
    const text = contactText(shipment);
    onToast?.((await copyToClipboard(text)) ? `已复制：${text}` : '复制失败，请手动选中文字');
  };

  const handlePointerUp = (event) => {
    if (!gesture.current.active) return;
    const { startX, startY, moved } = gesture.current;
    gesture.current.active = false;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    gesture.current.startX = 0;
    gesture.current.startY = 0;
    resetDrag();
    if (!moved) return;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx)) return;
    if (dx < 0) handleLeft();
    else handleRight();
  };

  const handleKeyDown = (event) => {
    if (busy || event.target !== event.currentTarget) return;
    if (event.key === 'ArrowUp') { event.preventDefault(); onPrevious(); setHint('已切换到上一张'); }
    if (event.key === 'ArrowDown') { event.preventDefault(); onNext(); setHint('已切换到下一张'); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); handleLeft(); }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (shipment.status === 'packed') onWithdraw(shipment, 'fishing', '已撤回到捕捞中');
      else onToast(shipment.status === 'shipped' ? '已发货的订单不能撤回' : '已在捕捞队列中');
    }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(shipment); }
  };

  return (
    <article
      className={`order-card gesture-card${shaking ? ' shake' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${shipment.recipient}的发货单，${status.label}`}
      onClick={() => { if (!gesture.current.moved) onOpen(shipment); }}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { gesture.current.active = false; resetDrag(); }}
      style={{ transform: `translate(${drag.x}px, ${drag.y}px)`, transition: drag.x || drag.y ? 'none' : 'transform .2s ease' }}
    >
      <div className="order-card-top">
        <span className="order-id">{shipment.orderNo}{shipment.source === 'group' ? ' · 拼团' : ''}</span>
        <StatusPill kind={status.kind}>{status.label}</StatusPill>
      </div>
      <div className="order-person">
        <span className="avatar pale">{(shipment.recipient ?? '?').slice(0, 1)}</span>
        {/* 整块可点：点一下就复制「姓名 电话 地址」，方便发货时反复粘贴到快递系统 */}
        <button type="button" className="contact-copy" onClick={copyContact} onPointerDown={(event) => event.stopPropagation()} title="点一下复制收货信息">
          <strong>{shipment.recipient}</strong>
          <p>{shipment.address}</p>
          <p className="contact-phone">{shipment.phone}</p>
        </button>
        <em className="contact-copy-hint">复制</em>
        <Icon name="chevron" size={18} />
      </div>
      <div className="order-detail">
        <ShipmentItems shipment={shipment} />
        <span>{packagingLabel(shipment.packaging)}</span>
        <b>{formatCents(totalCents(shipment))}</b>
      </div>
      <div className="order-detail" style={{ marginTop: 9, paddingTop: 9 }}>
        <span>蟹款 {formatCents(shipment.crabCents)} · 包装 {formatCents(shipment.packagingCents)}</span>
        {freightPending
          ? <b className="freight-pending">运费待确认</b>
          : <b>运费 {formatCents(shipment.freightCents)}</b>}
      </div>
      <div className="summary-foot" style={{ marginTop: 16, gap: 10 }}>
        <span>↕ 上下切换</span>
        {!isShipped && <span>← 左滑{shipment.status === 'fishing' ? '完成打包' : '录运费并发货'}</span>}
        {shipment.status === 'packed' && <span>→ 右滑撤回捕捞</span>}
      </div>
      {hint && <div className="panel-note" style={{ marginTop: 14 }}><span className="note-mark">!</span><p>{hint}</p></div>}
      <div className="modal-actions" style={{ marginTop: 17, paddingTop: 14, borderTop: '1px dashed #e4e3dc' }} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="button secondary" onClick={onPrevious}>上一张</button>
        {shipment.status === 'fishing' && <button type="button" className="button primary" disabled={busy} onClick={() => onAdvance(shipment, 'packed', '已完成打包')}>{busy ? '保存中…' : '完成打包'}</button>}
        {shipment.status === 'packed' && <button type="button" className="button primary" onClick={onFreight}>录入快递费并发货</button>}
        {isShipped && <button type="button" className="button secondary" onClick={() => onOpen(shipment)}>查看详情</button>}
        <button type="button" className="button secondary" onClick={onNext}>下一张</button>
      </div>
    </article>
  );
}

function ShipmentDrawer({ shipment, onClose, onFreight, onDelete }) {
  const [copyHint, setCopyHint] = useState('');
  /** 详情里也要能复制：发货时常常是打开抽屉核对、再粘到快递系统。 */
  const copyDrawerContact = async () => {
    const ok = await copyToClipboard(contactText(shipment));
    setCopyHint(ok ? '已复制' : '复制失败，请手动选中');
    window.setTimeout(() => setCopyHint(''), 1600);
  };
  const status = shipmentStatus(shipment.status);
  const freightPending = shipment.freightCents == null;
  return (
    <div className="drawer-backdrop" role="presentation">
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="发货单详情">
        <div className="drawer-header">
          <h2>{shipment.orderNo}{shipment.source === 'group' ? ' · 拼团' : ''}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </div>
        <div className="drawer-body">
          <StatusPill kind={status.kind}>{status.label}</StatusPill>
          <div className="drawer-person">
            <span className="avatar pale">{(shipment.recipient ?? '?').slice(0, 1)}</span>
            <div><strong>{shipment.recipient}</strong><p>{shipment.address}</p><p>{shipment.phone}</p></div>
          </div>
          <button type="button" className="button secondary" onClick={copyDrawerContact}>{copyHint || '复制收货信息'}</button>
          <div className="drawer-section">
            <span className="eyebrow">下单快照</span>
            {normalizeItems(shipment.items).items.map((it, index) => (
              <div className="drawer-line" key={index}>
                <SpecBadge gender={it.gender} weightLabel={it.weightLabel} compact textOnly />
                <b>{it.qty} 只{normalizeItems(shipment.items).copies ? ` × ${normalizeItems(shipment.items).copies} 份` : ''}</b>
              </div>
            ))}
            <div className="drawer-line"><span>{packagingLabel(shipment.packaging)}</span><b>{formatCents(shipment.packagingCents)}</b></div>
          </div>
          <div className="drawer-section">
            <span className="eyebrow">金额构成</span>
            <div className="drawer-line"><span>蟹款</span><b>{formatCents(shipment.crabCents)}</b></div>
            <div className="drawer-line"><span>包装费</span><b>{formatCents(shipment.packagingCents)}</b></div>
            <div className="drawer-line"><span>运费</span><b>{freightPending ? '待确认' : formatCents(shipment.freightCents)}</b></div>
            <div className="drawer-line"><span>当前应付合计</span><b>{formatCents(totalCents(shipment))}{freightPending ? '（不含运费）' : ''}</b></div>
          </div>
          <div className="drawer-section">
            <button type="button" className="button danger full" onClick={() => onDelete(shipment)}>
              <Icon name="trash" size={15} /> 删除订单 {shipment.orderNo}
            </button>
            <p className="helper">该订单所有地址将一起删除。</p>
          </div>
        </div>
        <div className="drawer-footer">
          {shipment.status === 'packed'
            ? <button className="button primary full" onClick={() => onFreight(shipment)}>录入快递费并发货 <Icon name="check" size={17} /></button>
            : shipment.status === 'shipped'
              ? <button className="button secondary full" onClick={() => onFreight(shipment)}>修改运费</button>
              : <button className="button secondary full" onClick={onClose}>完成打包后登记快递费</button>}
        </div>
      </aside>
    </div>
  );
}

function DeleteOrderModal({ shipment, onClose, onConfirm, submitting, error }) {
  const [reason, setReason] = useState('');
  return (
    <Modal eyebrow={`订单 · ${shipment.orderNo}`} title="确认删除这笔订单？" icon="trash" onClose={() => !submitting && onClose()}>
      <p>{shipment.recipient} · {shipment.address}。删除后订单和发货单从队列移除，操作会写入审计记录。</p>
      <form className="admin-form" onSubmit={(event) => { event.preventDefault(); onConfirm(reason.trim() || null); }}>
        <Field label="删除原因（可选）">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：客户取消" />
        </Field>
        {error && <div className="panel-note"><span className="note-mark">!</span><p>{error}</p></div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={submitting}>取消</button>
          <button type="submit" className="button danger" disabled={submitting}>{submitting ? '删除中…' : '确认删除'}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 发货卡片流：完成打包（按钮/左滑/键盘）后立即打开快递费录入；已打包可重新打开，
 * 提交后由服务端原子推进为已发货；右滑撤回到捕捞中。
 */
export default function ShipmentCards({ api, batchId, onToast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const [drawerShipment, setDrawerShipment] = useState(null);
  const [freightShipment, setFreightShipment] = useState(null);
  const [deleteShipment, setDeleteShipment] = useState(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [shakeSignal, setShakeSignal] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const transitionLock = useRef(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const result = await api.get(`/api/v1/admin/shipments${batchId ? `?batchId=${batchId}` : ''}`);
      setData(result);
      setError(null);
    } catch (err) {
      if (!silent) setError(err);
      else onToast(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [api, batchId, onToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setActiveIndex(0); }, [filter]);

  const shipments = data?.shipments ?? [];
  const filtered = filter === 'all' ? shipments : shipments.filter((s) => s.status === filter);
  const safeIndex = Math.min(activeIndex, Math.max(filtered.length - 1, 0));
  const active = filtered[safeIndex];

  const move = (direction) => {
    if (!filtered.length) return;
    setActiveIndex((index) => (index + direction + filtered.length) % filtered.length);
  };

  const transition = async (shipment, to, message) => {
    if (transitionLock.current) return;
    transitionLock.current = true;
    setTransitioning(true);
    try {
      const updated = await api.post(`/api/v1/admin/shipments/${shipment.id}/transition`, { to });
      setData(current => current ? { ...current, shipments: current.shipments.map(item => item.id === updated.id ? updated : item) } : current);
      if (to === 'packed') setFreightShipment(updated);
      else onToast(message);
      await load({ silent: true });
    } catch (err) {
      navigator.vibrate?.(120);
      setShakeSignal((n) => n + 1);
      onToast(err.status === 409 ? `状态冲突：${err.message}` : err.message);
      await load({ silent: true });
    } finally {
      transitionLock.current = false;
      setTransitioning(false);
    }
  };

  const confirmDelete = async (reason) => {
    if (!deleteShipment) return;
    setDeleteSubmitting(true);
    setDeleteError('');
    try {
      await api.del(`/api/v1/admin/orders/${deleteShipment.orderId}`, { reason });
      onToast(`订单 ${deleteShipment.orderNo} 已删除`);
      setDeleteShipment(null);
      setDrawerShipment(null);
      await load({ silent: true });
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeleteSubmitting(false);
    }
  };

  if (loading) return <div className="page-wrap"><StateBlock kind="loading" message="正在读取发货卡片…" /></div>;
  if (error) {
    return (
      <div className="page-wrap">
        <StateBlock
          kind="error"
          message={error.code === 'BATCH_NOT_FOUND' ? '还没有任何批次，请先到「发售配置」创建批次。' : error.message}
          onRetry={error.code === 'BATCH_NOT_FOUND' ? undefined : () => load()}
        />
      </div>
    );
  }

  return (
    <div className="page-wrap">
      <div className="page-heading compact">
        <div>
          <h1>发货 · {shipments.length}单</h1>
        </div>
        <button className="filter-button" onClick={() => load()}><Icon name="sliders" size={16} />刷新</button>
      </div>
      <div className="order-toolbar">
        <div className="order-tabs">
          {FILTERS.map(([key, label]) => (
            <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
              {label} <b>{key === 'all' ? shipments.length : shipments.filter((s) => s.status === key).length}</b>
            </button>
          ))}
        </div>
        <span>{active ? `第 ${safeIndex + 1} / ${filtered.length} 张` : '暂无发货单'}</span>
      </div>
      {active ? (
        <>
          <div className="orders-list">
            <GestureCard
              key={active.id}
              shipment={active}
              busy={transitioning}
              shakeSignal={shakeSignal}
              onOpen={setDrawerShipment}
              onPrevious={() => move(-1)}
              onNext={() => move(1)}
              onAdvance={transition}
              onWithdraw={transition}
              onFreight={() => setFreightShipment(active)}
              onToast={onToast}
            />
          </div>
        </>
      ) : (
        <StateBlock title="这个状态暂时没有发货单" message="切换上方筛选，或等订单进入履约流程。" />
      )}

      {drawerShipment && (
        <ShipmentDrawer
          shipment={drawerShipment}
          onClose={() => setDrawerShipment(null)}
          onFreight={(s) => { setFreightShipment(s); }}
          onDelete={(s) => { setDeleteError(''); setDeleteShipment(s); }}
        />
      )}
      {freightShipment && (
        <FreightModal
          api={api}
          shipment={freightShipment}
          onClose={() => setFreightShipment(null)}
          onSaved={() => {
            const wasPacked = freightShipment.status === 'packed';
            setFreightShipment(null);
            setDrawerShipment(null);
            load({ silent: true });
            onToast(wasPacked ? '快递费已登记，订单已标记发货' : '快递费已更新');
          }}
          onToast={onToast}
        />
      )}
      {deleteShipment && (
        <DeleteOrderModal
          shipment={deleteShipment}
          onClose={() => setDeleteShipment(null)}
          onConfirm={confirmDelete}
          submitting={deleteSubmitting}
          error={deleteError}
        />
      )}
    </div>
  );
}
