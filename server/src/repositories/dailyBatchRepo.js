const DAY_MS = 86_400_000;
const CHINA_OFFSET_MS = 8 * 3_600_000;

export function deliveryDate(cutoffTime) {
  return new Date(new Date(cutoffTime).getTime() + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

/** 自动批次沿用原规格 ID，已有购物车、套餐和历史快照不会因此失效。 */
export function catalogBatchIds(db, batchId) {
  const stored = db.get('SELECT value FROM settings WHERE key = ?', `batch.${batchId}.catalog_batches`);
  const inherited = stored ? JSON.parse(stored.value) : [];
  // 早期预建批次没有目录关联，后来续批可能把它继承成 []。
  // 只有完全没有自身规格和继承目录时才向过去找；停用自身规格不代表空目录。
  if (inherited.length === 0 && !db.get('SELECT id FROM specs WHERE batch_id = ? LIMIT 1', batchId)) {
    const previous = db.get(`SELECT earlier.id FROM batches earlier JOIN batches current ON current.id = ?
      WHERE julianday(earlier.cutoff_time) < julianday(current.cutoff_time)
      ORDER BY julianday(earlier.cutoff_time) DESC, earlier.id DESC LIMIT 1`, batchId);
    if (previous) return [...new Set([batchId, ...catalogBatchIds(db, previous.id)])];
  }
  return [...new Set([batchId, ...inherited])];
}

export function inheritBatchCatalog(db, fromBatchId, toBatchId) {
  const sourceIds = catalogBatchIds(db, fromBatchId).filter((sourceId) =>
    db.get('SELECT id FROM specs WHERE batch_id = ? LIMIT 1', sourceId));
  db.run('INSERT INTO settings (key, value) VALUES (?, ?)', `batch.${toBatchId}.catalog_batches`, JSON.stringify(sourceIds));
}

function nextCutoff(source, nowMs) {
  const previousCutoff = new Date(source.cutoff_time).getTime();
  const days = Math.max(1, Math.floor((nowMs - previousCutoff) / DAY_MS) + 1);
  return new Date(previousCutoff + days * DAY_MS).toISOString();
}

/** 定时和请求共用的幂等事务；未来预建批次不能让每日发布跳过中间日期。 */
export function ensureDailyBatch(db, now = new Date()) {
  return db.tx(() => {
    const batches = db.all('SELECT * FROM batches ORDER BY julianday(cutoff_time), id');
    if (batches.length === 0) return null; // 首次发售由管理员建立。
    const nowMs = now.getTime();
    let lastExpired = null;
    let firstFuture = null;
    for (const batch of batches) {
      if (new Date(batch.cutoff_time).getTime() <= nowMs) {
        lastExpired = batch;
        if (batch.status === 'open') {
          db.run("UPDATE batches SET status = 'closed' WHERE id = ?", batch.id);
          batch.status = 'closed';
        }
      } else if (!firstFuture) {
        firstFuture = batch;
      }
    }

    let source = lastExpired;
    // 没有历史发售时尊重管理员首批日期；已经发售则逐日续批。
    // 同配送日管理员可能延后截单，仍优先保留这个尚未截单的批次。
    if (firstFuture && (!source || deliveryDate(firstFuture.cutoff_time) <= deliveryDate(nextCutoff(source, nowMs)))) {
      if (firstFuture.status === 'open') return firstFuture;
      source = firstFuture;
    }

    let cutoffTime = nextCutoff(source, nowMs);
    for (;;) {
      const existing = batches.find((batch) => deliveryDate(batch.cutoff_time) === deliveryDate(cutoffTime));
      if (!existing) break;
      if (existing.status === 'open' && new Date(existing.cutoff_time).getTime() > nowMs) return existing;
      // 明确提前关闭的日期保持关闭，但不影响更早日期的正常发布。
      source = existing;
      cutoffTime = nextCutoff(source, nowMs);
    }
    const baseName = `${deliveryDate(cutoffTime)} 鲜蟹`;
    let name = baseName;
    for (let suffix = 2; db.get('SELECT id FROM batches WHERE name = ?', name); suffix += 1) {
      name = `${baseName} ${suffix}`;
    }
    const result = db.run(
      "INSERT INTO batches (name, cutoff_time, status, created_at) VALUES (?, ?, 'open', ?)",
      name, cutoffTime, now.toISOString(),
    );
    const id = Number(result.lastInsertRowid);
    inheritBatchCatalog(db, source.id, id);
    return db.get('SELECT * FROM batches WHERE id = ?', id);
  }).immediate();
}
