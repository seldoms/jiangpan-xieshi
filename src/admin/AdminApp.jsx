import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApi } from './api.js';
import { Icon, StateBlock, StatusPill } from './ui.jsx';
import { formatDateTime } from './format.js';
import BatchHome from './BatchHome.jsx';
import ShipmentCards from './ShipmentCards.jsx';
import ConfigPage from './ConfigPage.jsx';
import UsersPage from './UsersPage.jsx';
import { readOrderCode } from '../storefront/orderCodeRepository.js';

const NAV = [
  { id: 'batch', icon: 'grid', label: '当前批次' },
  { id: 'shipments', icon: 'list', label: '发货卡片' },
  { id: 'config', icon: 'sliders', label: '发售配置' },
  { id: 'users', icon: 'users', label: '用户管理' },
];

function AdminShell({ api, onToast, onLogout, onStorefront, user }) {
  const [section, setSection] = useState('batch');
  const [summary, setSummary] = useState(null);
  const [batches, setBatches] = useState([]);
  const [batchId, setBatchId] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState(null);
  const summaryRequest = useRef(0);

  const loadSummary = useCallback(async () => {
    const requestId = ++summaryRequest.current;
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const [result, catalog] = await Promise.all([
        api.get(`/api/v1/admin/batch/summary${batchId ? `?batchId=${batchId}` : ''}`),
        api.get('/api/v1/admin/batches'),
      ]);
      if (requestId !== summaryRequest.current) return;
      setSummary(result);
      setBatches(catalog.batches);
      if (!batchId) setBatchId(String(result.batch.id));
    } catch (err) {
      if (requestId !== summaryRequest.current) return;
      setSummary(null);
      setSummaryError(err);
    } finally {
      if (requestId === summaryRequest.current) setSummaryLoading(false);
    }
  }, [api, batchId]);

  useEffect(() => { if (section === 'batch' || section === 'shipments') loadSummary(); }, [loadSummary, section]);

  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const activeNav = NAV.find((item) => item.id === section);

  return (
    <div className="admin-layout">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark"><img src="/assets/jiangdu-v1/logo.png" width="256" height="256" alt="" /></div><div><strong>蟹务台</strong></div></div>
        <nav className="side-nav" aria-label="后台导航">
          {NAV.map((item) => (
            <button key={item.id} aria-label={item.label} title={item.label}
              className={section === item.id ? 'nav-item active' : 'nav-item'}
              onClick={() => setSection(item.id)}>
              <Icon name={item.icon} /><span>{item.label}</span>
              {item.id === 'shipments' && summary && <em>{summary.shipmentCount}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="operator">
            <span className="avatar">管</span>
            <div><strong>{user.displayName}</strong><small>{user.role === 'superadmin' ? '超级管理员' : '管理员'}</small></div>
            <button className="icon-button" onClick={onLogout} aria-label="退出登录" title="退出登录"><Icon name="close" size={15} /></button>
          </div>
          <div className="version-note">
            {summary
              ? <>批次 <b>{summary.batch.name}</b><br /><span>截单 {formatDateTime(summary.batch.cutoffTime)}</span></>
              : <span>批次信息加载中…</span>}
          </div>
        </div>
      </aside>
      <main className="admin-main">
        <header className="topbar">
          <div className="breadcrumb"><span>工作台</span><Icon name="chevron" size={14} /><b>{activeNav?.label}</b></div>
          <div className="top-actions">
            <select className="admin-batch-select" aria-label="选择批次" value={batchId} onChange={(event) => setBatchId(event.target.value)}>{batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}{batch.status === 'open' ? ' · 接单中' : ' · 已截单'}</option>)}</select>
            {summary && <StatusPill kind={summary.batch.status === 'open' ? 'live' : 'warm'}>{summary.batch.status === 'open' ? '销售中' : '已截单'}</StatusPill>}
            <span className="top-divider" />
            <span className="top-date">{today}</span>
            {onStorefront && <button type="button" className="button secondary admin-storefront-entry" onClick={onStorefront}><Icon name="arrow" size={15} />查看店铺</button>}
            <button type="button" className="button secondary" onClick={onLogout}>退出登录</button>
          </div>
        </header>
        {section === 'batch' && (
          summaryLoading
            ? <div className="page-wrap"><StateBlock kind="loading" message="正在读取批次汇总…" /></div>
            : summaryError
              ? <div className="page-wrap"><StateBlock
                  kind={summaryError.code === 'BATCH_NOT_FOUND' ? 'empty' : 'error'}
                  title={summaryError.code === 'BATCH_NOT_FOUND' ? '还没有任何批次' : '批次汇总加载失败'}
                  message={summaryError.code === 'BATCH_NOT_FOUND' ? '请先到「发售配置 → 批次管理」创建第一个批次。' : summaryError.message}
                  onRetry={summaryError.code === 'BATCH_NOT_FOUND' ? undefined : loadSummary}
                /></div>
              : <BatchHome api={api} summary={summary} onChanged={loadSummary} onNavigate={setSection} onToast={onToast} />
        )}
        {section === 'shipments' && <ShipmentCards key={batchId} api={api} batchId={batchId} onToast={onToast} />}
        {section === 'config' && <ConfigPage api={api} onToast={onToast} />}
        {section === 'users' && <UsersPage api={api} onToast={onToast} />}
      </main>
    </div>
  );
}

/** 管理端身份由统一下单码登录返回，每次请求仍由服务端验证权限。 */
export default function AdminApp({ onToast, user, onLogout, onStorefront }) {
  const api = useMemo(() => createApi({
    getOrderCode: readOrderCode,
    onUnauthorized: onLogout,
  }), [onLogout]);

  return <AdminShell api={api} user={user} onToast={onToast} onLogout={onLogout} onStorefront={onStorefront} />;
}
