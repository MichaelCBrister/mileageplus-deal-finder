# database.jl — SQLite database layer for MileagePlus Deal Finder
# Phase 3: reads retailers, rates, bonuses, T&C rules, and snapshots from SQLite.
# All functions take a SQLite.DB connection as their first argument.

using SQLite
using JSON3
using Dates

# ---------------------------------------------------------------------------
# Database path
# ---------------------------------------------------------------------------

"""
    get_db_path() → String

Returns the absolute path to db/mileageplus.db relative to the repo root.
Works regardless of the working directory the server is started from.
"""
function get_db_path()::String
    # database.jl is at engine/src/database.jl
    # db is at repo_root/db/mileageplus.db
    src_dir = @__DIR__
    repo_root = dirname(dirname(src_dir))  # engine/src → engine → repo_root
    return joinpath(repo_root, "db", "mileageplus.db")
end

# ---------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------

struct SnapshotInfo
    snapshot_id::String
    completed_at::String
    retailer_count::Int
end

"""
    load_latest_snapshot(db) → SnapshotInfo or nothing

Returns the most recent complete snapshot, or nothing if none exists.
"""
function load_latest_snapshot(db::SQLite.DB)::Union{SnapshotInfo, Nothing}
    rows = SQLite.DBInterface.execute(db,
        "SELECT snapshot_id, completed_at, retailer_count FROM scrape_snapshots WHERE status = 'complete' ORDER BY completed_at DESC LIMIT 1"
    ) |> SQLite.rowtable
    if isempty(rows)
        return nothing
    end
    r = rows[1]
    return SnapshotInfo(
        String(r.snapshot_id),
        String(r.completed_at),
        Int(r.retailer_count)
    )
end

# ---------------------------------------------------------------------------
# Retailer loading
# ---------------------------------------------------------------------------

struct RetailerData
    retailer::Retailer
    bonuses::Vector{BonusOffer}
    tc_inclusions::String
    tc_exclusions::String
    tc_confidence::Float64
end

"""
    load_retailer(db, snapshot_id, name) → RetailerData or nothing

Loads a retailer by name with its rates, bonuses, and T&C rules for the given snapshot.
Returns nothing if the retailer or its rate is not found.
"""
function load_retailer(db::SQLite.DB, snapshot_id::String, name::String)::Union{RetailerData, Nothing}
    # Find retailer by name (case-insensitive)
    retailer_rows = SQLite.DBInterface.execute(db,
        "SELECT retailer_id, name, gc_portal_eligible FROM retailers WHERE LOWER(REPLACE(name, ' ', '')) = LOWER(REPLACE(?, ' ', ''))",
        (name,)
    ) |> SQLite.rowtable
    if isempty(retailer_rows)
        return nothing
    end
    rr = retailer_rows[1]
    retailer_id = Int(rr.retailer_id)
    retailer_name = String(rr.name)
    gc_eligible = Bool(rr.gc_portal_eligible != 0)

    # Get base rate for this snapshot
    rate_rows = SQLite.DBInterface.execute(db,
        "SELECT base_rate FROM retailer_rates WHERE retailer_id = ? AND snapshot_id = ?",
        (retailer_id, snapshot_id)
    ) |> SQLite.rowtable
    if isempty(rate_rows)
        return nothing
    end
    base_rate = Float64(rate_rows[1].base_rate)

    # Get MPX rate (optional)
    mpx_rows = SQLite.DBInterface.execute(db,
        "SELECT mpx_rate, chase_bonus FROM mpx_rates WHERE retailer_id = ? AND snapshot_id = ?",
        (retailer_id, snapshot_id)
    ) |> SQLite.rowtable
    mpx_rate = isempty(mpx_rows) ? nothing : Float64(mpx_rows[1].mpx_rate)

    # Load active bonus offers for this snapshot
    # DECISION: check active_from/active_until against current date, treating NULL as unbounded
    today_str = Dates.format(Dates.today(), "yyyy-mm-dd")
    bonus_rows = SQLite.DBInterface.execute(db,
        """SELECT bonus_id, bonus_type, config_json FROM bonus_offers
           WHERE retailer_id = ? AND snapshot_id = ?
           AND (active_from IS NULL OR active_from <= ?)
           AND (active_until IS NULL OR active_until >= ?)""",
        (retailer_id, snapshot_id, today_str, today_str)
    ) |> SQLite.rowtable

    bonuses = BonusOffer[]
    for br in bonus_rows
        bonus = parse_bonus(retailer_id, String(br.bonus_type), String(br.config_json))
        if bonus !== nothing
            push!(bonuses, bonus)
        end
    end

    # Load T&C rules
    tc_rows = SQLite.DBInterface.execute(db,
        "SELECT inclusions, exclusions, confidence FROM tc_rules WHERE retailer_id = ? AND snapshot_id = ?",
        (retailer_id, snapshot_id)
    ) |> SQLite.rowtable

    tc_inclusions = ""
    tc_exclusions = ""
    tc_confidence = 1.0
    if !isempty(tc_rows)
        tc = tc_rows[1]
        tc_inclusions = tc.inclusions === missing ? "" : String(tc.inclusions)
        tc_exclusions = tc.exclusions === missing ? "" : String(tc.exclusions)
        tc_confidence = tc.confidence === missing ? 1.0 : Float64(tc.confidence)
    end

    # Build Retailer struct — risk_class defaults to confirmed; actual risk is determined per-query
    retailer = Retailer(retailer_id, retailer_name, base_rate, mpx_rate, gc_eligible, confirmed, "")

    return RetailerData(retailer, bonuses, tc_inclusions, tc_exclusions, tc_confidence)
end

# ---------------------------------------------------------------------------
# Bonus parsing from config_json
# ---------------------------------------------------------------------------

"""
    parse_bonus(retailer_id, bonus_type, config_json) → BonusOffer or nothing

Parses a bonus offer from its type string and JSON configuration.
"""
function parse_bonus(retailer_id::Int, bonus_type::String, config_json::String)::Union{BonusOffer, Nothing}
    config = JSON3.read(config_json)

    if bonus_type == "flat_tiered"
        tiers_raw = get(config, :tiers, [])
        thresholds = Tuple{Float64, Float64}[]
        for t in tiers_raw
            push!(thresholds, (Float64(t[1]), Float64(t[2])))
        end
        return FlatTieredBonus(retailer_id, thresholds)
    elseif bonus_type == "rate_multiplier"
        rate = Float64(get(config, :rate, 0.0))
        sem_str = String(get(config, :semantics, "total"))
        sem = sem_str == "total" ? total :
              sem_str == "incremental" ? incremental :
              sem_str == "up_to" ? up_to :
              sem_str == "flat_bonus" ? flat_bonus : total
        return RateMultiplierBonus(retailer_id, rate, sem)
    elseif bonus_type == "per_order_flat"
        miles = Float64(get(config, :miles, 0.0))
        min_val = Float64(get(config, :min_order_value, 0.0))
        return PerOrderFlatBonus(retailer_id, miles, min_val)
    end
    return nothing
end

# ---------------------------------------------------------------------------
# Risk classification from T&C rules
# ---------------------------------------------------------------------------

"""
    load_risk_class(db, snapshot_id, retailer_name, category) → RiskClass

Classifies a category against the T&C inclusions/exclusions for a retailer.
Returns :confirmed if category matches an inclusion and not an exclusion.
Returns :excluded if category matches an exclusion or doesn't match any inclusion.
Returns :uncertain if confidence < 0.8 or no clear match.
"""
function load_risk_class(db::SQLite.DB, snapshot_id::String, retailer_name::String, category::String)::RiskClass
    # Find retailer_id
    retailer_rows = SQLite.DBInterface.execute(db,
        "SELECT retailer_id FROM retailers WHERE LOWER(REPLACE(name, ' ', '')) = LOWER(REPLACE(?, ' ', ''))",
        (retailer_name,)
    ) |> SQLite.rowtable
    if isempty(retailer_rows)
        return uncertain
    end
    retailer_id = Int(retailer_rows[1].retailer_id)

    return classify_risk(db, snapshot_id, retailer_id, category)
end

"""
    classify_risk(db, snapshot_id, retailer_id, category) → RiskClass

Internal: classifies risk using the tc_rules for a retailer/snapshot pair.
"""
function classify_risk(db::SQLite.DB, snapshot_id::String, retailer_id::Int, category::String)::RiskClass
    tc_rows = SQLite.DBInterface.execute(db,
        "SELECT inclusions, exclusions, confidence FROM tc_rules WHERE retailer_id = ? AND snapshot_id = ?",
        (retailer_id, snapshot_id)
    ) |> SQLite.rowtable

    if isempty(tc_rows)
        return uncertain
    end

    tc = tc_rows[1]
    confidence = tc.confidence === missing ? 1.0 : Float64(tc.confidence)

    if confidence < 0.8
        return uncertain
    end

    inclusions_str = tc.inclusions === missing ? "" : String(tc.inclusions)
    exclusions_str = tc.exclusions === missing ? "" : String(tc.exclusions)

    return classify_category(category, inclusions_str, exclusions_str)
end

"""
    classify_category(category, inclusions_str, exclusions_str) → RiskClass

String-matching classification of a category against comma-separated inclusion/exclusion lists.
"""
function classify_category(category::String, inclusions_str::String, exclusions_str::String)::RiskClass
    cat_lower = lowercase(strip(category))
    if isempty(cat_lower)
        return uncertain
    end

    # Parse comma-separated lists
    exclusions = [lowercase(strip(x)) for x in split(exclusions_str, ",") if !isempty(strip(x))]
    inclusions = [lowercase(strip(x)) for x in split(inclusions_str, ",") if !isempty(strip(x))]

    # Check exclusions first
    for exc in exclusions
        if cat_lower == exc
            return excluded
        end
    end

    # Check inclusions
    if !isempty(inclusions)
        for inc in inclusions
            if cat_lower == inc
                return confirmed
            end
        end
        # Category doesn't match any inclusion, and inclusions are defined → excluded
        return excluded
    end

    # No inclusions defined → uncertain
    return uncertain
end

# ---------------------------------------------------------------------------
# Process constraints
# ---------------------------------------------------------------------------

struct ProcessConstraint
    constraint_type::String
    severity::String
    description::String
    source::String
end

"""
    load_process_constraints(db, retailer_name) → Vector{ProcessConstraint}

Returns all process constraints for a retailer.
"""
function load_process_constraints(db::SQLite.DB, retailer_name::String)::Vector{ProcessConstraint}
    rows = SQLite.DBInterface.execute(db,
        """SELECT pc.constraint_type, pc.severity, pc.description, pc.source
           FROM process_constraints pc
           JOIN retailers r ON pc.retailer_id = r.retailer_id
           WHERE LOWER(REPLACE(r.name, ' ', '')) = LOWER(REPLACE(?, ' ', ''))""",
        (retailer_name,)
    ) |> SQLite.rowtable

    constraints = ProcessConstraint[]
    for r in rows
        push!(constraints, ProcessConstraint(
            String(r.constraint_type),
            String(r.severity),
            r.description === missing ? "" : String(r.description),
            r.source === missing ? "" : String(r.source)
        ))
    end
    return constraints
end

# ---------------------------------------------------------------------------
# Snapshot staleness
# ---------------------------------------------------------------------------

"""
    snapshot_age_hours(snapshot::SnapshotInfo) → Float64

Returns hours since the snapshot was completed.
"""
function snapshot_age_hours(snapshot::SnapshotInfo)::Float64
    completed = DateTime(snapshot.completed_at, dateformat"yyyy-mm-ddTHH:MM:SS")
    now_utc = Dates.now()
    diff_ms = Dates.value(now_utc - completed)
    return diff_ms / (1000.0 * 3600.0)
end
