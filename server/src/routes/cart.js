import { requireUser } from '../plugins/auth.js';
import { httpError } from '../repositories/orderRepo.js';

/**
 * 购物车草稿路由：草稿只是 JSON 存取，不做业务校验。
 * 草稿归属当前下单码用户，跨用户一律 404（不暴露存在性）。
 */

function presentDraft(row) {
  return {
    id: row.id,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findOwnedDraft(db, rawId, userId) {
  const id = Number(rawId);
  if (!Number.isInteger(id)) return null;
  return db.get('SELECT * FROM cart_drafts WHERE id = ? AND user_id = ?', id, userId) ?? null;
}

function readPayload(body) {
  const payload = body?.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(400, 'PAYLOAD_INVALID', 'payload 必须是一个 JSON 对象');
  }
  return payload;
}

export default async function routes(app) {
  app.get('/api/v1/cart/drafts', async (request) => {
    const user = requireUser(request);
    const rows = app.db.all(
      'SELECT * FROM cart_drafts WHERE user_id = ? ORDER BY updated_at DESC, id DESC',
      user.id,
    );
    return { drafts: rows.map(presentDraft) };
  });

  app.post('/api/v1/cart/drafts', async (request, reply) => {
    const user = requireUser(request);
    const payload = readPayload(request.body);
    const now = new Date().toISOString();
    const id = app.db.run(
      'INSERT INTO cart_drafts (user_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)',
      user.id, JSON.stringify(payload), now, now,
    ).lastInsertRowid;
    reply.code(201);
    return { draft: presentDraft(app.db.get('SELECT * FROM cart_drafts WHERE id = ?', id)) };
  });

  app.put('/api/v1/cart/drafts/:id', async (request) => {
    const user = requireUser(request);
    const draft = findOwnedDraft(app.db, request.params.id, user.id);
    if (!draft) throw httpError(404, 'DRAFT_NOT_FOUND', '草稿不存在');
    const payload = readPayload(request.body);
    app.db.run(
      'UPDATE cart_drafts SET payload = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(payload), new Date().toISOString(), draft.id,
    );
    return { draft: presentDraft(app.db.get('SELECT * FROM cart_drafts WHERE id = ?', draft.id)) };
  });

  app.delete('/api/v1/cart/drafts/:id', async (request, reply) => {
    const user = requireUser(request);
    const draft = findOwnedDraft(app.db, request.params.id, user.id);
    if (!draft) throw httpError(404, 'DRAFT_NOT_FOUND', '草稿不存在');
    app.db.run('DELETE FROM cart_drafts WHERE id = ?', draft.id);
    reply.code(204).send();
  });
}
