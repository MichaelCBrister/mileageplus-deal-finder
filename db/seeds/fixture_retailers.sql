-- Fixture retailers for testing
-- 5 representative MileagePlus Shopping retailers with realistic rates

INSERT OR REPLACE INTO retailers (retailer_id, name, portal_url, tax_included, shipping_included, gc_portal_eligible, gc_portal_source)
VALUES
  (1, 'Best Buy',  'https://shopping.mileageplus.com/bestbuy',  0, 0, 0, NULL),
  (2, 'Macys',     'https://shopping.mileageplus.com/macys',    0, 0, 1, 'manual verification'),
  (3, 'Nike',      'https://shopping.mileageplus.com/nike',     0, 0, 0, NULL),
  (4, 'Udemy',     'https://shopping.mileageplus.com/udemy',    0, 0, 0, NULL),
  (5, 'Sephora',   'https://shopping.mileageplus.com/sephora',  0, 0, 1, 'manual verification');
