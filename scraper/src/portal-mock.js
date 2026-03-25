// portal-mock.js — Mock portal data for testing the scraper pipeline
// Phase 6: Returns hardcoded retailer data matching seed format when live portal
// access is not available. Allows end-to-end testing of snapshot creation, DB writes,
// parser chaining, and audit log writing.

/**
 * Returns mock retailer data matching the 3 seed retailers.
 * Each retailer has realistic fields that exercise all scraper code paths.
 * @returns {Array<object>}
 */
function getMockRetailers() {
  return [
    {
      name: 'BestBuy',
      base_rate: 2.0,
      rate_type: 'miles per dollar',
      bonus_text: 'Earn 500 bonus miles when you spend $100 or more at BestBuy.com. Offer valid on qualifying purchases only. Gift cards excluded.',
      tc_text: 'Earn miles on electronics, computers, tablets, and appliances purchased at BestBuy.com. Gift cards, services, warranties, and delivery fees are not eligible for mile earning. Miles are earned on the purchase price excluding taxes and shipping.',
      portal_url: 'https://shopping.mileageplus.com/b?XID=1&retailer=bestbuy',
      mpx_rate: 2.0,
    },
    {
      name: 'Nike',
      base_rate: 3.0,
      rate_type: 'miles per dollar',
      bonus_text: 'Earn 250 bonus miles on qualifying orders of $75 or more at Nike.com.',
      tc_text: 'Earn miles on clothing, footwear, and accessories at Nike.com. Gift cards and Nike gift certificates are excluded. Customized products (NIKEiD) are excluded. Taxes, shipping charges, and returns are not eligible.',
      portal_url: 'https://shopping.mileageplus.com/b?XID=2&retailer=nike',
      mpx_rate: 3.0,
    },
    {
      name: 'Walmart',
      base_rate: 1.5,
      rate_type: 'miles per dollar',
      bonus_text: null, // No active bonus
      tc_text: 'Earn miles on general merchandise and grocery purchases at Walmart.com. Gift cards, pharmacy purchases, tobacco, alcohol, and firearms are excluded. Purchases paid with Walmart gift cards are eligible for portal mile earning.',
      portal_url: 'https://shopping.mileageplus.com/b?XID=3&retailer=walmart',
      mpx_rate: 1.5,
    },
  ];
}

module.exports = { getMockRetailers };
