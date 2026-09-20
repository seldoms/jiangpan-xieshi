/**
 * 管理端共享展示组件：图标、状态徽章、弹窗骨架、加载/错误/空状态。
 */

export function Icon({ name, size = 18 }) {
  const paths = {
    grip: <><path d="M8 5h.01M8 12h.01M8 19h.01M16 5h.01M16 12h.01M16 19h.01" strokeWidth="3" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    package: <><path d="m4 8 8-4 8 4-8 4-8-4Z"/><path d="M4 8v9l8 4 8-4V8M12 12v9"/></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></>,
    sliders: <><path d="M4 6h16M4 18h16M8 6v4M16 14v4"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/></>,
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    trash: <><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></>,
    crab: <><path d="M7 14a5 5 0 0 0 10 0M5 10a3 3 0 0 0-3 3M19 10a3 3 0 0 1 3 3M8 8a4 4 0 0 1 8 0v6H8V8Z"/><path d="M9 5 7 2M15 5l2-3M10 11h.01M14 11h.01"/></>,
    users: <><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c0-3.2 2.5-5 5.5-5s5.5 1.8 5.5 5"/><path d="M15.5 5.4a3.2 3.2 0 0 1 0 5.6M17.5 14.3c2 .7 3 2.3 3 4.7"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function StatusPill({ children, kind = 'neutral' }) {
  return <span className={`status-pill ${kind}`}><span className="status-dot" />{children}</span>;
}

/** 发货单状态字典：与后端状态机 fishing → packed → shipped 对应。 */
export const SHIPMENT_STATUS = {
  fishing: { label: '捕捞中', kind: 'warm' },
  packed: { label: '已打包', kind: 'live' },
  shipped: { label: '已发货', kind: 'neutral' },
};

export function shipmentStatus(status) {
  return SHIPMENT_STATUS[status] ?? { label: status ?? '未知', kind: 'neutral' };
}

export function Modal({ eyebrow, title, icon = 'package', onClose, children, wide = false }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className={wide ? 'modal modal-wide' : 'modal'} role="dialog" aria-modal="true">
        <button type="button" className="modal-close" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        <div className="admin-modal-heading"><Icon name={icon} size={20} /><h2>{title}</h2></div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

/** 加载中 / 错误 / 空数据的统一占位。 */
export function StateBlock({ kind = 'empty', title, message, onRetry }) {
  if (kind === 'loading') {
    return <div className="state-block" role="status"><span>{message ?? '加载中…'}</span></div>;
  }
  if (kind === 'error') {
    return (
      <div className="state-block error">
        <strong>{title ?? '加载失败'}</strong>
        <span>{message}</span>
        {onRetry && <button type="button" className="button secondary" onClick={onRetry}>重试</button>}
      </div>
    );
  }
  return (
    <div className="state-block">
      <span>{title ?? message ?? '暂无数据'}</span>
      {onRetry && <button type="button" className="button secondary" onClick={onRetry}>刷新</button>}
    </div>
  );
}
