# bonus.jl — compute_bonus dispatch for FlatTiered, RateMultiplier, PerOrderFlat
# Per v3-spec.md §2.5 and §3.1

# ---------------------------------------------------------------------------
# compute_bonus — dispatches on concrete BonusOffer subtypes
# ---------------------------------------------------------------------------

"""
    compute_bonus(bonus::FlatTieredBonus, spend, base_rate) → Float64

Returns flat bonus miles for the highest qualifying spend threshold.
Only the single best-matching tier applies (not cumulative across tiers).
Returns 0.0 if spend is below all thresholds.
"""
function compute_bonus(bonus::FlatTieredBonus, spend::Float64, base_rate::Float64)::Float64
    best = 0.0
    for (min_spend, bonus_miles) in bonus.thresholds
        if spend >= min_spend
            best = max(best, bonus_miles)
        end
    end
    return best
end

"""
    compute_bonus(bonus::RateMultiplierBonus, spend, base_rate) → Float64

Returns bonus miles based on semantics:

  :total       → effective rate replaces base_rate; bonus = (rate - base_rate) * spend
                 guarded by max(0, ...) so the bonus cannot be negative.
  :incremental → bonus = bonus.rate * spend  (additive on top of base)
  :up_to       → effective rate = min(bonus.rate, base_rate + bonus.rate)
                 DECISION: :up_to means "earn up to X total" — if base already
                 exceeds the cap, no additional bonus. Bonus = max(0, rate - base_rate) * spend
  :flat_bonus  → bonus = bonus.rate (flat miles, ignoring spend amount beyond threshold = 0)
                 DECISION: For :flat_bonus semantics on a RateMultiplierBonus, treat
                 the `rate` field as flat miles. This is an edge case; prefer
                 PerOrderFlatBonus for per-order flat bonuses.
"""
function compute_bonus(bonus::RateMultiplierBonus, spend::Float64, base_rate::Float64)::Float64
    if bonus.semantics == total
        # "Earn 5x" → effective rate IS bonus.rate; bonus portion = difference from base
        # max(0, ...) guard: if bonus rate < base rate, no additional bonus
        return max(0.0, bonus.rate - base_rate) * spend
    elseif bonus.semantics == incremental
        # "Earn +2x bonus" → straight additional miles on top of base
        return bonus.rate * spend
    elseif bonus.semantics == up_to
        # "Up to 8x" → effective rate capped at bonus.rate; bonus = cap minus base (if positive)
        return max(0.0, bonus.rate - base_rate) * spend
    elseif bonus.semantics == flat_bonus
        # Flat miles amount stored in rate field
        return bonus.rate
    else
        return 0.0
    end
end

"""
    compute_bonus(bonus::PerOrderFlatBonus, spend, base_rate) → Float64

Returns flat bonus miles if spend >= min_spend, else 0.0.
"""
function compute_bonus(bonus::PerOrderFlatBonus, spend::Float64, base_rate::Float64)::Float64
    if spend >= bonus.min_spend
        return bonus.bonus_miles
    else
        return 0.0
    end
end

"""
    total_bonus_miles(bonuses, spend, base_rate) → Float64

Sum compute_bonus over a collection of BonusOffer values.
`bonuses` is a Vector of concrete BonusOffer subtypes (or the abstract supertype).
Julia dispatches compute_bonus dynamically on each element's concrete type.
"""
function total_bonus_miles(bonuses::Vector{<:BonusOffer}, spend::Float64, base_rate::Float64)::Float64
    total = 0.0
    for b in bonuses
        total += compute_bonus(b, spend, base_rate)
    end
    return total
end
