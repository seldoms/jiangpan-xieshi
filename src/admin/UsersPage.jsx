import { useCallback, useEffect, useState } from 'react';
import { Icon, Modal, StateBlock } from './ui.jsx';
import { formatCents, formatDateTime } from './format.js';

/** 用户管理：登录过的用户、下单统计、软删除（页面上消失，数据保留）。 */
export default function UsersPage({ api, onToast }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get('/api/v1/admin/users');
      setUsers(data.users);
    } catch (err) {
      setError(err);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  async function confirmRemove() {
    setBusy(true);
    try {
      await api.del(`/api/v1/admin/users/${removing.id}`);
      onToast(`用户「${removing.displayName}」已删除，其订单一并从页面移除`);
      setRemoving(null);
      load();
    } catch (err) {
      onToast(err.message ?? '删除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-wrap">
      <div className="page-heading compact">
        <h1>用户管理</h1>
        <div className="heading-actions"><button className="button secondary" onClick={load}><Icon name="arrow" size={14} />刷新</button></div>
      </div>
      <section className="panel config-panel">
        {error ? <StateBlock kind="error" title="用户列表加载失败" message={error.message} onRetry={load} />
          : !users ? <StateBlock kind="loading" message="正在读取用户…" />
            : users.length === 0 ? <StateBlock kind="empty" title="还没有用户登录过" />
              : <div className="users-table-scroll">
                <table className="data-table users-table">
                  <thead><tr><th>用户</th><th>下单码</th><th>下单数</th><th>累计金额</th><th>最近下单</th><th>最近登录</th><th /></tr></thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td><strong>{user.displayName}</strong></td>
                        <td><code>{user.orderCode}</code></td>
                        <td>{user.orderCount > 0 ? `${user.orderCount} 单` : '未下单'}</td>
                        <td>{user.orderCount > 0 ? formatCents(user.spendCents) : '—'}</td>
                        <td>{user.lastOrderAt ? formatDateTime(user.lastOrderAt) : '—'}</td>
                        <td>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}</td>
                        <td className="row-actions"><button className="button secondary danger" onClick={() => setRemoving(user)}><Icon name="trash" size={14} />删除</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
      </section>
      {removing && (
        <Modal eyebrow="软删除" title={`删除用户「${removing.displayName}」？`} icon="trash" onClose={() => !busy && setRemoving(null)}>
          <p>删除后该账号无法登录，其 {removing.orderCount} 张订单将从所有页面消失（数据保留，属软删除）。此操作不可在页面撤销。</p>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setRemoving(null)} disabled={busy}>取消</button>
            <button className="button primary" onClick={confirmRemove} disabled={busy}>{busy ? '删除中…' : '确认删除'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
