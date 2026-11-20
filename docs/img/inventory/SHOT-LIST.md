# Inventory screenshot shot-list

Use demo shop `demo-cbe-sri-valli`, branch RS Puram (CBE) unless noted. Mask mobile numbers. No passwords or IPs in any shot. Capture page content only (no address bar or taskbar), 1366 px wide.

| # | Filename | Page path | What the shot must show | Status (9 Nov 2026) |
|---|---|---|---|---|
| 1 | inventory-stock-list.png | /inventory | Stock page: summary strip, Search/Status/Item/Counter boxes, list with tag no, weights, HUID, place, status | Done (seeded stock) |
| 2 | inventory-stock-status-filter.png | /inventory | Stock list with Status = In stock (default), seeded rows, summary strip | Done (0.8.9: 9 tags, summary shows 12 pieces) |
| 3 | inventory-piece-details.png | /inventory/pieces/{id} | Piece details for one ring: weights, place, Change status, History list | Done (0.8.9: Making charge, Labels printed, Last label printed) |
| 4 | inventory-tag-one.png | /inventory/tag | One piece form filled (RS Puram, Ring, 22K, weights, HUID), before saving | OK as is (bangle) |
| 5 | inventory-labels-picked.png | /inventory/labels | Two pieces picked, Label size and Copies visible | Done (2 picked) |
| 6 | inventory-labels-preview.png | /inventory/labels | Label preview after Get labels: tag no, barcode, GW, NW; Print {n} labels button | Done (0.8.9) |
| 7 | inventory-transfer-send.png | /inventory/transfers | Send tab: From RS Puram, To Gandhipuram, 2–3 pieces scanned, Send {n} pieces | Done (2 pieces, not sent) |
| 8 | inventory-transfer-receive.png | /inventory/transfers | Coming in tab (at Gandhipuram): Tick the pieces that arrived, Confirm {n} received | Retake: needs a sent, not-yet-received transfer (UM's call) |
| 9 | inventory-check-start.png | /inventory/stock-check | Branch/Counter chosen, Start check, Checks already running list | Done |
| 10 | inventory-check-scanning.png | /inventory/stock-check | Check in progress: progress line, Not scanned yet tab with one piece | Done (2 of 9 found) |
| 11 | inventory-adjustment-new.png | /inventory/adjustments | New adjustment: A tagged piece, Weight loss, Polishing, weight, reason | OK as is (loose stock) |
| 12 | inventory-adjustment-queue.png | /inventory/adjustments | Approval queue with one Waiting request, Approve/Reject visible | Retake: needs a pending adjustment (UM's call) |
| 13 | inventory-valuation.png | /inventory/valuation | Stock value grouped by Purity: rate/g, Metal value, Total value, Included/Not included line | Done for ₹0.00 WARNING (0.8.9); optional second shot once today's rates are published |
