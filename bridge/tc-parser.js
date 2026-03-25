// tc-parser.js — Claude API-powered T&C and bonus offer parser
// Phase 5: Parses raw T&C text into structured inclusions/exclusions and
// bonus offer text into typed BonusOffer configs.
// Called by the bridge server. Results stored in SQLite for Julia to read.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const TC_SYSTEM_PROMPT = `You are a structured data extraction assistant for the United MileagePlus Shopping portal. Your job is to read Terms and Conditions text for a specific retailer and identify which product categories explicitly earn portal miles (inclusions) and which are explicitly excluded from earning (exclusions).

Return ONLY a JSON object with this exact shape:
{"inclusions": ["Category1", "Category2"], "exclusions": ["Category3"], "confidence": 0.95, "notes": "..."}

Confidence scoring rules:
- Set 0.9 or above ONLY when the T&C text contains explicit, unambiguous named category lists.
- Set 0.5 to 0.8 when categories are described with qualifications or general language.
- Set below 0.5 when the text is vague, missing key details, or the earning scope cannot be clearly determined.

Category name normalization: use title case, normalize plural and singular to the form used in the source text, do not invent or infer categories not present in the text.

If the text says something like "all eligible purchases" or "most purchases" with no specific inclusions listed, return inclusions as an empty array with confidence below 0.5, because the unlimited scope gives no useful filtering signal for the engine.

Gift Cards: include in exclusions only if the text explicitly mentions them as excluded. Do not add Gift Cards to exclusions by assumption — the engine applies a global gift card exclusion rule separately.

Respond with only a raw JSON object. No markdown. No backticks. No explanation. Start your response with { and end with }.`;

const BONUS_SYSTEM_PROMPT = `You are a structured data extraction assistant for the United MileagePlus Shopping portal. Your job is to read bonus offer text for a retailer and classify it into exactly one of three types with a precisely structured config object.

Type "flat_tiered": a spend threshold earns a fixed mile amount.
Config fields: tiers (array of [threshold_dollars, bonus_miles] pairs), cumulative (bool: true means only the highest qualifying tier applies, false means tiers are marginal and stack), once_per_member (bool), new_customer_only (bool), min_order_value (float, use 0.0 if none stated), excluded_payment_types (array of strings, include "gift_card" if gift cards are excluded from the bonus), category_restrictions (array of strings or null if no restriction).

Type "rate_multiplier": spend earns miles at a multiplied rate.
Config fields: rate (float representing the stated rate number), semantics (one of exactly these four string values — "total" if the offer states a total earning rate like "earn 5x", "incremental" if the offer states an added bonus like "earn an extra 3x", "up_to" if the rate varies by category, "flat_bonus" if the offer is a fixed mile amount stated as a rate-style offer like "earn 500 bonus miles"), min_order_value (float), excluded_payment_types (array).

Type "per_order_flat": each qualifying order earns a fixed mile amount.
Config fields: miles (float), min_order_value (float), once_per_member (bool), excluded_payment_types (array).

Semantics disambiguation examples:
- "Earn 5x miles at BestBuy" with base_rate=1.0 means semantics="total" and rate=5.0 — the total rate is 5x, meaning 4 bonus miles on top of 1 base mile per dollar.
- "Earn an extra 3 bonus miles per dollar" means semantics="incremental" and rate=3.0 — 3 miles are added to whatever the base rate is.
- "Earn up to 10x miles on select categories" means semantics="up_to" and rate=10.0.
- "Earn 500 bonus miles on your order" means semantics="flat_bonus" and rate=500.0.

Return ONLY a JSON object:
{"bonus_type": "flat_tiered", "config": {...}, "confidence": 0.85, "notes": "..."}

Respond with only a raw JSON object. No markdown. No backticks. No explanation. Start your response with { and end with }.`;

// ---------------------------------------------------------------------------
// Helper: call Anthropic API
// ---------------------------------------------------------------------------

async function callAnthropic(systemPrompt, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
  }

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
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
  if (!content) {
    throw new Error('Anthropic API returned empty content');
  }

  return content;
}

function tryParseJSON(text) {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// parseTAndC
// ---------------------------------------------------------------------------

async function parseTAndC(rawText, retailerName) {
  try {
    const userMessage = `Retailer: ${retailerName}\n\nTerms and Conditions Text:\n${rawText}\n\nClassify the earning eligibility for this retailer's portal purchases.`;

    let responseText = await callAnthropic(TC_SYSTEM_PROMPT, userMessage);

    let parsed;
    try {
      parsed = tryParseJSON(responseText);
    } catch {
      // Retry once with clarifying instruction
      const retryMessage = userMessage + '\n\nRespond with only a raw JSON object. No markdown. No backticks. No explanation. Start your response with { and end with }.';
      responseText = await callAnthropic(TC_SYSTEM_PROMPT, retryMessage);
      try {
        parsed = tryParseJSON(responseText);
      } catch {
        // Fallback
        return {
          inclusions: [],
          exclusions: [],
          confidence: 0.0,
          notes: `JSON parse failure after retry. Raw response: ${responseText.substring(0, 200)}`,
          raw_text: rawText,
        };
      }
    }

    return {
      inclusions: Array.isArray(parsed.inclusions) ? parsed.inclusions : [],
      exclusions: Array.isArray(parsed.exclusions) ? parsed.exclusions : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.0,
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      raw_text: rawText,
    };
  } catch (err) {
    return {
      inclusions: [],
      exclusions: [],
      confidence: 0.0,
      notes: `Error: ${err.message}`,
      raw_text: rawText,
    };
  }
}

// ---------------------------------------------------------------------------
// parseBonus
// ---------------------------------------------------------------------------

async function parseBonus(rawText, retailerName, baseRate) {
  try {
    const userMessage = `Retailer: ${retailerName}\nBase rate: ${baseRate} miles per dollar\n\nBonus offer text:\n${rawText}\n\nClassify this bonus offer.`;

    let responseText = await callAnthropic(BONUS_SYSTEM_PROMPT, userMessage);

    let parsed;
    try {
      parsed = tryParseJSON(responseText);
    } catch {
      // Retry once
      const retryMessage = userMessage + '\n\nRespond with only a raw JSON object. No markdown. No backticks. No explanation. Start your response with { and end with }.';
      responseText = await callAnthropic(BONUS_SYSTEM_PROMPT, retryMessage);
      try {
        parsed = tryParseJSON(responseText);
      } catch {
        return {
          bonus_type: 'flat_tiered',
          config: { tiers: [], cumulative: true, once_per_member: false, new_customer_only: false, min_order_value: 0.0, excluded_payment_types: [], category_restrictions: null },
          confidence: 0.0,
          notes: `JSON parse failure after retry. Raw response: ${responseText.substring(0, 200)}`,
          raw_text: rawText,
        };
      }
    }

    return {
      bonus_type: parsed.bonus_type || 'flat_tiered',
      config: parsed.config || {},
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.0,
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      raw_text: rawText,
    };
  } catch (err) {
    return {
      bonus_type: 'flat_tiered',
      config: { tiers: [], cumulative: true, once_per_member: false, new_customer_only: false, min_order_value: 0.0, excluded_payment_types: [], category_restrictions: null },
      confidence: 0.0,
      notes: `Error: ${err.message}`,
      raw_text: rawText,
    };
  }
}

module.exports = { parseTAndC, parseBonus };
