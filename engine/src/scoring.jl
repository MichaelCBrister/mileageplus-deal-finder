# scoring.jl — score_direct, score_mpx, score_stacked, rank_all
# Per v3-spec.md §2.2 (Paths 1–3), §2.4 (Risk Classification), §7.3 (Ranking)

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

    return ScoreResult(direct, portal_miles, card_miles, bonus_miles, 0.0, total, mpd, rc, spend;
                       retailer_name = retailer.name)
end

# ---------------------------------------------------------------------------
# worst_risk — severity ordering for combining risk classes
# ---------------------------------------------------------------------------

"""
    worst_risk(a, b) → RiskClass

Returns the more severe of two risk classes.
Severity: excluded > uncertain > confirmed.
"""
function worst_risk(a::RiskClass, b::RiskClass)::RiskClass
    # excluded=2, uncertain=1, confirmed=0 per @enum ordering
    return Int(a) >= Int(b) ? a : b
end

# ---------------------------------------------------------------------------
# risk_priority — numeric ordering for tiebreaking (lower = better)
# ---------------------------------------------------------------------------

function risk_priority(rc::RiskClass)::Int
    if rc == confirmed
        return 0
    elseif rc == uncertain
        return 1
    else
        return 2
    end
end

# ---------------------------------------------------------------------------
# classify_category_from_tc — pure function for risk classification
# Used by scoring functions to avoid database calls.
# Mirrors classify_category in database.jl.
# ---------------------------------------------------------------------------

"""
    classify_category_from_tc(category, inclusions_str, exclusions_str, confidence) → RiskClass

Risk classification of a category against comma-separated inclusion/exclusion lists,
with confidence gating. Delegates to classify_category (database.jl) for the core
string-matching logic. This is the single authoritative classification rule:

  - If confidence < 0.8: return :uncertain (T&C data not reliable)
  - If category matches an explicit exclusion: return :excluded
  - If inclusions non-empty and category matches no inclusion: return :excluded
  - If category matches an inclusion and no exclusion: return :confirmed
  - If both inclusions and exclusions are empty: return :uncertain (no T&C data)
  - If category matches both inclusion and exclusion (contradictory): return :excluded
    (exclusions checked first in classify_category)

Phase 5 reconciliation: this function now produces the same results as
classify_category in database.jl (plus confidence gating). The Phase 4
behavior of returning :uncertain for unlisted categories was incorrect per
v3-spec.md §3.3 — :uncertain is reserved for genuinely ambiguous T&C text,
not for categories absent from a well-defined inclusion list.
"""
function classify_category_from_tc(category::String, inclusions_str::String,
                                    exclusions_str::String, confidence::Float64)::RiskClass
    if confidence < 0.8
        return uncertain
    end
    # Delegate to the shared classify_category logic in database.jl
    return classify_category(category, inclusions_str, exclusions_str)
end

# ---------------------------------------------------------------------------
# score_mpx — Phase 4: MPX (MileagePlus X) gift card path
# ---------------------------------------------------------------------------

"""
    score_mpx(retailer_data, spend, card) → ScoreResult

Score an MPX path purchase: buy eGift card through the MPX app.

Formula (v3-spec.md §2.2 Path 2):
  mpx_miles         = p_cash × m_r
  card_miles         = p_cash × c_r(k)
  chase_bonus_miles  = 0.25 × mpx_miles  (25% Chase primary cardmember bonus)
  total              = mpx_miles + card_miles + chase_bonus_miles

CRITICAL: card_miles use p_cash (the posted gift card transaction).
The 25% Chase bonus is on MPX miles, stored in bonus field.
MPX is the intended gift card channel — risk is always :confirmed.
Gift cards are NOT purchased through the portal.

retailer_data — RetailerData (from database.jl) for the MPX gift card retailer
spend         — SpendVector (p_cash is the gift card purchase amount)
card          — CardTier
"""
function score_mpx(
    retailer_data,  # RetailerData — using duck typing to avoid dependency on database.jl struct
    spend::SpendVector,
    card::CardTier
)::ScoreResult
    mpx_rate = retailer_data.retailer.mpx_rate
    if mpx_rate === nothing || mpx_rate == 0.0
        return ScoreResult(mpx, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, confirmed, spend;
                           retailer_name = retailer_data.retailer.name)
    end

    mpx_miles = spend.p_cash * Float64(mpx_rate)
    card_miles = spend.p_cash * card.base_rate  # card earns on posted transaction (gift card purchase)
    chase_bonus_miles = 0.25 * mpx_miles        # 25% Chase United primary cardmember bonus

    total = mpx_miles + card_miles + chase_bonus_miles
    mpd = spend.p_cash > 0.0 ? total / spend.p_cash : 0.0

    # portal=0 (MPX is not the portal), card=card_miles, bonus=chase_bonus, mpx=mpx_miles
    # Risk is always :confirmed — MPX is the intended channel
    return ScoreResult(mpx, 0.0, card_miles, chase_bonus_miles, mpx_miles, total, mpd, confirmed, spend;
                       retailer_name = retailer_data.retailer.name)
end

# ---------------------------------------------------------------------------
# score_stacked — Phase 4: Two-leg stacked path (MPX + Portal)
# ---------------------------------------------------------------------------

"""
    score_stacked(gc_retailer_data, dest_retailer_data, category, spend, card) → ScoreResult

Score a Stacked path: buy gift card via MPX (Leg 1), then shop through portal
paying with gift card (Leg 2).

Leg 1 (MPX gift card purchase using gc_retailer_data):
  leg1_mpx          = p_cash × gc_mpx_rate
  leg1_card          = p_cash × c_r(k)
  leg1_chase_bonus   = 0.25 × leg1_mpx

Leg 2 (Portal purchase with gift card at dest_retailer_data):
  If gc_portal_eligible = false: Leg 2 contributes nothing (stacked = MPX)
  If gc_portal_eligible = true and not excluded:
    leg2_portal = p_portal × dest_base_rate
    leg2_bonus  = compute_bonus(dest_bonus, p_portal, dest_base_rate)
  NO card miles on Leg 2 — purchase paid with gift card, not credit card.

CRITICAL INVARIANT: Card miles are ONLY earned on Leg 1 (the gift card purchase).
Risk class for Leg 2 comes from dest_retailer_data T&C rules, not from δ multiplication.

gc_retailer_data   — RetailerData for the gift card source retailer
dest_retailer_data — RetailerData for the portal destination retailer
category           — category string for risk classification
spend              — SpendVector
card               — CardTier
"""
function score_stacked(
    gc_retailer_data,
    dest_retailer_data,
    category::String,
    spend::SpendVector,
    card::CardTier
)::ScoreResult
    gc_mpx_rate = gc_retailer_data.retailer.mpx_rate
    if gc_mpx_rate === nothing || gc_mpx_rate == 0.0
        return ScoreResult(stacked, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, confirmed, spend;
                           retailer_name = dest_retailer_data.retailer.name,
                           gc_source = gc_retailer_data.retailer.name,
                           destination = dest_retailer_data.retailer.name)
    end

    # Leg 1: MPX gift card purchase
    leg1_mpx = spend.p_cash * Float64(gc_mpx_rate)
    leg1_card = spend.p_cash * card.base_rate
    leg1_chase_bonus = 0.25 * leg1_mpx

    # Leg 2: Portal purchase with gift card
    leg2_portal = 0.0
    leg2_bonus = 0.0
    leg2_risk = confirmed  # default if no Leg 2

    if dest_retailer_data.retailer.gc_portal_eligible
        # Determine dest risk class from T&C rules
        dest_risk = classify_category_from_tc(
            category,
            dest_retailer_data.tc_inclusions,
            dest_retailer_data.tc_exclusions,
            dest_retailer_data.tc_confidence
        )

        if dest_risk != excluded
            δ = portal_delta(dest_risk)
            leg2_portal = δ * spend.p_portal * dest_retailer_data.retailer.base_rate
            leg2_bonus = total_bonus_miles(dest_retailer_data.bonuses, spend.p_portal, dest_retailer_data.retailer.base_rate)
            leg2_risk = dest_risk
        end
        # If dest_risk == excluded: Leg 2 contributes 0 miles, leg2_risk stays :confirmed
        # because there are no uncertain miles in the total. The excluded category
        # means "don't attempt Leg 2", not "the whole stacked path is risky".
    end

    stacked_total = leg1_mpx + leg1_card + leg1_chase_bonus + leg2_portal + leg2_bonus
    mpd = spend.p_cash > 0.0 ? stacked_total / spend.p_cash : 0.0

    # Combined risk: if gc_portal_eligible is false, pure MPX → confirmed
    # If Leg 2 is excluded (0 miles), risk is still confirmed (no risky miles in total)
    # If Leg 2 is uncertain, combine with worst_risk
    combined_risk = worst_risk(confirmed, leg2_risk)

    return ScoreResult(stacked, leg2_portal, leg1_card, (leg1_chase_bonus + leg2_bonus),
                       leg1_mpx, stacked_total, mpd, combined_risk, spend;
                       retailer_name = dest_retailer_data.retailer.name,
                       gc_source = gc_retailer_data.retailer.name,
                       destination = dest_retailer_data.retailer.name)
end

# ---------------------------------------------------------------------------
# rank_all — Phase 4: score all paths across all retailers
# Per v3-spec.md §7.3
# ---------------------------------------------------------------------------

"""
    rank_all(retailers, category, spend, card; risk_filter=nothing) → Vector{ScoreResult}

Scores all earning paths (Direct, MPX, Stacked) across all retailers in a
single call. Returns results sorted descending by total_miles, with
risk priority (confirmed first) as tiebreaker.

retailers   — Vector of RetailerData (all retailers from current snapshot)
category    — product category for risk classification
spend       — SpendVector
card        — CardTier
risk_filter — optional Set{RiskClass}; if provided, only include results with
              risk_class in the set
"""
function rank_all(
    retailers::Vector,  # Vector of RetailerData
    category::String,
    spend::SpendVector,
    card::CardTier;
    risk_filter::Union{Nothing, Set{RiskClass}} = nothing
)::Vector{ScoreResult}
    results = ScoreResult[]

    for r in retailers
        # Determine risk class for this retailer + category
        rc = classify_category_from_tc(
            category, r.tc_inclusions, r.tc_exclusions, r.tc_confidence
        )

        # Build an effective Retailer with the correct risk class for score_direct
        eff_retailer = Retailer(
            r.retailer.id, r.retailer.name, r.retailer.base_rate,
            r.retailer.mpx_rate, r.retailer.gc_portal_eligible, rc, category
        )

        # Direct path
        push!(results, score_direct(eff_retailer, spend, card, r.bonuses;
                                     product_query = category))

        # MPX path (if retailer has an MPX rate)
        mpx_rate = r.retailer.mpx_rate
        if mpx_rate !== nothing && mpx_rate > 0.0
            push!(results, score_mpx(r, spend, card))
        end

        # Stacked path: this retailer as GC source → each gc_portal_eligible dest
        if mpx_rate !== nothing && mpx_rate > 0.0
            for dest in retailers
                if dest.retailer.gc_portal_eligible
                    push!(results, score_stacked(r, dest, category, spend, card))
                end
            end
        end
    end

    # Apply risk filter if provided
    if risk_filter !== nothing
        filter!(r -> r.risk_class in risk_filter, results)
    end

    # Sort descending by total_miles, then ascending by risk priority (confirmed first)
    sort!(results; by = r -> (-r.total_miles, risk_priority(r.risk_class)))

    return results
end
