import { useCallback, useEffect, useState } from 'react';
import SpecBadge from '../shared/SpecBadge.jsx';
import useSortableRows from './useSortableRows.js';
import { Field, Icon, Modal, StateBlock, StatusPill } from './ui.jsx';
import { centsToYuanInput, formatCents, formatDateTime, localInputToIso, yuanToCents } from './format.js';
// 管理端自有样式单独一个文件，不动多人共用的 design-system.css。
import './admin.css';

const TABS = [
  ['specs', '规格管理'],
  ['templates', '预设套装'],
  ['packaging', '包装价格'],
  ['coupon', '满减优惠码'],
  ['batches', '批次管理'],
  ['sharing', '分享设置'],
  ['notice', '公告'],
];

function genderLabel(gender) {
  return gender === 'male' ? '公' : '母';
}

/** 常见规格档位：公蟹偏大、母蟹偏小；确需新档位时选「其它」手动填写。 */
const WEIGHT_PRESETS = {
  male: ['3两', '3.5两', '4两', '4.5两', '5两'],
  female: ['2两', '2.5两', '3两', '3.5两', '4两'],
};
const CUSTOM_WEIGHT = '__custom__';

/* ---------------- 规格管理 ---------------- */

function SpecEditModal({ api, spec, batches, onClose, onSaved, onToast }) {
  const isEdit = Boolean(spec);
  const [gender, setGender] = useState(spec?.gender ?? 'male');
  const [weightLabel, setWeightLabel] = useState(spec?.weightLabel ?? '');
  const [customWeight, setCustomWeight] = useState(false);
  const [priceYuan, setPriceYuan] = useState(() => centsToYuanInput(spec?.priceCents));
  const [batchId, setBatchId] = useState(spec?.batchId ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    const priceCents = yuanToCents(priceYuan);
    if (!isEdit && !weightLabel.trim()) { setError('请填写规格名（如 4两）'); return; }
    if (priceCents === null || priceCents === undefined) { setError('请填写有效的单价（元）'); return; }
    setSubmitting(true);
    setError('');
    try {
      const batchValue = batchId === '' ? null : Number(batchId);
      // 规格档位固定：编辑已有规格只改单价，不重写公母和重量档位。
      const payload = isEdit
        ? { priceCents, batchId: batchValue }
        : { gender, weightLabel: weightLabel.trim(), priceCents, batchId: batchValue };
      // 新增规格不再自带顺序：顺序一律由后端排到末位（旧的写死 sort:9999 会把排序功能搞坏）
      if (isEdit) await api.put(`/api/v1/admin/specs/${spec.id}`, payload);
      else await api.post('/api/v1/admin/specs', { ...payload, active: true });
      onToast(isEdit ? `已保存 ${genderLabel(spec.gender)}${spec.weightLabel} 单价` : '规格已创建');
      onSaved();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <Modal eyebrow="蟹规格" title={isEdit ? `改单价 · ${genderLabel(spec.gender)}${spec.weightLabel}` : '新增规格'} onClose={() => !submitting && onClose()}>
      <form className="admin-form" onSubmit={submit}>
        {isEdit ? (
          <Field label="规格" hint="规格档位固定，日常只改单价">
            <div className="spec-readonly"><SpecBadge gender={spec.gender} weightLabel={spec.weightLabel} textOnly /></div>
          </Field>
        ) : (
          <>
            <Field label="公母">
              <div className="radio-row">
                {[['male', '公蟹'], ['female', '母蟹']].map(([value, label]) => (
                  <button type="button" key={value} className={gender === value ? 'chip active' : 'chip'} onClick={() => setGender(value)}>{label}</button>
                ))}
              </div>
            </Field>
            <Field label="规格名" hint="从常见档位里选，避免手打误差">
              <select value={customWeight ? CUSTOM_WEIGHT : weightLabel} onChange={(e) => {
                const value = e.target.value;
                setCustomWeight(value === CUSTOM_WEIGHT);
                setWeightLabel(value === CUSTOM_WEIGHT ? '' : value);
              }}>
                <option value="">请选择规格</option>
                {(WEIGHT_PRESETS[gender] ?? []).map((weight) => <option key={weight} value={weight}>{weight}</option>)}
                <option value={CUSTOM_WEIGHT}>其它（手动填写）</option>
              </select>
            </Field>
            {customWeight && (
              <Field label="自定义规格名" hint="例如 5.5两">
                <input value={weightLabel} onChange={(e) => setWeightLabel(e.target.value)} placeholder="5.5两" />
              </Field>
            )}
          </>
        )}
        <Field label="单价（元 / 只）">
          <input inputMode="decimal" value={priceYuan} onChange={(e) => setPriceYuan(e.target.value)} placeholder="88" />
        </Field>
        <Field label="适用批次">
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            <option value="">全局（所有批次）</option>
            {batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        {error && <div className="panel-note"><span className="note-mark">!</span><p>{error}</p></div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={submitting}>取消</button>
          <button type="submit" className="button primary" disabled={submitting}>{submitting ? '保存中…' : isEdit ? '保存单价' : '保存规格'} <Icon name="check" size={16} /></button>
        </div>
      </form>
    </Modal>
  );
}

function SpecsTab({ api, onToast }) {
  const [specs, setSpecs] = useState(null);
  const [batches, setBatches] = useState([]);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(undefined); // undefined=关闭, null=新建
  const [removing, setRemoving] = useState(null); // 待确认删除的规格
  const [removingBusy, setRemovingBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');

  const load = useCallback(async () => {
    try {
      const [{ specs: specList }, { batches: batchList }] = await Promise.all([
        api.get('/api/v1/admin/specs'),
        api.get('/api/v1/admin/batches'),
      ]);
      setSpecs(specList);
      setBatches(batchList);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (spec) => {
    try {
      await api.put(`/api/v1/admin/specs/${spec.id}`, { active: !spec.active });
      onToast(spec.active ? `已停用 ${genderLabel(spec.gender)}${spec.weightLabel}` : `已启用 ${genderLabel(spec.gender)}${spec.weightLabel}`);
      await load();
    } catch (err) {
      onToast(err.message);
    }
  };

  // 缺货开关：用户端仍显示该规格、但标「缺货」且不可下单（对比 active=false 是完全不下发）
  const toggleSoldOut = async (spec) => {
    try {
      await api.put(`/api/v1/admin/specs/${spec.id}`, { soldOut: !spec.soldOut });
      onToast(spec.soldOut
        ? `已恢复上架 ${genderLabel(spec.gender)}${spec.weightLabel}`
        : `已标记缺货 ${genderLabel(spec.gender)}${spec.weightLabel}（前台仍展示，不可下单）`);
      await load();
    } catch (err) {
      onToast(err.message);
    }
  };

  const askRemove = (spec) => {
    setRemoveError('');
    setRemoving(spec);
  };

  /**
   * 删除规格。订单存的是下单时的快照，所以删规格不影响历史订单；
   * 但规格被预设套装引用时后端会拒绝（409 SPEC_IN_USE），message 里已写明原因，原样透出。
   */
  const confirmRemove = async () => {
    if (!removing) return;
    setRemovingBusy(true);
    setRemoveError('');
    try {
      await api.del(`/api/v1/admin/specs/${removing.id}`);
      onToast(`已删除 ${genderLabel(removing.gender)}${removing.weightLabel}`);
      setRemoving(null);
      await load();
    } catch (err) {
      onToast(err.message);       // 409 SPEC_IN_USE → 后端文案原样 toast
      setRemoveError(err.message); // 弹窗里也留一份，关掉 toast 后还能看见
      // 404 SPEC_NOT_FOUND：这条规格已经不存在了，关掉弹窗并刷新列表即可。
      if (err.code === 'SPEC_NOT_FOUND') { setRemoving(null); await load(); }
    } finally {
      setRemovingBusy(false);
    }
  };

  const sorter = useSortableRows({ items: specs ?? [], setItems: setSpecs, api, endpoint: '/api/v1/admin/specs/reorder', onToast, reload: load, group: 'specs' });

  /** 一键置顶：按「公母分组 + 价格降序」重排，贵的高品质的排在前面。 */
  const autoSort = async () => {
    try {
      const res = await api.post('/api/v1/admin/specs/auto-sort', {});
      setSpecs(res.specs);
      onToast('已按价格置顶');
    } catch (err) {
      onToast(err.message);
    }
  };

  if (error) return <StateBlock kind="error" message={error.message} onRetry={load} />;
  if (!specs) return <StateBlock kind="loading" message="正在读取规格…" />;

  const batchName = (id) => (id == null ? '全局' : batches.find((b) => b.id === id)?.name ?? `批次 ${id}`);

  return (
    <section className="panel config-panel">
      <div className="panel-header">
        <h2>规格单价</h2>
        <div className="spec-panel-actions">
          <button className="button secondary" onClick={autoSort} disabled={sorter.saving} title="价格高的规格排到最前">高品质置顶</button>
          <button className="button primary" onClick={() => setEditing(null)}><Icon name="plus" size={15} /> 新增规格</button>
        </div>
      </div>
      {specs.length === 0 ? <StateBlock title="还没有规格" message="点击右上角新增第一个可售规格。" /> : (
        <table className="data-table sortable-table specs-table">
          <thead><tr><th aria-label="排序" /><th>规格</th><th>单价</th><th>批次</th><th>状态</th><th /></tr></thead>
          <tbody>
            {specs.map((spec) => (
              <tr key={spec.id} data-sort-id={spec.id} data-sort-group="specs" className={sorter.activeId === spec.id ? 'sorting-row' : sorter.overId === spec.id ? 'sort-target' : ''}>
                <td><button {...sorter.handleProps(spec, `${genderLabel(spec.gender)}${spec.weightLabel}`)}><Icon name="grip" /></button></td>
                <td><SpecBadge gender={spec.gender} weightLabel={spec.weightLabel} compact textOnly /></td>
                <td>{formatCents(spec.priceCents)} / 只</td>
                <td>{batchName(spec.batchId)}</td>
                <td>
                  <div className="spec-row-state">
                    {/* 启用/停用：停用后用户端完全看不到这个规格 */}
                    <button className={`toggle ${spec.active ? 'on' : ''}`} aria-label={spec.active ? '停用' : '启用'} onClick={() => toggle(spec)}><i /></button>
                    {/* 缺货：用户端仍看得见，但标「缺货」、不可下单（区别于停用） */}
                    <button
                      className={`small-link${spec.soldOut ? ' is-danger' : ''}`}
                      onClick={() => toggleSoldOut(spec)}
                      title={spec.soldOut ? '恢复上架后用户即可下单' : '标记缺货：前台仍展示，但不可下单'}
                    >{spec.soldOut ? '缺货中' : '标记缺货'}</button>
                  </div>
                </td>
                <td>
                  {/* 改价 / 删除同排：都是 .small-link（文字操作层），统一层给的是同一套高度，天然等高。 */}
                  <div className="spec-row-actions">
                    <button className="small-link" onClick={() => setEditing(spec)}>改价</button>
                    <button className="small-link is-danger" onClick={() => askRemove(spec)}>删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing !== undefined && (
        <SpecEditModal
          api={api}
          spec={editing}
          batches={batches}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); load(); }}
          onToast={onToast}
        />
      )}
      {removing && (
        <Modal eyebrow="蟹规格" title="删除规格" icon="trash" onClose={() => !removingBusy && setRemoving(null)}>
          <p>确定删除 {genderLabel(removing.gender)}{removing.weightLabel} 这个规格吗？删除后不影响历史订单（订单已存下单时的快照）</p>
          {removeError && <div className="panel-note"><span className="note-mark">!</span><p>{removeError}</p></div>}
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={() => setRemoving(null)} disabled={removingBusy}>取消</button>
            <button type="button" className="button danger" onClick={confirmRemove} disabled={removingBusy}>{removingBusy ? '删除中…' : '确认删除'}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/* ---------------- 预设套装 ---------------- */

function TemplateEditModal({ api, template, specs, onClose, onSaved, onToast }) {
  const isEdit = Boolean(template);
  const [name, setName] = useState(template?.name ?? '');
  const [packaging, setPackaging] = useState(template?.packaging ?? 'plain');
  const [qtys, setQtys] = useState(() => {
    const map = {};
    for (const item of template?.items ?? []) map[item.specId] = item.quantity;
    return map;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const total = specs.reduce((sum, spec) => sum + (Number(qtys[spec.id]) || 0), 0);
  const totalOk = total === 10;

  const setQty = (specId, value) => {
    const n = value === '' ? 0 : Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 10) return;
    setQtys((current) => ({ ...current, [specId]: n }));
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim()) { setError('请填写套装名称'); return; }
    if (!totalOk) { setError(`每份合计必须为 10 只，当前为 ${total} 只`); return; }
    const items = specs
      .map((spec) => ({ specId: spec.id, quantity: Number(qtys[spec.id]) || 0 }))
      .filter((item) => item.quantity > 0);
    setSubmitting(true);
    setError('');
    try {
      if (isEdit) await api.put(`/api/v1/admin/package-templates/${template.id}`, { name: name.trim(), packaging, items });
      else await api.post('/api/v1/admin/package-templates', { name: name.trim(), packaging, items });
      onToast(isEdit ? '预设套装已更新' : '预设套装已创建');
      onSaved();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <Modal eyebrow="预设套装 · 每份 10 只成盒" title={isEdit ? `编辑「${template.name}」` : '新建预设套装'} onClose={() => !submitting && onClose()} wide>
      <form className="admin-form" onSubmit={submit}>
        <Field label="套装名称">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 5公5母混合礼盒" />
        </Field>
        <Field label="包装">
          <div className="radio-row">
            {[['plain', '普通包装'], ['gift', '礼盒']].map(([value, label]) => (
              <button type="button" key={value} className={packaging === value ? 'chip active' : 'chip'} onClick={() => setPackaging(value)}>{label}</button>
            ))}
          </div>
        </Field>
        <div className="spec-picker">
          <div className="spec-picker-head">
            <span>规格</span>
            <span className={`total-badge ${totalOk ? 'ok' : 'bad'}`}>合计 {total} / 10 只</span>
          </div>
          {specs.length === 0 && <p className="helper">还没有可售规格，请先在「规格管理」中新增。</p>}
          {specs.map((spec) => (
            <div className="spec-picker-row" key={spec.id}>
              <SpecBadge gender={spec.gender} weightLabel={spec.weightLabel} compact textOnly />
              <span className="spec-picker-name">{formatCents(spec.priceCents)}/只{spec.active ? '' : '（已停用）'}</span>
              <input className="qty-input" inputMode="numeric" value={qtys[spec.id] ?? 0} onChange={(e) => setQty(spec.id, e.target.value)} aria-label={`${spec.weightLabel}数量`} />
            </div>
          ))}
        </div>
        {error && <div className="panel-note"><span className="note-mark">!</span><p>{error}</p></div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={submitting}>取消</button>
          <button type="submit" className="button primary" disabled={submitting || !totalOk || specs.length === 0}>{submitting ? '保存中…' : '保存预设套装'} <Icon name="check" size={16} /></button>
        </div>
      </form>
    </Modal>
  );
}

function TemplatesTab({ api, onToast }) {
  const [templates, setTemplates] = useState(null);
  const [specs, setSpecs] = useState([]);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(undefined);

  const load = useCallback(async () => {
    try {
      const [{ templates: list }, { specs: specList }] = await Promise.all([
        api.get('/api/v1/admin/package-templates'),
        api.get('/api/v1/admin/specs'),
      ]);
      setTemplates(list);
      setSpecs(specList);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (template) => {
    try {
      await api.post(`/api/v1/admin/package-templates/${template.id}/toggle`);
      onToast(template.active ? `已停用「${template.name}」` : `已启用「${template.name}」`);
      await load();
    } catch (err) {
      onToast(err.message);
    }
  };

  const sorter = useSortableRows({ items: templates ?? [], setItems: setTemplates, api, endpoint: '/api/v1/admin/package-templates/reorder', onToast, reload: load, group: 'templates' });

  if (error) return <StateBlock kind="error" message={error.message} onRetry={load} />;
  if (!templates) return <StateBlock kind="loading" message="正在读取预设套装…" />;

  return (
    <section className="panel config-panel">
      <div className="panel-header">
        <h2>预设套装</h2>
        <button className="button primary" onClick={() => setEditing(null)}><Icon name="plus" size={15} /> 新建预设套装</button>
      </div>
      {templates.length === 0 ? <StateBlock title="还没有预设套装" message="新建预设套装支持全公、全母或任意规格混合，一盒总数固定 10 只。" /> : (
        <table className="data-table sortable-table templates-table">
          <thead><tr><th aria-label="排序" /><th>名称</th><th>组合</th><th>包装</th><th>单份蟹款</th><th>状态</th><th /></tr></thead>
          <tbody>
            {templates.map((template) => (
              <tr key={template.id} data-sort-id={template.id} data-sort-group="templates" className={sorter.activeId === template.id ? 'sorting-row' : sorter.overId === template.id ? 'sort-target' : ''}>
                <td><button {...sorter.handleProps(template, template.name)}><Icon name="grip" /></button></td>
                <td><b className="cell-strong">{template.name}</b></td>
                <td>{template.items.map((it) => <span className="admin-spec-item" key={it.specId}><SpecBadge gender={it.gender} weightLabel={it.weightLabel} compact textOnly /> ×{it.quantity}</span>)}<span className={`total-badge ${template.totalCount === 10 ? 'ok' : 'bad'}`} style={{ marginLeft: 8 }}>{template.totalCount} 只</span></td>
                <td>{template.packaging === 'gift' ? '礼盒' : '普通包装'}</td>
                <td>{formatCents(template.crabCentsPerCopy)}</td>
                <td><button className={`toggle ${template.active ? 'on' : ''}`} aria-label={template.active ? '停用' : '启用'} onClick={() => toggle(template)}><i /></button></td>
                <td><button className="small-link" onClick={() => setEditing(template)}>编辑</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing !== undefined && (
        <TemplateEditModal
          api={api}
          template={editing}
          specs={specs}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); load(); }}
          onToast={onToast}
        />
      )}
    </section>
  );
}

/* ---------------- 包装价格 ---------------- */

function PackagingTab({ api, onToast }) {
  const [settings, setSettings] = useState(null);
  const [plainYuan, setPlainYuan] = useState('');
  const [giftYuan, setGiftYuan] = useState('');
  const [error, setError] = useState(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const { settings: map } = await api.get('/api/v1/admin/settings');
      setSettings(map);
      setPlainYuan(centsToYuanInput(map['packaging.plain'] ?? 0));
      setGiftYuan(centsToYuanInput(map['packaging.gift'] ?? 0));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const save = async (event) => {
    event.preventDefault();
    const plain = yuanToCents(plainYuan);
    const gift = yuanToCents(giftYuan);
    if (plain === null || plain === undefined || gift === null || gift === undefined) {
      setFormError('请填写有效的包装价格（元，可为 0）');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await api.put('/api/v1/admin/settings', { 'packaging.plain': plain, 'packaging.gift': gift });
      onToast('包装价格已保存');
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <StateBlock kind="error" message={error.message} onRetry={load} />;
  if (!settings) return <StateBlock kind="loading" message="正在读取包装价格…" />;

  return (
    <section className="panel config-panel">
      <div className="panel-header"><h2>包装 · 元/盒</h2></div>
      <form className="admin-form" onSubmit={save}>
        <Field label="普通包装（元 / 盒）">
          <input inputMode="decimal" value={plainYuan} onChange={(e) => setPlainYuan(e.target.value)} />
        </Field>
        <Field label="礼盒（元 / 盒）">
          <input inputMode="decimal" value={giftYuan} onChange={(e) => setGiftYuan(e.target.value)} />
        </Field>
        {formError && <div className="panel-note"><span className="note-mark">!</span><p>{formError}</p></div>}
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button type="submit" className="button primary" disabled={saving}>{saving ? '保存中…' : '保存包装价格'} <Icon name="check" size={16} /></button>
        </div>
      </form>
    </section>
  );
}

/* ---------------- 批次管理 ---------------- */

function BatchesTab({ api, onToast }) {
  const [batches, setBatches] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [cutoff, setCutoff] = useState('');
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);
  const [closingId, setClosingId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editCutoff, setEditCutoff] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const { batches: list } = await api.get('/api/v1/admin/batches');
      setBatches(list);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const create = async (event) => {
    event.preventDefault();
    const cutoffIso = localInputToIso(cutoff);
    if (!name.trim()) { setFormError('请填写批次名称'); return; }
    if (!cutoffIso) { setFormError('请选择合法的截单时间'); return; }
    setCreating(true);
    setFormError('');
    try {
      await api.post('/api/v1/admin/batches', { name: name.trim(), cutoffTime: cutoffIso });
      onToast(`批次「${name.trim()}」已创建`);
      setName('');
      setCutoff('');
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const close = async (batch) => {
    setClosingId(batch.id);
    try {
      await api.post(`/api/v1/admin/batches/${batch.id}/close`);
      onToast(`批次「${batch.name}」已截单`);
      await load();
    } catch (err) {
      onToast(err.message);
    } finally {
      setClosingId(null);
    }
  };

  const edit = (batch) => {
    // 只回填「几点几分」：截单时间日常只改时分，日期跟着批次自己的配送日走。
    setEditCutoff(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(batch.cutoffTime)));
    setFormError('');
    setEditing(batch);
  };
  // 只填几点几分：把时分合并到该批次原本的配送日（北京时间 UTC+8），管理员不用选年月日。
  const timeOnBatchDate = (time, originalIso) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(originalIso ?? Date.now()));
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, hours - 8, minutes)).toISOString();
  };
  const saveCutoff = async (event) => {
    event.preventDefault();
    const cutoffTime = timeOnBatchDate(editCutoff, editing?.cutoffTime);
    if (!cutoffTime) { setFormError('请填写合法的截单时间，例如 17:00'); return; }
    setSaving(true);
    setFormError('');
    try {
      await api.put(`/api/v1/admin/batches/${editing.id}`, { cutoffTime });
      setEditing(null);
      onToast('截单时间已更新，后续每天沿用');
      await load();
    } catch (err) { setFormError(err.message); }
    finally { setSaving(false); }
  };
  const activeBatch = batches?.find((batch) => batch.status === 'open');
  const dailyTime = activeBatch ? new Date(activeBatch.cutoffTime).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }) : null;

  if (error) return <StateBlock kind="error" message={error.message} onRetry={load} />;
  if (!batches) return <StateBlock kind="loading" message="正在读取批次…" />;

  return (
    <section className="panel config-panel">
      <div className="panel-header"><h2>发售批次</h2>{dailyTime && <span className="batch-schedule">{dailyTime}截单 · 自动续批</span>}</div>
      {batches.length === 0 ? <StateBlock title="还没有批次" message="在下方创建第一个发售批次。" /> : (
        <table className="data-table batches-table">
          <thead><tr><th>批次</th><th>截单 · 北京时间</th><th>状态</th><th /></tr></thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td><b className="cell-strong">{batch.name}</b></td>
                <td className="cell-mono">{formatDateTime(batch.cutoffTime)}</td>
                <td><StatusPill kind={batch.status === 'open' ? 'live' : 'neutral'}>{batch.status === 'open' ? '开放中' : '已截单'}</StatusPill></td>
                <td>
                  {batch.status === 'open' && (
                    <span className="batch-actions"><button className="small-link" onClick={() => edit(batch)}>改时间</button><button className="small-link" disabled={closingId === batch.id} onClick={() => close(batch)}>
                      {closingId === batch.id ? '截单中…' : '截单'}
                    </button></span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* 批次管理已简化：由每日续批自动维护「当前在售批次」，不再手动新建。
          管理员只需要两件事：改一个默认截单时间（只填几点几分）、需要时点「立即截单」。 */}
      {editing && <Modal title="截单时间" onClose={() => !saving && setEditing(null)}>
        <form className="admin-form" onSubmit={saveCutoff}>
          <Field label={`${editing.name} · 截单时间（北京时间，只填几点几分）`}><input type="time" value={editCutoff} onChange={(event) => setEditCutoff(event.target.value)} required /></Field>
          {formError && <p role="alert">{formError}</p>}
          <button className="button primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </form>
      </Modal>}
    </section>
  );
}

/* ---------------- 分享设置 ---------------- */

function SharingTab({ api, onToast }) {
  const [siteUrl, setSiteUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { settings } = await api.get('/api/v1/admin/settings');
      setSiteUrl(settings['share.site_url'] || '');
      setLoadError(null);
    } catch (error) { setLoadError(error); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const save = async (event) => {
    event.preventDefault();
    const value = siteUrl.trim();
    let origin = '';
    if (value) {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
        origin = url.origin;
      } catch { setFormError('请填写完整域名，如 https://crab.example.com，不含路径或参数'); return; }
    }
    setSaving(true);
    setFormError('');
    try {
      await api.put('/api/v1/admin/settings', { 'share.site_url': origin });
      setSiteUrl(origin);
      onToast('分享域名已保存');
    } catch (error) { setFormError(error.message); }
    finally { setSaving(false); }
  };

  if (loading) return <StateBlock kind="loading" message="正在读取分享设置…" />;
  if (loadError) return <StateBlock kind="error" message={loadError.message} onRetry={load} />;
  return <section className="panel config-panel">
    <form className="admin-form" style={{ marginTop: 0 }} onSubmit={save}>
      <Field label="分享域名（留空自动）">
        <input type="url" inputMode="url" value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} placeholder="https://crab.example.com" autoCapitalize="none" autoComplete="url" spellCheck={false} disabled={saving} />
      </Field>
      {formError && <p role="alert">{formError}</p>}
      <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 0 }}>
        <button type="submit" className="button primary" disabled={saving}>{saving ? '保存中…' : '保存'}<Icon name="check" size={16} /></button>
      </div>
    </form>
  </section>;
}

/* ---------------- 公告 ---------------- */

/** ISO（服务端存 UTC）→ datetime-local 输入值，按北京时间 'YYYY-MM-DDTHH:mm'。 */
function isoToLocalInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replace(' ', 'T');
}

/**
 * 公告：读公开接口 GET /api/v1/config/notice，写管理接口 PUT /api/v1/admin/notice。
 * 时间一律「datetime-local 输入（北京时间）↔ ISO 8601（UTC）」转换：
 *   localInputToIso() 补 +08:00 再 toISOString()，isoToLocalInput() 反向格式化。
 */
function NoticeTab({ api, onToast }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [content, setContent] = useState('');
  const [activeFrom, setActiveFrom] = useState('');
  const [activeUntil, setActiveUntil] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { notice } = await api.get('/api/v1/config/notice');
      setContent(notice?.content ?? '');
      setActiveFrom(isoToLocalInput(notice?.activeFrom));
      setActiveUntil(isoToLocalInput(notice?.activeUntil));
      setFormError('');
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const save = async (event) => {
    event.preventDefault();
    const text = content.trim();
    if (!text) { setFormError('请填写公告内容；要撤下公告请点「清空公告」'); return; }
    if (!activeFrom) { setFormError('请选择生效时间'); return; }
    const activeFromIso = localInputToIso(activeFrom);
    if (!activeFromIso) { setFormError('生效时间格式不正确，请重新选择'); return; }
    const activeUntilIso = activeUntil ? localInputToIso(activeUntil) : null;
    if (activeUntil && !activeUntilIso) { setFormError('失效时间格式不正确，请重新选择'); return; }
    if (activeUntilIso && activeUntilIso <= activeFromIso) { setFormError('失效时间必须晚于生效时间；长期有效请留空'); return; }
    setSaving(true);
    setFormError('');
    try {
      await api.put('/api/v1/admin/notice', { content: text, activeFrom: activeFromIso, activeUntil: activeUntilIso });
      onToast('公告已保存');
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  /** 清空 = content 传空串（约定如此），生效 / 失效时间沿用当前表单值。 */
  const clear = async () => {
    if (!window.confirm('确定清空公告吗？清空后前台不再展示这条公告。')) return;
    setClearing(true);
    setFormError('');
    try {
      await api.put('/api/v1/admin/notice', {
        content: '',
        activeFrom: localInputToIso(activeFrom),
        activeUntil: activeUntil ? localInputToIso(activeUntil) : null,
      });
      onToast('公告已清空');
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setClearing(false);
    }
  };

  if (loading) return <StateBlock kind="loading" message="正在读取公告…" />;
  if (loadError) return <StateBlock kind="error" title="公告加载失败" message={loadError.message} onRetry={load} />;

  // 当前表单值在不在「展示中」，省得管理员自己算时间。
  const fromIso = localInputToIso(activeFrom);
  const untilIso = activeUntil ? localInputToIso(activeUntil) : null;
  const nowMs = Date.now();
  const status = !content.trim() || !fromIso
    ? { kind: 'neutral', label: '未设置' }
    : nowMs < Date.parse(fromIso)
      ? { kind: 'warm', label: '未到生效时间' }
      : untilIso && nowMs >= Date.parse(untilIso)
        ? { kind: 'neutral', label: '已失效' }
        : { kind: 'live', label: '展示中' };

  const busy = saving || clearing;

  return (
    <section className="panel config-panel">
      <div className="panel-header">
        <h2>公告</h2>
        <StatusPill kind={status.kind}>{status.label}</StatusPill>
      </div>
      <form className="admin-form notice-form" onSubmit={save}>
        <Field label="公告内容" hint="支持多行；建议一句话说完，前台只展示 10 秒。">
          <textarea rows={4} value={content} onChange={(event) => setContent(event.target.value)} placeholder="例如：今日 17:00 截单，明天清晨捕捞、当天冷链发出。" />
        </Field>
        <div className="notice-time-row">
          <Field label="生效时间（必填）">
            <input type="datetime-local" value={activeFrom} onChange={(event) => setActiveFrom(event.target.value)} required />
          </Field>
          <Field label="失效时间（留空 = 长期有效）">
            <input type="datetime-local" value={activeUntil} onChange={(event) => setActiveUntil(event.target.value)} />
          </Field>
        </div>
        <p className="helper">前台每个用户当天只展示一次，出现 10 秒后自动消失，可手动关闭。</p>
        {formError && <div className="panel-note"><span className="note-mark">!</span><p>{formError}</p></div>}
        <div className="modal-actions notice-actions">
          <button type="button" className="button secondary danger" onClick={clear} disabled={busy}>{clearing ? '清空中…' : '清空公告'}</button>
          <button type="submit" className="button primary" disabled={busy}>{saving ? '保存中…' : '保存公告'} <Icon name="check" size={16} /></button>
        </div>
      </form>
    </section>
  );
}

/**
 * 满减优惠码活动（后台可配置，取代旧的关键词券）。
 *
 * 口径（用户 2026-09-20）：「配置满多少减多少、一共多少张；所有用户共用一个码，
 * 一共用多少次」「点击生效」「取消订单、退款也算用掉了，不退回」「归 0 即结束」。
 *
 * 一屏看懂三件事：① 当前状态 ② 已用 N / 剩余 M ③ 被使用的订单（含已取消）。
 * 「已用张数」直接数订单（含软删的取消单），所以数字与下面列表永远对得上。
 * 接口：GET /api/v1/admin/coupon/orders（coupon 状态 + 使用订单一起返回）、
 *       PUT /api/v1/admin/coupon、POST /api/v1/admin/coupon/toggle。
 */
function CouponTab({ api, onToast }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [coupon, setCoupon] = useState(null);
  const [orders, setOrders] = useState([]);
  const [code, setCode] = useState('');
  const [minYuan, setMinYuan] = useState('');
  const [discountYuan, setDiscountYuan] = useState('');
  const [total, setTotal] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get('/api/v1/admin/coupon/orders');
      setCoupon(data.coupon);
      setOrders(data.orders);
      setCode(data.coupon.code ?? '');
      setMinYuan(centsToYuanInput(data.coupon.minCents));
      setDiscountYuan(centsToYuanInput(data.coupon.discountCents));
      setTotal(String(data.coupon.total ?? 0));
      setFormError('');
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  /** 表单 → 请求体。金额按「元」输入、按「分」提交（本项目金额一律整数分）。 */
  const collect = () => {
    const mins = yuanToCents(minYuan);
    if (mins === null) return { error: '请填写门槛金额（满多少元）' };
    if (mins === undefined) return { error: '门槛金额格式不正确，请输入数字' };
    const discounts = yuanToCents(discountYuan);
    if (discounts === null) return { error: '请填写减免金额（减多少元）' };
    if (discounts === undefined) return { error: '减免金额格式不正确，请输入数字' };
    const text = code.trim();
    const n = Number(String(total).trim());
    if (!Number.isInteger(n) || n < 0) return { error: '总张数必须是不小于 0 的整数' };
    if (text && n < 1) return { error: '总张数必须大于 0（共 N 张 = 总共能用 N 次）' };
    if (text && discounts < 1) return { error: '减免金额必须大于 0' };
    return { payload: { code: text, minCents: mins, discountCents: discounts, total: n, enabled: coupon?.enabled === true } };
  };

  const save = async (event) => {
    event.preventDefault();
    const { error, payload } = collect();
    if (error) { setFormError(error); return; }
    setSaving(true);
    setFormError('');
    try {
      const data = await api.put('/api/v1/admin/coupon', payload);
      setCoupon(data.coupon);
      onToast(payload.code ? '满减活动已保存' : '活动已撤下');
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  /** 「点击生效」/「停用」：只切开关，不动已配好的门槛、面额、张数。 */
  const toggle = async () => {
    setToggling(true);
    setFormError('');
    try {
      const data = await api.post('/api/v1/admin/coupon/toggle', {});
      setCoupon(data.coupon);
      onToast(data.coupon.enabled ? '活动已生效，用户可以用了' : '活动已停用');
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setToggling(false);
    }
  };

  /** 撤下活动 = 活动码置空（门槛/面额/张数原样保留，方便下次原样恢复）。 */
  const withdraw = async () => {
    if (!window.confirm('确定撤下活动吗？撤下后用户立刻不能再使用这个码；已用张数仍然保留。')) return;
    setSaving(true);
    setFormError('');
    try {
      const mins = yuanToCents(minYuan);
      const discounts = yuanToCents(discountYuan);
      const data = await api.put('/api/v1/admin/coupon', {
        code: '',
        minCents: Number.isInteger(mins) && mins >= 0 ? mins : 0,
        discountCents: Number.isInteger(discounts) && discounts >= 0 ? discounts : 0,
        total: Number.isInteger(Number(total)) && Number(total) >= 0 ? Number(total) : 0,
        enabled: false,
      });
      setCoupon(data.coupon);
      onToast('活动已撤下');
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <StateBlock kind="loading" message="正在读取满减活动…" />;
  if (loadError) return <StateBlock kind="error" title="满减活动加载失败" message={loadError.message} onRetry={load} />;

  const status = !coupon?.configured
    ? { kind: 'neutral', label: '未配置' }
    : !coupon.enabled
      ? { kind: 'warm', label: '已配置 · 未生效' }
      : coupon.remaining > 0
        ? { kind: 'live', label: `生效中 · 剩余 ${coupon.remaining} 张` }
        : { kind: 'neutral', label: '已结束（张数归零）' };

  const busy = saving || toggling;
  const used = coupon?.used ?? 0;
  const remainingCount = coupon?.remaining ?? 0;

  return (
    <div className="coupon-stack">
      <section className="panel config-panel">
        <div className="panel-header">
          <h2>满减优惠码</h2>
          <StatusPill kind={status.kind}>{status.label}</StatusPill>
        </div>
        <form className="admin-form coupon-form" onSubmit={save}>
          <Field label="活动码" hint="一个活动码所有用户共用。留空保存 = 撤下活动。">
            <input
              type="text"
              value={code}
              maxLength={32}
              autoComplete="off"
              onChange={(event) => setCode(event.target.value)}
              placeholder="例如：满300减10"
            />
          </Field>
          <div className="coupon-grid">
            <Field label="门槛（满多少元）" hint="按蟹款算，不含包装费、运费。">
              <input type="text" inputMode="decimal" value={minYuan} onChange={(event) => setMinYuan(event.target.value)} placeholder="300" />
            </Field>
            <Field label="减免（减多少元）">
              <input type="text" inputMode="decimal" value={discountYuan} onChange={(event) => setDiscountYuan(event.target.value)} placeholder="10" />
            </Field>
            <Field label="总张数" hint="总共能用多少次，用满自动结束。">
              <input type="number" min="0" step="1" value={total} onChange={(event) => setTotal(event.target.value)} placeholder="100" />
            </Field>
          </div>
          <p className="helper">
            已用 <b>{used}</b> 张 / 剩余 <b>{remainingCount}</b> 张（共 {coupon?.total ?? 0} 张）。
            取消、退款的订单也算用掉，不退回。
          </p>
          {formError && <div className="panel-note"><span className="note-mark">!</span><p>{formError}</p></div>}
          <div className="modal-actions coupon-actions">
            <button type="button" className="button secondary danger" onClick={withdraw} disabled={busy}>撤下活动</button>
            <button type="button" className="button secondary" onClick={toggle} disabled={busy || !coupon?.configured}>{toggling ? '处理中…' : coupon?.enabled ? '停用活动' : '点击生效'}</button>
            <button type="submit" className="button primary" disabled={busy}>{saving ? '保存中…' : '保存配置'} <Icon name="check" size={16} /></button>
          </div>
        </form>
      </section>

      <section className="panel config-panel">
        <div className="panel-header">
          <h2>使用订单</h2>
          <span className="helper">共 {orders.length} 单（含已取消，取消也算用掉）</span>
        </div>
        {orders.length === 0
          ? <StateBlock message="还没有订单使用这个活动码。" />
          : (
            <table className="data-table coupon-orders-table">
              <thead><tr><th>订单号</th><th>下单人</th><th>蟹款</th><th>立减</th><th>下单时间</th><th>状态</th></tr></thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className={order.cancelled ? 'is-cancelled' : ''}>
                    <td>{order.orderNo}</td>
                    <td>{order.userDisplayName || order.userOrderCode || '—'}</td>
                    <td>{formatCents(order.crabCents)}</td>
                    <td>{formatCents(order.discountCents)}</td>
                    <td>{formatDateTime(order.createdAt)}</td>
                    <td>{order.cancelled ? '已取消（不退回名额）' : '有效'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>
    </div>
  );
}

/* ---------------- 配置页骨架 ---------------- */

export default function ConfigPage({ api, onToast }) {
  const [tab, setTab] = useState('specs');

  return (
    <div className="page-wrap">
      <div className="order-toolbar">
        <div className="order-tabs">
          {TABS.map(([key, label]) => (
            <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
      </div>
      {tab === 'specs' && <SpecsTab api={api} onToast={onToast} />}
      {tab === 'templates' && <TemplatesTab api={api} onToast={onToast} />}
      {tab === 'packaging' && <PackagingTab api={api} onToast={onToast} />}
      {tab === 'coupon' && <CouponTab api={api} onToast={onToast} />}
      {tab === 'batches' && <BatchesTab api={api} onToast={onToast} />}
      {tab === 'sharing' && <SharingTab api={api} onToast={onToast} />}
      {tab === 'notice' && <NoticeTab api={api} onToast={onToast} />}
    </div>
  );
}
