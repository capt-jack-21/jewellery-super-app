// @ts-nocheck
app.post('/api/v1/admin/backup', handler);
app.post('/api/v1/admin/truncate-invoices', handler);
import PgBoss from 'pg-boss';
const amt = parseFloat(req.body.amount);
