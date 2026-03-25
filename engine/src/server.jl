# server.jl — HTTP.jl server on port 5000
# Endpoints: /health, /score
# Phase 1: fixture retailer data only (no database — DB integration is Phase 3)
# Per v3-spec.md §4.1

using HTTP
using JSON3

include("types.jl")
include("bonus.jl")
include("scoring.jl")

# ---------------------------------------------------------------------------
# Fixture card tiers (v3-spec.md §9)
# ---------------------------------------------------------------------------

const CARD_TIERS = Dict{String, CardTier}(
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

# ---------------------------------------------------------------------------
# Fixture retailers and bonuses
# Phase 1: hardcoded; Phase 3 replaces with DB reads.
#
# Fixtures per task spec Step 4:
#   Macy's     base=5.0  card=2.0  RateMultiplier rate=8.0 semantics=:total  risk=confirmed
#   Best Buy   base=1.0  card=2.0  PerOrderFlat 500 miles min $50           risk=confirmed
#   Udemy      base=8.0  card=1.5  no bonus                                  risk=confirmed
#   Nike       base=3.0  card=2.0  FlatTiered [(100,200),(200,500)]          risk=confirmed
#   Sephora    base=4.0  card=2.0  no bonus   risk=uncertain("electronics"), confirmed otherwise
#
# DECISION: card_rate per-category overrides are not used for fixture retailers
# because the task spec gives a single card_rate per retailer. We store them
# in a custom category that matches the retailer name (lower-case), then look
# up the category in card_rate(). The fixture card tier has no entry for these
# categories, so it falls back to base_rate. We therefore set the fixture
# card_rate by injecting it as a category entry on a per-request basis.
#
# Simpler approach: store the fixture card rate directly on the Retailer as
# a category, and create a per-fixture CardTier with that category mapped.
# ---------------------------------------------------------------------------

# Fixture card tiers that match the per-retailer rates in the task spec
# (override the default card tier's base_rate for each retailer's category).
# These are used when the /score endpoint receives a request for a fixture retailer.
const FIXTURE_CARD_RATES = Dict{String, Float64}(
    "macys"    => 2.0,
    "bestbuy"  => 2.0,
    "udemy"    => 1.5,
    "nike"     => 2.0,
    "sephora"  => 2.0,
)

struct FixtureRetailer
    retailer::Retailer
    bonuses::Vector{BonusOffer}
    # risk_class_override: if not empty, certain product queries get a different risk class
    # Format: Dict("query_substring_lowercase" => RiskClass)
    risk_overrides::Dict{String, RiskClass}
end

const FIXTURE_RETAILERS = Dict{String, FixtureRetailer}(
    "macys" => FixtureRetailer(
        Retailer(1, "Macy's", 5.0, nothing, false, confirmed, "shopping"),
        BonusOffer[RateMultiplierBonus(1, 8.0, total)],
        Dict{String, RiskClass}()
    ),
    "bestbuy" => FixtureRetailer(
        Retailer(2, "Best Buy", 1.0, nothing, false, confirmed, "electronics"),
        BonusOffer[PerOrderFlatBonus(2, 500.0, 50.0)],
        Dict{String, RiskClass}()
    ),
    "udemy" => FixtureRetailer(
        Retailer(3, "Udemy", 8.0, nothing, false, confirmed, "education"),
        BonusOffer[],
        Dict{String, RiskClass}()
    ),
    "nike" => FixtureRetailer(
        Retailer(4, "Nike", 3.0, nothing, false, confirmed, "shopping"),
        BonusOffer[FlatTieredBonus(4, [(100.0, 200.0), (200.0, 500.0)])],
        Dict{String, RiskClass}()
    ),
    "sephora" => FixtureRetailer(
        Retailer(5, "Sephora", 4.0, nothing, false, confirmed, "beauty"),
        BonusOffer[],
        Dict{String, RiskClass}("electronics" => uncertain)
    ),
)

# Normalized lookup key from a retailer name string
function retailer_key(name::String)::String
    return lowercase(replace(name, r"\s+" => ""))
end

# ---------------------------------------------------------------------------
# Request / Response helpers
# ---------------------------------------------------------------------------

"""
    parse_score_request(body) → NamedTuple or error string

Parse the JSON body for /score.
Expected keys: retailer, product_query, price, card_tier
"""
function parse_score_request(body::String)
    local data
    try
        data = JSON3.read(body)
    catch e
        return nothing, "invalid JSON: $(e)"
    end

    retailer_name = get(data, :retailer, nothing)
    product_query = get(data, :product_query, "")
    price         = get(data, :price, nothing)
    card_tier_key = get(data, :card_tier, "explorer")
    tax_rate      = get(data, :tax_rate, 0.08)

    if retailer_name === nothing
        return nothing, "missing field: retailer"
    end
    if price === nothing
        return nothing, "missing field: price"
    end

    price_f    = Float64(price)
    tax_rate_f = Float64(tax_rate)

    return (
        retailer_name = String(retailer_name),
        product_query = String(product_query),
        price         = price_f,
        card_tier_key = String(card_tier_key),
        tax_rate      = tax_rate_f,
    ), nothing
end

"""
    score_result_to_dict(result) → Dict

Convert a ScoreResult to a plain Dict for JSON serialization.
"""
function score_result_to_dict(result::ScoreResult)::Dict{String, Any}
    return Dict{String, Any}(
        "path"         => string(result.path),
        "portal_miles" => result.portal_miles,
        "card_miles"   => result.card_miles,
        "bonus_miles"  => result.bonus_miles,
        "total_miles"  => result.total_miles,
        "mpd"          => result.mpd,
        "risk_class"   => string(result.risk_class),
        "spend" => Dict{String, Any}(
            "p_list"     => result.spend.p_list,
            "p_portal"   => result.spend.p_portal,
            "p_card"     => result.spend.p_card,
            "p_cash"     => result.spend.p_cash,
            "v_residual" => result.spend.v_residual,
        )
    )
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

    # Look up fixture retailer
    key = retailer_key(params.retailer_name)
    if !haskey(FIXTURE_RETAILERS, key)
        return HTTP.Response(404, ["Content-Type" => "application/json"],
                             JSON3.write(Dict("error" => "retailer not found: $(params.retailer_name)")))
    end
    fixture = FIXTURE_RETAILERS[key]

    # Look up card tier
    card_key = lowercase(params.card_tier_key)
    if !haskey(CARD_TIERS, card_key)
        return HTTP.Response(400, ["Content-Type" => "application/json"],
                             JSON3.write(Dict("error" => "unknown card_tier: $(params.card_tier_key)")))
    end
    base_card = CARD_TIERS[card_key]

    # Build a card tier that reflects the fixture's per-retailer card rate
    # by injecting the fixture rate into the category_rates for this retailer's category.
    fixture_card_rate = get(FIXTURE_CARD_RATES, key, base_card.base_rate)
    card = CardTier(
        base_card.name,
        fixture_card_rate,  # use fixture card rate as base for this retailer
        base_card.category_rates
    )

    # Build SpendVector
    spend = SpendVector(params.price; tax_rate = params.tax_rate)

    # Determine effective risk class: check product_query overrides
    retailer = fixture.retailer
    pq_lower = lowercase(params.product_query)
    effective_risk = retailer.risk_class
    for (pattern, override_rc) in fixture.risk_overrides
        if occursin(pattern, pq_lower)
            effective_risk = override_rc
            break
        end
    end

    # Build a retailer with the effective risk class for this query
    effective_retailer = Retailer(
        retailer.id, retailer.name, retailer.base_rate,
        retailer.mpx_rate, retailer.gc_portal_eligible,
        effective_risk, retailer.category
    )

    # Score
    result = score_direct(effective_retailer, spend, card, fixture.bonuses;
                          product_query = params.product_query)

    return HTTP.Response(200, ["Content-Type" => "application/json"],
                         JSON3.write(score_result_to_dict(result)))
end

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

function router(req::HTTP.Request)::HTTP.Response
    if req.method == "GET" && req.target == "/health"
        return handle_health(req)
    elseif req.method == "POST" && req.target == "/score"
        return handle_score(req)
    else
        return HTTP.Response(404, ["Content-Type" => "application/json"],
                             JSON3.write(Dict("error" => "not found")))
    end
end

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

function main()
    port = 5000
    @info "MileagePlus Deal Finder — Julia engine starting on port $port"
    HTTP.serve(router, "0.0.0.0", port)
end

# Run server when this file is executed directly
if abspath(PROGRAM_FILE) == @__FILE__
    main()
end
