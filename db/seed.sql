-- seed.sql — Phase 3 seed data for MileagePlus Deal Finder
-- Replaces hardcoded fixture data in the Julia engine.
-- Must be idempotent (INSERT OR IGNORE / INSERT OR REPLACE).

-- Scrape snapshot
INSERT OR IGNORE INTO scrape_snapshots (snapshot_id, started_at, completed_at, retailer_count, error_count, status)
VALUES ('seed-snapshot-001', '2026-03-24T10:00:00', '2026-03-24T10:05:00', 3, 0, 'complete');

-- Retailers
INSERT OR REPLACE INTO retailers (retailer_id, name, portal_url, tax_included, shipping_included, gc_portal_eligible, gc_portal_source)
VALUES
  (1, 'BestBuy', 'https://shopping.mileageplus.com/bestbuy', 0, 0, 0, NULL),
  (2, 'Nike', 'https://shopping.mileageplus.com/nike', 0, 0, 0, NULL),
  (3, 'Walmart', 'https://shopping.mileageplus.com/walmart', 0, 0, 1, NULL);

-- Retailer rates (snapshot-scoped)
INSERT OR IGNORE INTO retailer_rates (retailer_id, snapshot_id, base_rate, rate_type, category_rates, scraped_at)
VALUES
  (1, 'seed-snapshot-001', 2.0, 'miles_per_dollar', NULL, '2026-03-24T10:00:00'),
  (2, 'seed-snapshot-001', 3.0, 'miles_per_dollar', NULL, '2026-03-24T10:00:00'),
  (3, 'seed-snapshot-001', 1.5, 'miles_per_dollar', NULL, '2026-03-24T10:00:00');

-- MPX rates (snapshot-scoped)
INSERT OR IGNORE INTO mpx_rates (retailer_id, snapshot_id, mpx_rate, chase_bonus, scraped_at)
VALUES
  (1, 'seed-snapshot-001', 2.0, 0.25, '2026-03-24T10:00:00'),
  (2, 'seed-snapshot-001', 3.0, 0.25, '2026-03-24T10:00:00'),
  (3, 'seed-snapshot-001', 1.5, 0.25, '2026-03-24T10:00:00');

-- Bonus offers (snapshot-scoped)
-- BestBuy: flat_tiered bonus
INSERT OR IGNORE INTO bonus_offers (retailer_id, snapshot_id, bonus_type, config_json, active_from, active_until, raw_text, parsed_at)
VALUES
  (1, 'seed-snapshot-001', 'flat_tiered',
   '{"tiers":[[100.0,500.0]],"cumulative":true,"once_per_member":false,"new_customer_only":false,"min_order_value":100.0,"excluded_payment_types":[],"category_restrictions":null}',
   '2026-03-01', '2026-04-30',
   'Earn 500 bonus miles when you spend $100 or more at BestBuy.com. Offer valid on qualifying purchases only. Gift cards excluded.',
   '2026-03-24T10:00:00');

-- Nike: per_order_flat bonus
INSERT OR IGNORE INTO bonus_offers (retailer_id, snapshot_id, bonus_type, config_json, active_from, active_until, raw_text, parsed_at)
VALUES
  (2, 'seed-snapshot-001', 'per_order_flat',
   '{"miles":250.0,"min_order_value":75.0,"once_per_member":false,"excluded_payment_types":[]}',
   '2026-03-01', '2026-04-30',
   'Earn 250 bonus miles on qualifying orders of $75 or more at Nike.com.',
   '2026-03-24T10:00:00');

-- T&C rules (snapshot-scoped)
INSERT OR IGNORE INTO tc_rules (retailer_id, snapshot_id, inclusions, exclusions, raw_text, confidence, parsed_at)
VALUES
  (1, 'seed-snapshot-001', 'Electronics,Computers,Appliances', 'Gift Cards,Services',
   'Earn miles on electronics, computers, tablets, and appliances purchased at BestBuy.com. Gift cards, services, warranties, and delivery fees are not eligible for mile earning. Miles are earned on the purchase price excluding taxes and shipping.',
   0.95, '2026-03-24T10:00:00'),
  (2, 'seed-snapshot-001', 'Clothing,Footwear,Accessories', 'Gift Cards',
   'Earn miles on clothing, footwear, and accessories at Nike.com. Gift cards and Nike gift certificates are excluded. Customized products (NIKEiD) are excluded. Taxes, shipping charges, and returns are not eligible.',
   0.98, '2026-03-24T10:00:00'),
  (3, 'seed-snapshot-001', 'General Merchandise,Grocery', 'Gift Cards,Pharmacy,Tobacco',
   'Earn miles on general merchandise and grocery purchases at Walmart.com. Gift cards, pharmacy purchases, tobacco, alcohol, and firearms are excluded. Purchases paid with Walmart gift cards are eligible for portal mile earning.',
   0.90, '2026-03-24T10:00:00');

-- Process constraints (not snapshot-scoped)
INSERT OR IGNORE INTO process_constraints (retailer_id, constraint_type, severity, description, source)
VALUES
  (1, 'coupon_restriction', 'warning',
   'Using coupon codes not listed on the MileagePlus Shopping portal may void portal miles.',
   'MileagePlus Shopping FAQ'),
  (1, 'last_click', 'warning',
   'Final click before checkout must originate from MileagePlus Shopping portal.',
   'MileagePlus Shopping FAQ');
