-- 01007 Orders O11: every print of an order receipt, repair receipt, vendor issue slip and advance receipt is logged.
-- Print 1 is the ORIGINAL; later prints are DUPLICATE and carry a reason (3-200 characters). Written only by orders_writer.
CREATE TABLE orders.document_print (
  tenant_id uuid NOT NULL REFERENCES platform.tenant(id),
  id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL,
  doc_type text NOT NULL CONSTRAINT document_print_doc_type_check
    CHECK (doc_type IN ('order_receipt','repair_receipt','order_vendor_slip','repair_vendor_slip','advance_receipt')),
  doc_id uuid NOT NULL,                       -- the order, the repair or the advance
  line_id uuid,                               -- vendor slips: the order line / repair line
  print_no int NOT NULL CONSTRAINT document_print_print_no_check CHECK (print_no >= 1),
  copy text NOT NULL CONSTRAINT document_print_copy_check CHECK (copy IN ('original','duplicate')),
  paper text NOT NULL CONSTRAINT document_print_paper_check CHECK (paper IN ('A4','A5','thermal_80mm')),
  reprint_reason text,
  printed_by uuid NOT NULL,
  printed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_print_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT document_print_original_check CHECK ((print_no = 1) = (copy = 'original')),
  CONSTRAINT document_print_reason_check CHECK (copy = 'original' OR length(trim(coalesce(reprint_reason, ''))) BETWEEN 3 AND 200),
  CONSTRAINT document_print_line_check CHECK ((doc_type IN ('order_vendor_slip','repair_vendor_slip')) = (line_id IS NOT NULL)),
  CONSTRAINT document_print_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  CONSTRAINT document_print_printed_by_fk FOREIGN KEY (tenant_id, printed_by) REFERENCES platform.app_user(tenant_id, id)
);
CREATE UNIQUE INDEX document_print_no_uq ON orders.document_print (tenant_id, doc_type, doc_id, coalesce(line_id, '00000000-0000-0000-0000-000000000000'::uuid), print_no);
SELECT platform.enable_audit('orders.document_print');
ALTER TABLE orders.document_print ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders.document_print FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders.document_print USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());
CREATE POLICY no_partner_access ON orders.document_print AS RESTRICTIVE USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL);
REVOKE ALL ON orders.document_print FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT ON orders.document_print TO app_rw, app_ro;
GRANT SELECT, INSERT ON orders.document_print TO orders_writer;    -- a print is never changed or removed
