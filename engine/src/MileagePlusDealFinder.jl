module MileagePlusDealFinder

include("types.jl")
include("bonus.jl")
include("scoring.jl")
include("database.jl")

export SpendVector, Retailer, CardTier, ScoreResult
export RiskClass, confirmed, uncertain, excluded
export PathType, direct, mpx, stacked
export BonusSemantic, total, incremental, up_to, flat_bonus
export BonusOffer, FlatTieredBonus, RateMultiplierBonus, PerOrderFlatBonus
export card_rate, risk_class, score_direct, score_mpx, score_stacked, rank_all
export worst_risk, classify_category_from_tc
export compute_bonus, total_bonus_miles
export get_db_path, load_latest_snapshot, load_retailer, load_all_retailers, load_risk_class
export load_process_constraints, snapshot_age_hours
export SnapshotInfo, RetailerData, ProcessConstraint

end # module MileagePlusDealFinder
