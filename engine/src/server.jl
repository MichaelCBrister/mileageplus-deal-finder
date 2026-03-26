# server.jl — HTTP.jl server on port 5000
# Endpoints: /health, /score, /rank
# Phase 4: adds MPX/Stacked scoring and rank_all endpoint.
# Per v3-spec.md §4.1

using HTTP
using JSON3
using SQLite
using Dates

include("types.jl")
include("bonus.jl")
include("scoring.jl")
include("database.jl")

# ---------------------------------------------------------------------------
# Card tiers (v3-spec.md §9) — these are config, not scraped data
# ---------------------------------------------------------------------------

const CARD_TIERS = Dict{String, CardTier}(
    "none" => CardTier(
        "No Chase United card",
        0.0,
        Dict{String, Float64}()
    ),
    "explorer" => CardTier(
        "United Explorer",
        1.0,
        Dict("dining" => 2.0, "travel" => 2.0, "gas" => 1.0)
    ),
    "quest" => CardTier(
        "United Quest",
        1.0,
        Dict("dining" => 3.0, "travel" => 2.0, "gas" => 1.0)
    ),
    "club" => CardTier(
        "United Club Infinite",
        1.0,
        Dict("dining" => 2.0, "travel" => 2.0, "gas" => 1.0)
    ),
)

# Map frontend one_x/two_x names to internal tier keys
const CARD_TIER_ALIASES = Dict{String, String}(
    "one_x" => "explorer",
    "one_five_x" => "club",
    "two_x" => "quest",
)

# ---------------------------------------------------------------------------
# Global database connection (opened on startup)
# ---------------------------------------------------------------------------

const DB_REF = Ref{Union{SQLite.DB, Nothing}}(nothing)

function get_db()::SQLite.DB
    return DB_REF[]::SQLite.DB
end

# ---------------------------------------------------------------------------
# Request / Response helpers
# ---------------------------------------------------------------------------

function parse_score_request(body::String)
    local data
    try
        data = JSON3.read(body)
    catch e
        return nothing, "invalid JSON: $(e)"
    end

    retailer_name = get(data, :retailer, nothing)
    # Support both "product_query" (Phase 1 API) and "category" for category-based risk
    product_query = get(data, :product_query, "")
    category      = get(data, :category, "")
    price         = get(data, :price, nothing)
    # Also support p_list as an alias for price (Phase 2 frontend sends p_list via bridge)
    if price === nothing
        price = get(data, :p_list, nothing)
    end
    card_tier_key = get(data, :card_tier, "explorer")
    tax_rate      = get(data, :tax_rate, 0.08)
    path_str      = get(data, :path, "direct")

    if retailer_name === nothing
        return nothing, "missing field: retailer"
    end
    if price === nothing
        return nothing, "missing field: price (or p_list)"
    end

    price_f    = Float64(price)
    tax_rate_f = Float64(tax_rate)

    # Use category if product_query is empty
    effective_category = isempty(String(product_query)) ? String(category) : String(product_query)

    return (
        retailer_name = String(retailer_name),
        category      = effective_category,
        price         = price_f,
        card_tier_key = String(card_tier_key),
        tax_rate      = tax_rate_f,
        path          = String(path_str),
    ), nothing
end

function score_result_to_dict(result::ScoreResult;
    snapshot_id::String="",
    snapshot_completed_at::String="",
    process_constraints::Vector{ProcessConstraint}=ProcessConstraint[]
)::Dict{String, Any}
    constraints_arr = [
        Dict{String, Any}(
            "constraint_type" => c.constraint_type,
            "severity" => c.severity,
            "description" => c.description,
            "source" => c.source
        )
        for c in process_constraints
    ]

    d = Dict{String, Any}(
        "path"         => string(result.path),
        "portal_miles" => result.portal_miles,
        "card_miles"   => result.card_miles,
        "bonus_miles"  => result.bonus_miles,
        "mpx_miles"    => result.mpx_miles,
        "total_miles"  => result.total_miles,
        "mpd"          => result.mpd,
        "risk_class"   => string(result.risk_class),
        "retailer_name" => result.retailer_name,
        "spend" => Dict{String, Any}(
            "p_list"     => result.spend.p_list,
            "p_portal"   => result.spend.p_portal,
            "p_card"     => result.spend.p_card,
            "p_cash"     => result.spend.p_cash,
            "v_residual" => result.spend.v_residual,
        ),
        "snapshot_id"           => snapshot_id,
        "snapshot_completed_at" => snapshot_completed_at,
        "process_constraints"   => constraints_arr,
    )
    if !isempty(result.gc_source)
        d["gc_source"] = result.gc_source
    end
    if !isempty(result.destination)
        d["destination"] = result.destination
    end
    return d
end

# ---------------------------------------------------------------------------
# HTTP handlers
# ---------------------------------------------------------------------------

function handle_health(req::HTTP.Request)::HTTP.Response
    return HTTP.Response(200, ["Content-Type" => "application/json"],
                         JSON3.write(Dict("status" => "ok")))
end

function handle_score(req::HTTP.Request)::HTTP.Response
    body = String(req.body)
    params, err = parse_score_request(body)

    if err !== nothing
        return HTTP.Response(400, ["Content-Type" => "application/json"],
                             JSON3.write(Dict("error" => err)))
    end

    db = get_db()

    # Load latest complete snapshot
    snapshot = load_latest_snapshot(db)
    if snapshot === nothing
        return HTTP.Response(503, ["Content-Type" => "application/json"],
                             JSON3.write(Dict(
                                "error" => "no_complete_snapshot",
                                "message" => "No complete scrape snapshot available. Run the scraper or initialize seed data."
                             )))
    end

    # Load retailer from DB
    retailer_data = load_retailer(db, snapshot.snapshot_id, params.retailer_name)
    if retailer_data === nothing
        return HTTP.Response(404, ["Content-Type" => "application/json"],
                             JSON3.write(Dict(
                                "error" => "retailer_not_found",
                                "retailer" => params.retailer_name
                             )))
    end

    # Determine risk class from T&C rules
    rc = classify_category(params.category, retailer_data.tc_inclusions, retailer_data.tc_exclusions)
    # If confidence is low, override to uncertain
    if retailer_data.tc_confidence < 0.8
        rc = uncertain
    end

    # Look up card tier
    card_key = lowercase(params.card_tier_key)
    # Apply aliases
    card_key = get(CARD_TIER_ALIASES, card_key, card_key)
    if !haskey(CARD_TIERS, card_key)
        return HTTP.Response(400, ["Content-Type" => "application/json"],
                             JSON3.write(Dict("error" => "unknown card_tier: $(params.card_tier_key)")))
    end
    card = CARD_TIERS[card_key]

    # Build SpendVector
    spend = SpendVector(params.price; tax_rate = params.tax_rate)

    # Build retailer with the risk class determined from T&C rules
    effective_retailer = Retailer(
        retailer_data.retailer.id,
        retailer_data.retailer.name,
        retailer_data.retailer.base_rate,
        retailer_data.retailer.mpx_rate,
        retailer_data.retailer.gc_portal_eligible,
        rc,
        params.category
    )

    # Score based on requested path
    local result::ScoreResult
    if params.path == "mpx"
        result = score_mpx(retailer_data, spend, card)
    elseif params.path == "stacked"
        # Stacked via /score uses same retailer as both GC source and destination
        result = score_stacked(retailer_data, retailer_data, params.category, spend, card)
    else
        result = score_direct(effective_retailer, spend, card, retailer_data.bonuses;
                              product_query = params.category)
    end

    # Load process constraints
    constraints = load_process_constraints(db, params.retailer_name)

    # Check staleness
    age_hrs = snapshot_age_hours(snapshot)
    if age_hrs > 24.0
        @warn "Snapshot $(snapshot.snapshot_id) is $(round(age_hrs, digits=1)) hours old — rates may be stale"
    end

    return HTTP.Response(200, ["Content-Type" => "application/json"],
                         JSON3.write(score_result_to_dict(result;
                            snapshot_id = snapshot.snapshot_id,
                            snapshot_completed_at = snapshot.completed_at,
                            process_constraints = constraints
                         )))
end

# ---------------------------------------------------------------------------
# /rank handler — Phase 4
# ---------------------------------------------------------------------------

function handle_rank(req::HTTP.Request)::HTTP.Response
    body = String(req.body)

    local data
    try
        data = JSON3.read(body)
    catch e
        return HTTP.Response(400, ["Content-Type" => "application/json"],
                             JSON3.write(Dict("error" => "invalid JSON: $(e)")))
    end

    p_list = get(data, :p_list, nothing)
    tax_rate = get(data, :tax_rate, 0.08)
    category = get(data, :category, "")
    card_tier_key = get(data, :card_tier, "none")
    risk_filter_raw = get(data, :risk_filter, nothing)

    if p_list === nothing
        return HTTP.Response(400, ["Content-Type" => "application/json"],
                             JSON3.write(Dict("error" => "missing field: p_list")))
    end

    db = get_db()

    # Load latest complete snapshot
    snapshot = load_latest_snapshot(db)
    if snapshot === nothing
        return HTTP.Response(503, ["Content-Type" => "application/json"],
                             JSON3.write(Dict(
                                "error" => "no_complete_snapshot",
                                "message" => "No complete scrape snapshot available."
                             )))
    end

    # Load all retailers
    category_str = String(category)
    retailers = load_all_retailers(db, snapshot.snapshot_id, category_str)

    # Build SpendVector
    spend = SpendVector(Float64(p_list); tax_rate = Float64(tax_rate))

    # Card tier
    card_key = lowercase(String(card_tier_key))
    card_key = get(CARD_TIER_ALIASES, card_key, card_key)
    if !haskey(CARD_TIERS, card_key)
        return HTTP.Response(400, ["Content-Type" => "application/json"],
                             JSON3.write(Dict("error" => "unknown card_tier: $(card_tier_key)")))
    end
    card = CARD_TIERS[card_key]

    # Parse risk filter
    local rf::Union{Nothing, Set{RiskClass}}
    if risk_filter_raw !== nothing
        rf = Set{RiskClass}()
        for s in risk_filter_raw
            s_lower = lowercase(String(s))
            if s_lower == "confirmed"
                push!(rf, confirmed)
            elseif s_lower == "uncertain"
                push!(rf, uncertain)
            elseif s_lower == "excluded"
                push!(rf, excluded)
            end
        end
    else
        rf = nothing
    end

    # Rank all paths
    results = rank_all(retailers, category_str, spend, card; risk_filter = rf)

    # Serialize results
    results_arr = [
        Dict{String, Any}(
            "path"          => string(r.path),
            "retailer_name" => r.retailer_name,
            "portal_miles"  => r.portal_miles,
            "card_miles"    => r.card_miles,
            "bonus_miles"   => r.bonus_miles,
            "mpx_miles"     => r.mpx_miles,
            "total_miles"   => r.total_miles,
            "mpd"           => r.mpd,
            "risk_class"    => string(r.risk_class),
            "gc_source"     => r.gc_source,
            "destination"   => r.destination,
        )
        for r in results
    ]

    return HTTP.Response(200, ["Content-Type" => "application/json"],
                         JSON3.write(Dict{String, Any}(
                            "results"              => results_arr,
                            "snapshot_id"          => snapshot.snapshot_id,
                            "snapshot_completed_at" => snapshot.completed_at,
                            "retailer_count"       => length(retailers),
                            "result_count"         => length(results),
                         )))
end

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

function router(req::HTTP.Request)::HTTP.Response
    if req.method == "GET" && req.target == "/health"
        return handle_health(req)
    elseif req.method == "POST" && req.target == "/score"
        return handle_score(req)
    elseif req.method == "POST" && req.target == "/rank"
        return handle_rank(req)
    else
        return HTTP.Response(404, ["Content-Type" => "application/json"],
                             JSON3.write(Dict("error" => "not found")))
    end
end

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

function main()
    port = parse(Int, get(ENV, "JULIA_ENGINE_PORT", "5001"))

    # Open database
    db_path = get_db_path()
    if !isfile(db_path)
        @error "Database not found at $db_path. Run: bash db/init.sh"
        exit(1)
    end
    DB_REF[] = SQLite.DB(db_path)
    @info "Database opened: $db_path"

    # Check for valid snapshot
    snapshot = load_latest_snapshot(DB_REF[])
    if snapshot !== nothing
        @info "Latest snapshot: $(snapshot.snapshot_id) completed at $(snapshot.completed_at)"
    else
        @warn "No complete snapshot found. /score will return 503 until seed data or scraper runs."
    end

    @info "MileagePlus Deal Finder — Julia engine starting on port $port"
    HTTP.serve(router, "0.0.0.0", port)
end

# Run server when this file is executed directly
if abspath(PROGRAM_FILE) == @__FILE__
    main()
end
