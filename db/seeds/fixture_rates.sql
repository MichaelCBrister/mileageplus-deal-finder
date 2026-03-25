-- Fixture rates for testing
-- Complete snapshot with base rates and MPX rates for all 5 retailers

-- Create the seed snapshot
INSERT OR REPLACE INTO scrape_snapshots (snapshot_id, started_at, completed_at, retailer_count, error_count, status)
VALUES ('seed-snapshot-001', '2026-03-24T00:00:00Z', '2026-03-24T00:05:00Z', 5, 0, 'complete');

-- Base rates for all 5 retailers
INSERT OR REPLACE INTO retailer_rates (rate_id, retailer_id, snapshot_id, base_rate, rate_type, category_rates, scraped_at)
VALUES
  (1, 1, 'seed-snapshot-001', 1.0, 'per_dollar', NULL, '2026-03-24T00:01:00Z'),
  (2, 2, 'seed-snapshot-001', 5.0, 'per_dollar', NULL, '2026-03-24T00:02:00Z'),
  (3, 3, 'seed-snapshot-001', 3.0, 'per_dollar', NULL, '2026-03-24T00:03:00Z'),
  (4, 4, 'seed-snapshot-001', 8.0, 'per_dollar', NULL, '2026-03-24T00:04:00Z'),
  (5, 5, 'seed-snapshot-001', 4.0, 'per_dollar', NULL, '2026-03-24T00:05:00Z');

-- MPX rates for retailers that have MPX gift cards (Best Buy, Macy's, Nike, Sephora)
-- Udemy has no MPX gift card option
INSERT OR REPLACE INTO mpx_rates (mpx_rate_id, retailer_id, snapshot_id, mpx_rate, chase_bonus, scraped_at)
VALUES
  (1, 1, 'seed-snapshot-001', 2.0, 0.25, '2026-03-24T00:01:00Z'),
  (2, 2, 'seed-snapshot-001', 3.0, 0.25, '2026-03-24T00:02:00Z'),
  (3, 3, 'seed-snapshot-001', 2.0, 0.25, '2026-03-24T00:03:00Z'),
  (4, 5, 'seed-snapshot-001', 3.0, 0.25, '2026-03-24T00:05:00Z');
