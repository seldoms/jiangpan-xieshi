-- 团购软删除：团长撤销拼团时保留全部数据，仅从「我的团购」列表和公开页隐去。
-- 与 users / orders 的软删除口径一致（都用 deleted_at 标记，不物理删除）。
ALTER TABLE groups ADD COLUMN deleted_at TEXT;
