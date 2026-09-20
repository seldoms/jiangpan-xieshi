-- 优惠券（硬编码在代码里，不做后台配置 —— 用户明确要求）
--
-- 订单上记下「减了多少」与「用了哪张券」，用于：
--   ① 订单/成功页如实展示优惠额（total_cents 已扣减）
--   ② 「每人每天限一次」的判定（按下单码 user_id + 收货手机号双维度查当天是否已用券）
--
-- 金额一律整数分（cents），是本项目的铁律。
-- discount_cents 只增不减地记在订单上，历史订单（含本迁移之前）一律为 0 / NULL，不受影响。
ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;

-- 券关键词原文（如「自己吃」）；NULL = 没用券。
ALTER TABLE orders ADD COLUMN coupon_code TEXT;

-- 支持「当天是否已用券」的查询：按用户筛当天，再按券码非空过滤。
CREATE INDEX IF NOT EXISTS idx_orders_coupon_code ON orders (coupon_code, created_at);
