# types.jl — SpendVector, Retailer, CardTier, BonusOffer hierarchy
# Per v3-spec.md §3.1 and §2.1

# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------

@enum RiskClass confirmed uncertain excluded

@enum PathType direct mpx stacked

@enum BonusSemantic total incremental up_to flat_bonus

# ---------------------------------------------------------------------------
# SpendVector
# Every purchase is described by a SpendVector — never a single scalar price.
# See v3-spec.md §2.1 for field definitions.
# ---------------------------------------------------------------------------

struct SpendVector
    p_list::Float64       # pre-tax item price (user input)
    p_portal::Float64     # portal-eligible spend (= p_list, net of tax/shipping)
    p_card::Float64       # charged amount = p_list × (1 + τ)
    p_cash::Float64       # out-of-pocket cash outflow
    v_residual::Float64   # leftover gift card balance (stacked path)
end

"""
    SpendVector(p_list; tax_rate=0.08, gc_denom=nothing)

Convenience constructor. Builds a SpendVector from the list price.

- `p_list`    — pre-tax item price
- `tax_rate`  — configurable tax rate; default 0.08 (approximate Georgia rate)
  DECISION: default to 0.08 per CLAUDE.md §"Do not hardcode tax rates"
- `gc_denom`  — if paying with a gift card of this denomination, p_cash is
  set to gc_denom and v_residual = gc_denom - p_card (may be negative if
  card does not cover full purchase, but that is a caller concern)

When gc_denom is nothing (Direct path):
  p_cash = p_card  (you pay the card charge out of pocket)
  v_residual = 0.0

When gc_denom is provided (MPX/Stacked path):
  p_cash = gc_denom  (you paid gc_denom for the gift card)
  v_residual = gc_denom - p_list  (unspent gift card value)
  DECISION: v_residual is computed against p_list (pre-tax), not p_card,
  because the gift card covers the item price; tax is handled at checkout.
"""
function SpendVector(
    p_list::Float64;
    tax_rate::Float64 = 0.08,
    gc_denom::Union{Float64, Nothing} = nothing
)
    p_portal = p_list                          # portal-eligible = list price
    p_card   = p_list * (1.0 + tax_rate)      # charged amount includes tax
    if gc_denom === nothing
        p_cash     = p_card
        v_residual = 0.0
    else
        p_cash     = gc_denom
        v_residual = gc_denom - p_list         # leftover balance
    end
    return SpendVector(p_list, p_portal, p_card, p_cash, v_residual)
end

# ---------------------------------------------------------------------------
# CardTier
# ---------------------------------------------------------------------------

struct CardTier
    name::String
    base_rate::Float64                   # miles per dollar (general spend)
    category_rates::Dict{String, Float64} # category → miles per dollar
end

"""
    card_rate(card, category) → Float64

Return the effective miles-per-dollar rate for a card and purchase category.
Falls back to base_rate if category is not found.
"""
function card_rate(card::CardTier, category::String)::Float64
    return get(card.category_rates, category, card.base_rate)
end

# ---------------------------------------------------------------------------
# Retailer
# ---------------------------------------------------------------------------

struct Retailer
    id::Int
    name::String
    base_rate::Float64                    # portal base rate b_r (miles/$)
    mpx_rate::Union{Float64, Nothing}     # MPX rate m_r; nothing if not available
    gc_portal_eligible::Bool              # γ_r: portal miles when paying with GC
    risk_class::RiskClass                 # δ per-product or retailer default
    category::String
end

# ---------------------------------------------------------------------------
# BonusOffer hierarchy
# Abstract base — use concrete types for storage, abstract for dispatch.
# ---------------------------------------------------------------------------

abstract type BonusOffer end

"""
FlatTieredBonus — flat mile bonuses at spend thresholds (cumulative).

`thresholds` is a vector of (min_spend, bonus_miles) pairs sorted ascending
by min_spend. The applicable bonus is the highest tier whose min_spend is
≤ the spend amount. It is NOT cumulative across tiers — only the highest
qualifying tier applies.

DECISION: "highest qualifying tier" semantics match typical portal promotions
(e.g., "500 miles on \$100+, 1000 miles on \$200+"). The larger threshold wins.
"""
struct FlatTieredBonus <: BonusOffer
    retailer_id::Int
    thresholds::Vector{Tuple{Float64, Float64}}  # (min_spend, bonus_miles)
end

"""
RateMultiplierBonus — modifies the effective portal earn rate.

semantics field controls the formula (see v3-spec.md §2.5):
  :total       → effective_rate = bonus_rate              ("Earn 5x")
  :incremental → effective_rate = base_rate + bonus_rate  ("Earn +2x bonus")
  :up_to       → effective_rate = min(bonus_rate, cap)    ("Up to 8x")
  :flat_bonus  → bonus_miles = rate (flat amount if threshold met)

The :total semantics include a max(0, ...) guard: if the bonus rate is somehow
lower than the base rate, the effective portal rate cannot go negative.
"""
struct RateMultiplierBonus <: BonusOffer
    retailer_id::Int
    rate::Float64
    semantics::BonusSemantic
end

"""
PerOrderFlatBonus — flat bonus miles per order if spend meets min_spend.

Requires order-level modeling in the MILP (Phase 8). In Phase 1, treated as
a single-order bonus applied when p_portal >= min_spend.
"""
struct PerOrderFlatBonus <: BonusOffer
    retailer_id::Int
    bonus_miles::Float64
    min_spend::Float64
end

# ---------------------------------------------------------------------------
# ScoreResult
# ---------------------------------------------------------------------------

struct ScoreResult
    path::PathType
    portal_miles::Float64
    card_miles::Float64
    bonus_miles::Float64
    mpx_miles::Float64     # MPX app miles (0.0 for direct path)
    total_miles::Float64
    mpd::Float64           # miles per dollar = total_miles / p_cash
    risk_class::RiskClass
    spend::SpendVector
    retailer_name::String  # display: primary retailer name
    gc_source::String      # display: gift card source retailer (stacked path)
    destination::String    # display: portal destination retailer (stacked path)
end

"""
    ScoreResult(path, portal, card, bonus, mpx, total, mpd, risk, spend;
                retailer_name="", gc_source="", destination="")

Convenience constructor with keyword defaults for display fields.
"""
function ScoreResult(
    path::PathType, portal_miles::Float64, card_miles::Float64,
    bonus_miles::Float64, mpx_miles::Float64, total_miles::Float64,
    mpd::Float64, risk_class::RiskClass, spend::SpendVector;
    retailer_name::String = "", gc_source::String = "", destination::String = ""
)
    return ScoreResult(path, portal_miles, card_miles, bonus_miles, mpx_miles,
                       total_miles, mpd, risk_class, spend, retailer_name, gc_source, destination)
end
