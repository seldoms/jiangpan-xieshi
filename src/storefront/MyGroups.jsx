import { useEffect, useState } from 'react'
import { api, formatYuan, isAuthError } from './api'
import { AssetIcon } from './ImageSlot'
import PosterShare from '../shared/PosterShare'
import './my-groups.css'

function statusLabel(group) {
  if (group.status === 'submitted') return '已成团'
  if (group.isAfterCutoff) return '已截单'
  return group.canSubmit ? '待团长提交' : '拼团中'
}

export default function MyGroups({ loggedIn, onNeedLogin, onReauth, onCreate, baseUrl }) {
  const [groups, setGroups] = useState(null)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [sharing, setSharing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    if (!loggedIn) return
    let active = true
    setGroups(null)
    setError(null)
    api.listMyGroups().then(data => { if (active) setGroups(data.groups) })
      .catch(err => { if (active) setError(err) })
    return () => { active = false }
  }, [loggedIn, attempt])

  // 撤销是软删除：团从列表消失，已提交产生的订单同时撤销。有人参与时先弹确认。
  async function removeGroup(group) {
    setDeleting(true)
    setActionError('')
    try {
      await api.deleteGroup(group.token)
      setGroups(list => (list ?? []).filter(item => item.id !== group.id))
      setPendingDelete(null)
    } catch (err) {
      setPendingDelete(null)
      setActionError(err?.message ?? '删除失败，请稍后重试。')
    } finally {
      setDeleting(false)
    }
  }

  function askDelete(group) {
    setActionError('')
    if (group.otherMemberCount > 0) setPendingDelete(group)
    else removeGroup(group)
  }

  return <section className="jd-orders-page jd-my-groups" aria-labelledby={loggedIn ? 'jd-my-groups-title' : undefined}>
    {loggedIn && <div className="jd-form-heading"><h1 id="jd-my-groups-title">我的团购</h1><button type="button" className="jd-button-plain" onClick={onCreate}><AssetIcon name="plus" size={16} />发起拼团</button></div>}
    {actionError && <p role="alert" className="jd-form-error">{actionError}</p>}
    {!loggedIn ? <div className="jd-empty"><span className="jd-empty-bag"><AssetIcon name="users" size={38} /></span><h2>登录后查看</h2><button type="button" className="jd-button" onClick={onNeedLogin}>去登录<AssetIcon name="arrow-right" size={16} /></button></div>
      : error ? <div className="jd-home-state" role="alert"><p>{error.message}</p><button type="button" onClick={isAuthError(error) ? onReauth : () => setAttempt(value => value + 1)}>{isAuthError(error) ? '重新登录' : '重试'}</button></div>
        : !groups ? <p className="jd-home-state" role="status">正在加载团购…</p>
          : !groups.length ? <div className="jd-empty"><span className="jd-empty-bag"><AssetIcon name="users" size={38} /></span><h2>还没有发起团购</h2></div>
            : <div className="jd-my-groups-list">{groups.map(group => <article className="jd-my-group" key={group.id}>
              <div className="jd-my-group-heading"><h2><a href={`/?group=${encodeURIComponent(group.token)}`}>{group.title}</a></h2><span>{statusLabel(group)}</span></div>
              <div className="jd-my-group-summary"><span>{group.memberCount} 人 · {group.totalCount} 只</span><strong>{formatYuan(group.amount.totalCents)}{group.amount.freightCents == null && <small> + 运费</small>}</strong></div>
              <div className="jd-my-group-actions"><a className="jd-button-plain" href={`/?group=${encodeURIComponent(group.token)}`}>查看团购<AssetIcon name="arrow-right" size={16} /></a><button type="button" className="jd-button-plain" onClick={() => setSharing(group)}><AssetIcon name="qr" size={18} />链接与海报</button><button type="button" className="jd-button-plain" disabled={deleting} onClick={() => askDelete(group)}><AssetIcon name="trash" size={16} />删除</button></div>
            </article>)}</div>}
    {sharing && <PosterShare kind="group" token={sharing.token} title={sharing.title} baseUrl={baseUrl} onClose={() => setSharing(null)} />}
    {pendingDelete && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="jd-group-delete-title"><h2 id="jd-group-delete-title">已经有人参与了，确定要删除吗？</h2><p>「{pendingDelete.title}」已有 {pendingDelete.memberCount} 人参与。删除后这个拼团会从列表里消失，拼团产生的订单也会一并撤销。</p><div className="modal-actions"><button type="button" className="jd-button-plain" disabled={deleting} onClick={() => setPendingDelete(null)}>先不删</button><button type="button" className="jd-button" disabled={deleting} onClick={() => removeGroup(pendingDelete)}>{deleting ? '删除中…' : '确定删除'}<AssetIcon name="trash" size={16} /></button></div></div></div>}
  </section>
}
