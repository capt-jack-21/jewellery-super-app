# Inventory freeze (I1–I18)

Source: the feature-freeze page the team kept (the "Inventory" section, captioned "Frozen 28 Oct 2026 as listed: 12 must-have, 5 later, I18 moves to Approvals"). There was no separate freeze file in the repo, so this was copied word for word from that page. The note at the bottom comes from the team's memory log.

| # | Feature | What it means | Status |
|---|---|---|---|
| I1 | Tagged pieces | Every piece gets its own tag number with gross, net and stone weight, purity, design, stones, making, wastage and HSN | Must-have |
| I2 | Barcode and QR labels | Print small tag labels for each piece to scan at the counter | Must-have |
| I3 | Bulk tagging from a purchase | Tag a whole purchase or lot in one go instead of one by one | Must-have |
| I4 | Loose stock by weight | Untagged stock such as silver articles or chains, kept by total weight | Must-have |
| I5 | Stock by branch, counter and tray | See exactly where every piece sits | Must-have |
| I6 | Branch transfers | Send stock to another branch; it shows as in transit until received | Must-have |
| I7 | Counter and tray moves | Move pieces between counters or trays inside a branch | Must-have |
| I8 | Stock check by scanning | Scan trays daily and get a list of missing or extra pieces | Must-have |
| I9 | Stock status | Each piece shows available, reserved, sold, on approval, or sent for repair or melting | Must-have |
| I10 | Weight loss and adjustments | Record weight changes with a reason; needs an approval | Must-have |
| I11 | Stock value at today's rate | Total value of stock using today's metal rates | Must-have |
| I12 | Opening stock import | Load existing stock from Excel or CSV when the shop starts | Must-have |
| I13 | Re-tagging, split and merge | Change a tag, or split or combine pieces | Later |
| I14 | Ageing and slow-moving report | Pieces that have sat unsold for a long time | Later |
| I15 | Photos per piece | Own photo for each tagged piece; design photos are used until then | Later |
| I16 | RFID tags | Count trays with an RFID reader instead of scanning one by one | Later |
| I17 | Low-stock alerts | Warn when a category or design runs low | Later |
| I18 | Pieces sent on approval | Pieces given to customers to try at home; better handled in Approvals | Dropped (moves to Approvals) |

**Scope change recorded on 5 Nov 2026 (memory log, not on the freeze page):** per-piece photos (I15) and the ageing report (I14) were pulled into the Inventory build as optional per-shop toggles. Tag numbers are auto-generated in a format each shop can set. Adjustments are approved by the owner or a manager, and a shop can limit that to the owner only. Transfers stay in transit until the receiving branch confirms. The backend source (f32faa2) confirms both are there: `GET /v1/inventory/reports/ageing` with the `ageing_enabled` / `ageing_bucket_days` settings, and `POST /v1/inventory/tags/{id}/photos` with the `photos_enabled` setting. That leaves I13, I16 and I17 as the real "later" items.

Note: the QA checklist also uses IDs "INV-I13" to "INV-I18". Those are database invariant tests for Sales invoices, **not** these Inventory freeze items.
