PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  order_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  cutoff_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS specs (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER REFERENCES batches(id),
  gender TEXT NOT NULL CHECK (gender IN ('male', 'female')),
  weight_label TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS package_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  packaging TEXT NOT NULL CHECK (packaging IN ('plain', 'gift')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS package_template_items (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES package_templates(id),
  spec_id INTEGER NOT NULL REFERENCES specs(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  UNIQUE (template_id, spec_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL,
  order_no TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('personal', 'group')),
  status TEXT NOT NULL DEFAULT 'submitted',
  crab_cents INTEGER NOT NULL CHECK (crab_cents >= 0),
  packaging_cents INTEGER NOT NULL DEFAULT 0 CHECK (packaging_cents >= 0),
  freight_cents INTEGER,
  total_cents INTEGER,
  config_snapshot TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, seq)
);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  seq INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  copies INTEGER NOT NULL CHECK (copies > 0),
  packaging TEXT NOT NULL CHECK (packaging IN ('plain', 'gift')),
  items_json TEXT NOT NULL,
  crab_cents INTEGER NOT NULL CHECK (crab_cents >= 0),
  packaging_cents INTEGER NOT NULL DEFAULT 0 CHECK (packaging_cents >= 0),
  actual_weight_grams INTEGER,
  freight_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'fishing' CHECK (status IN ('fishing', 'packed', 'delivering', 'shipped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id, seq)
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  leader_user_id INTEGER NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'closed', 'cancelled')),
  address_recipient TEXT,
  address_phone TEXT,
  address TEXT,
  submitted_order_id INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL,
  spec_id INTEGER NOT NULL REFERENCES specs(id),
  spec_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  actual_weight_grams INTEGER,
  freight_share_cents INTEGER,
  freight_adjusted INTEGER NOT NULL DEFAULT 0,
  adjust_reason TEXT,
  submitted_order INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_drafts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'user', 'system')),
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_batch_status ON orders(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_groups_batch_id ON groups(batch_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_cart_drafts_user_id ON cart_drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_package_template_items_template_id ON package_template_items(template_id);
CREATE INDEX IF NOT EXISTS idx_specs_batch_id ON specs(batch_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);
