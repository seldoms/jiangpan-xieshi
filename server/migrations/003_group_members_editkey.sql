-- 拼团成员编辑凭据：成员提交后服务端签发，修改/删除本人记录时凭 X-Edit-Key 校验
ALTER TABLE group_members ADD COLUMN edit_key TEXT;
