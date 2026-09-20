import { useState } from 'react';
import SpecBadge from '../shared/SpecBadge.jsx';
import { Icon, Modal, StateBlock, StatusPill } from './ui.jsx';
import { formatCents, formatDateTime } from './format.js';

function Metric({ value, label, tone, children }) {
  return (
    <div className={`metric-card ${tone}`}>
      <div className="metric-top"><span>{label}</span><span className="metric-spark" /></div>
      <strong>{value}</strong>
      {children}
    </div>
  );
}

function GenderGroup({ title, tone, rows }) {
  const total = rows.reduce((sum, row) => sum + row.quantity, 0);
  return (
    <section className="capture-group">
      <div className="capture-group-head">
        <h2>{title} · {total}<small>只</small></h2>
      </div>
      {rows.length === 0
        ? <div className="capture-empty">本批暂无{title}需求</div>
        : rows.map((row) => (
          <div className="capture-row" key={row.weightLabel}>
            <div className="capture-row-main as-static">
              <SpecBadge gender={row.gender} weightLabel={row.weightLabel} compact textOnly />
              <strong>{row.quantity}<small>只</small></strong>
            </div>
          </div>
        ))}
    </section>
  );
}

/**
 * 首屏：当前批次汇总（订单数/发货单数/状态分布/截单时间）+ 待捕捞按公母×规格汇总。
 * summary 为 GET /api/v1/admin/batch/summary 的响应。
 */
export default function BatchHome({ api, summary, onChanged, onNavigate, onToast }) {
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');

  const { batch, totalsBySpec, orderCount, shipmentCount, statusCounts, revenueCents, revenue } = summary;
  const male = totalsBySpec.filter((row) => row.gender === 'male');
  const female = totalsBySpec.filter((row) => row.gender === 'female');
  const totalCrabs = totalsBySpec.reduce((sum, row) => sum + row.quantity, 0);
  const isOpen = batch.status === 'open';

  const closeBatch = async () => {
    setClosing(true);
    setError('');
    try {
      await api.post(`/api/v1/admin/batches/${batch.id}/close`);
      setConfirmClose(false);
      onToast('已截单，批次进入捕捞履约');
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="page-wrap">
      <div className="page-heading">
        <div>
          <h1>本批订单</h1>
        </div>
        <div className="heading-actions">
          <StatusPill kind={isOpen ? 'live' : 'warm'}>{isOpen ? '销售中' : '已截单'}</StatusPill>
          {isOpen && <button className="button primary" onClick={() => setConfirmClose(true)}>截单 <Icon name="arrow" size={16} /></button>}
        </div>
      </div>

      <div className="metric-grid">
        <Metric value={orderCount} label="订单数" tone="coral" />
        <Metric value={formatCents(revenueCents ?? 0)} label="预计收入" tone="money">
          <small className="metric-money-note">{(revenue?.freightPendingCount ?? 0) > 0 ? `${revenue.freightPendingCount} 单运费待录` : '已含运费'}</small>
        </Metric>
        <Metric value={shipmentCount} label="发货单数" tone="blue" />
        <Metric value={totalCrabs} label="总只数" tone="amber" />
        <Metric value={statusCounts.shipped} label="已发货" tone="muted" />
      </div>

      <div className="content-grid batch-workspace">
        <section className="panel focus-panel capture-panel">
          <div className="panel-header">
            <h2>待捕捞 · {totalCrabs}只</h2>
          </div>
          {totalsBySpec.length === 0
            ? <StateBlock title="本批暂无发货单" message="有订单进入履约后，这里会显示待捕捞数量。" />
            : <div className="capture-groups"><GenderGroup title="公蟹" tone="coral" rows={male} /><GenderGroup title="母蟹" tone="amber" rows={female} /></div>}
        </section>
        <section className="panel quick-panel">
          <div className="panel-header"><h2>发货进度</h2><StatusPill kind={isOpen ? 'live' : 'warm'}>{isOpen ? '待截单' : '已截单'}</StatusPill></div>
          <div className="queue-list">
            <button className="queue-row" onClick={() => onNavigate('shipments')}><span className="queue-index">01</span><span className="queue-label">捕捞中</span><strong>{statusCounts.fishing}</strong><span className="queue-action">去处理 <Icon name="arrow" size={14} /></span></button>
            <button className="queue-row" onClick={() => onNavigate('shipments')}><span className="queue-index">02</span><span className="queue-label">已打包</span><strong>{statusCounts.packed}</strong><span className="queue-action">去处理 <Icon name="arrow" size={14} /></span></button>
            <button className="queue-row" onClick={() => onNavigate('shipments')}><span className="queue-index">03</span><span className="queue-label">已发货</span><strong>{statusCounts.shipped}</strong><span className="queue-action">查看 <Icon name="arrow" size={14} /></span></button>
          </div>
          <div className="queue-foot"><span>截单时间</span><b>{formatDateTime(batch.cutoffTime)}</b></div>
          <button className="text-action" onClick={() => onNavigate('shipments')}>处理发货 <Icon name="arrow" size={16} /></button>
        </section>
      </div>


      {confirmClose && (
        <Modal eyebrow="销售阶段结束" title={`确认截单 ${batch.name}？`} onClose={() => !closing && setConfirmClose(false)}>
          <p>截单后该批次停止接收新订单，现有 {shipmentCount} 张发货单进入捕捞履约流程。</p>
          {error && <div className="panel-note"><span className="note-mark">!</span><p>{error}</p></div>}
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setConfirmClose(false)} disabled={closing}>再看一眼</button>
            <button className="button primary" onClick={closeBatch} disabled={closing}>{closing ? '提交中…' : '确认截单'} <Icon name="arrow" size={16} /></button>
          </div>
        </Modal>
      )}
    </div>
  );
}
