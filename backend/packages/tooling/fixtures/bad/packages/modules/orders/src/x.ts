await c.query("SET LOCAL ROLE sales_writer"); await c.query("INSERT INTO sales.invoice VALUES (1)");
await c.query("UPDATE inventory.tag SET status = 'sold'"); await c.query("INSERT INTO inventory.stock_ledger VALUES (1)");
