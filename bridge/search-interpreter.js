// search-interpreter.js — Claude API query interpretation for /api/search
// Phase 11: Interprets search queries into category, price, retailers, and query_type.
// Uses claude-sonnet-4-20250514 with max_tokens 512 (cheap — ~$0.002 per call).

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 512;

const SEARCH_SYSTEM_PROMPT = `You are a shopping query interpreter for the MileagePlus Shopping portal. Given a search query, return a JSON object with exactly these fields:
- "interpreted_category": the most relevant MileagePlus Shopping category as a string (e.g., "Electronics", "Clothing", "Shoes", "Sports", "Home", "Beauty", "Travel", "Jewelry", "Toys", "Office Supplies"). Pick the single best fit.
- "estimated_price": your best estimate of the typical retail price as a float (e.g., 249.99). Use common US retail prices. If the query is a store name rather than a product, use 100.0.
- "likely_retailers": array of 1-5 retailer names likely to carry this product on the MileagePlus Shopping portal (e.g., ["Best Buy", "Target", "Walmart"]). Return [] if the query is too vague or a generic category.
- "query_type": one of "product" (specific product like "AirPods Pro"), "category" (broad category like "headphones" or "running shoes"), or "retailer" (specific store name like "Best Buy" or "Nike").

Return ONLY a JSON object. No markdown. No backticks. No explanation. Start your response with { and end with }.`;

// Normalize a retailer name for fuzzy matching:
// lowercase + remove all non-alphanumeric characters.
// "Best Buy", "BestBuy", "best buy", "BESTBUY" → "bestbuy"
function normalizeForMatch(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tryParseJSON(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return JSON.parse(cleaned);
}

const FALLBACK = {
  interpreted_category: 'General',
  estimated_price: 100.0,
  likely_retailers: [],
  query_type: 'product',
};

async function interpretQuery(query) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ...FALLBACK };
  }

  async function callApi(message) {
    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    };

    const resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    const content = data.content?.[0]?.text;
    if (!content) throw new Error('Anthropic API returned empty content');
    return content;
  }

  const userMessage = `Search query: ${query}`;

  try {
    let responseText = await callApi(userMessage);

    let parsed;
    try {
      parsed = tryParseJSON(responseText);
    } catch {
      // Retry once with explicit JSON instruction
      const retryMessage = userMessage + '\n\nRespond with only a raw JSON object. No markdown. No backticks. No explanation. Start with { and end with }.';
      responseText = await callApi(retryMessage);
      try {
        parsed = tryParseJSON(responseText);
      } catch {
        return { ...FALLBACK };
      }
    }

    const validQueryTypes = ['product', 'category', 'retailer'];
    return {
      interpreted_category: typeof parsed.interpreted_category === 'string'
        ? parsed.interpreted_category
        : 'General',
      estimated_price: typeof parsed.estimated_price === 'number'
        ? parsed.estimated_price
        : 100.0,
      likely_retailers: Array.isArray(parsed.likely_retailers)
        ? parsed.likely_retailers.filter(r => typeof r === 'string')
        : [],
      query_type: validQueryTypes.includes(parsed.query_type)
        ? parsed.query_type
        : 'product',
    };
  } catch {
    return { ...FALLBACK };
  }
}

module.exports = { interpretQuery, normalizeForMatch };
