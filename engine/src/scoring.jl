# scoring.jl — score_direct (Phase 1 only)
# MPX and Stacked paths are implemented in Phase 4.
# Per v3-spec.md §2.2 (Path 1: Direct) and §2.4 (Risk Classification)

# ---------------------------------------------------------------------------
# risk_class
# ---------------------------------------------------------------------------

"""
    risk_class(retailer, product_query) → RiskClass

Returns the risk class for a retailer/product combination.

Phase 1: risk class is stored on the Retailer struct directly. In Phase 3+
this will be looked up from the database based on product category and T&C
rules. For now, the retailer carries a single default risk class.
"""
function risk_class(retailer::Retailer, ::String)::RiskClass
    return retailer.risk_class
end

# ---------------------------------------------------------------------------
# portal_delta — converts risk class to effective portal factor
#
# IMPORTANT: δ is NOT a numeric multiplier in the ranking or display layer.
# It is a risk CLASS. The only place we convert it to 0/1 is inside
# score_direct when computing portal_miles. Card miles are NEVER gated by δ.
# ---------------------------------------------------------------------------

function portal_delta(rc::RiskClass)::Float64
    if rc == confirmed
        return 1.0
    elseif rc == uncertain
        # DECISION: uncertain → portal miles are INCLUDED in the score but
        # flagged via the risk_class field on ScoreResult. The user sees the
        # warning in the UI. We do NOT zero them here.
        # Per v3-spec §2.4: "Portal miles included with warning"
        return 1.0
    else  # excluded
        # Per v3-spec §2.4: "Portal miles zeroed"
        return 0.0
    end
end

# ---------------------------------------------------------------------------
# score_direct
# ---------------------------------------------------------------------------

"""
    score_direct(retailer, spend, card, bonuses; product_query="") → ScoreResult

Score a Direct path purchase (click through portal, buy with Chase card).

Formula (v3-spec.md §2.2 Path 1):
  portal_miles = δ × p_portal × b_r
  card_miles   = p_card × c_r(k)        ← NEVER multiplied by δ
  bonus_miles  = compute_bonus(...)      applied to p_portal
  total        = portal_miles + card_miles + bonus_miles

CRITICAL INVARIANT: Card miles (p_card × c_r(k)) are ALWAYS earned regardless
of the risk class δ. Portal tracking failures do not affect Chase credit card
mile earning. This is the #1 rule in the codebase — see CLAUDE.md §1.

Args:
  retailer     — Retailer struct
  spend        — SpendVector for this purchase
  card         — CardTier (determines c_r(k))
  bonuses      — Vector of BonusOffer attached to this retailer
  product_query — string used to look up risk class (Phase 1: ignored beyond
                  retrieving the retailer's default risk class)
"""
function score_direct(
    retailer::Retailer,
    spend::SpendVector,
    card::CardTier,
    bonuses::Vector{<:BonusOffer};
    product_query::String = ""
)::ScoreResult
    rc = risk_class(retailer, product_query)
    δ  = portal_delta(rc)

    # Portal miles: gated by δ, uses p_portal as the spend basis
    portal_miles = δ * spend.p_portal * retailer.base_rate

    # Card miles: NEVER gated by δ, uses p_card (includes tax) as spend basis
    c_r = card_rate(card, retailer.category)
    card_miles = spend.p_card * c_r

    # Bonus miles: applied to portal-eligible spend
    bonus_miles = total_bonus_miles(bonuses, spend.p_portal, retailer.base_rate)
    # If portal is excluded, bonuses also should not apply (no portal interaction)
    if rc == excluded
        bonus_miles = 0.0
    end

    total = portal_miles + card_miles + bonus_miles

    # MPD: miles per dollar of cash outflow (p_cash)
    mpd = spend.p_cash > 0.0 ? total / spend.p_cash : 0.0

    return ScoreResult(direct, portal_miles, card_miles, bonus_miles, total, mpd, rc, spend)
end
