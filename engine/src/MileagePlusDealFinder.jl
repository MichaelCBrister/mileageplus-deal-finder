module MileagePlusDealFinder

include("types.jl")
include("bonus.jl")
include("scoring.jl")

export SpendVector, Retailer, CardTier, ScoreResult
export RiskClass, confirmed, uncertain, excluded
export PathType, direct, mpx, stacked
export BonusSemantic, total, incremental, up_to, flat_bonus
export BonusOffer, FlatTieredBonus, RateMultiplierBonus, PerOrderFlatBonus
export card_rate, risk_class, score_direct
export compute_bonus, total_bonus_miles

end # module MileagePlusDealFinder
