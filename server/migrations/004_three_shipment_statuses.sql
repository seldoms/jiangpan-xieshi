-- 履约只保留捕捞、打包、已发货三层。
-- 旧版本若已有“配送中”记录：已经有运费的视为已发货，尚未登记运费的退回已打包，等待本次提交运费后发货。
DROP INDEX IF EXISTS idx_shipments_order_id;
DROP INDEX IF EXISTS idx_shipments_status;

ALTER TABLE shipments RENAME TO shipments_legacy;

CREATE TABLE shipments (
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
  status TEXT NOT NULL DEFAULT 'fishing' CHECK (status IN ('fishing', 'packed', 'shipped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id, seq)
);

INSERT INTO shipments (
  id, order_id, seq, recipient, phone, address, copies, packaging, items_json,
  crab_cents, packaging_cents, actual_weight_grams, freight_cents, status,
  created_at, updated_at
)
SELECT
  id, order_id, seq, recipient, phone, address, copies, packaging, items_json,
  crab_cents, packaging_cents, actual_weight_grams, freight_cents,
  CASE
    WHEN status = 'delivering' AND freight_cents IS NOT NULL THEN 'shipped'
    WHEN status = 'delivering' THEN 'packed'
    ELSE status
  END,
  created_at, updated_at
FROM shipments_legacy;

DROP TABLE shipments_legacy;

CREATE INDEX idx_shipments_order_id ON shipments(order_id);
CREATE INDEX idx_shipments_status ON shipments(status);
