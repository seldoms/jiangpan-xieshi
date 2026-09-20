import { useState } from 'react';
import { Field, Icon, Modal } from './ui.jsx';
import { centsToYuanInput, yuanToCents } from './format.js';

/** 逐地址登记快递费；拼团由服务端按订单中的规格重量自动分摊。 */
export default function FreightModal({ api, shipment, onClose, onSaved }) {
  const [freightYuan, setFreightYuan] = useState(() => centsToYuanInput(shipment.freightCents));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const isGroup = shipment.source === 'group';

  const submit = async (event) => {
    event.preventDefault();
    if (submitting) return;
    const freightCents = yuanToCents(freightYuan);
    if (freightCents === null || freightCents === undefined) {
      setError('请填写快递费，免运费填 0');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await api.post(`/api/v1/admin/shipments/${shipment.id}/freight`,
        isGroup ? { totalFreightCents: freightCents } : { freightCents });
      onSaved();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <Modal title={shipment.status === 'packed' ? '登记快递费' : '修改快递费'} onClose={() => !submitting && onClose()}>
      <form className="admin-form" onSubmit={submit}>
        <p>{shipment.recipient} · {shipment.address}</p>
        <Field label={isGroup ? '拼团总运费（元）' : '快递费（元）'}>
          <input autoFocus inputMode="decimal" value={freightYuan} onChange={(event) => setFreightYuan(event.target.value)} placeholder="免运费填 0" disabled={submitting} />
        </Field>
        {error && <p role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={submitting}>取消</button>
          <button type="submit" className="button primary" disabled={submitting}>
            {submitting ? '提交中…' : shipment.status === 'packed' ? '提交快递费并发货' : '保存运费修改'}<Icon name="check" size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
