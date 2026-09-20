-- 用户软删除与登录记录：删除的账号保留数据，但从所有页面消失（软删同时软删其订单）。
ALTER TABLE users ADD COLUMN deleted_at TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
