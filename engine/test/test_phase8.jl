# test_phase8.jl — Unit tests for Phase 8: basket optimizer (greedy + MILP)

# Reuse make_retailer_data helper from test_phase4.jl (already included)

# ---------------------------------------------------------------------------
# greedy_basket tests
# ---------------------------------------------------------------------------

@testset "greedy_basket — basic 2 items" begin
    # 3 retailers mimicking seed data
    bestbuy = make_retailer_data(
        name="BestBuy", id=1, base_rate=2.0, mpx_rate=2.0,
        gc_portal_eligible=false,
        bonuses=BonusOffer[FlatTieredBonus(1, [(100.0, 500.0)])],
        tc_inclusions="electronics,computers", tc_exclusions="gift cards",
        tc_confidence=1.0
    )
    nike = make_retailer_data(
        name="Nike", id=2, base_rate=5.0, mpx_rate=3.0,
        gc_portal_eligible=false,
        bonuses=BonusOffer[PerOrderFlatBonus(2, 250.0, 75.0)],
        tc_inclusions="clothing,footwear", tc_exclusions="gift cards",
        tc_confidence=1.0
    )
    walmart = make_retailer_data(
        name="Walmart", id=3, base_rate=1.5, mpx_rate=1.0,
        gc_portal_eligible=true,
        bonuses=BonusOffer[],
        tc_inclusions="general merchandise,grocery", tc_exclusions="gift cards",
        tc_confidence=1.0
    )
    retailers = [bestbuy, nike, walmart]

    items = [(name="TV", p_list=100.0), (name="Headphones", p_list=50.0)]
    card = CardTier("none", 0.0, Dict{String,Float64}())

    result = greedy_basket(items, retailers, "Electronics", card, 500.0)

    @test result.feasible == true
    @test result.total_miles > 0.0
    @test length(result.assignments) == 2
    @test result.total_spend <= 500.0

    # Each item should have a valid assignment
    for a in result.assignments
        @test !isempty(a.item_name)
        @test !isempty(a.retailer_name)
        @test a.miles > 0.0 || a.miles == 0.0
        @test a.spend > 0.0
    end
end

@testset "greedy_basket — budget binding" begin
    bestbuy = make_retailer_data(
        name="BestBuy", id=1, base_rate=2.0, mpx_rate=2.0,
        gc_portal_eligible=false,
        bonuses=BonusOffer[FlatTieredBonus(1, [(100.0, 500.0)])],
        tc_inclusions="electronics", tc_exclusions="", tc_confidence=1.0
    )
    retailers = [bestbuy]

    # Two expensive items, budget only covers one
    items = [(name="Item A", p_list=300.0), (name="Item B", p_list=300.0)]
    card = CardTier("none", 0.0, Dict{String,Float64}())

    result = greedy_basket(items, retailers, "Electronics", card, 400.0)

    @test result.feasible == false  # budget cannot cover both items
    @test result.total_spend <= 400.0
    @test length(result.assignments) == 1  # only one item fits
end

# ---------------------------------------------------------------------------
# MILP tests — wrapped in try/catch in case HiGHS is unavailable
# ---------------------------------------------------------------------------

milp_available = true
try
    using JuMP, HiGHS
    m = Model(HiGHS.Optimizer)
    set_silent(m)
    @variable(m, x >= 0)
    @objective(m, Max, x)
    set_upper_bound(x, 1.0)
    JuMP.optimize!(m)
catch e
    global milp_available = false
    @warn "HiGHS not available, skipping MILP tests: $e"
end

if milp_available

@testset "milp_basket — bonus threshold consolidation" begin
    # BestBuy has a flat_tiered bonus: 500 miles at $100 threshold
    # Two items at $60 each: individually < $100, but together = $120 > $100
    # The MILP should consolidate both items into one BestBuy order to trigger the bonus
    bestbuy = make_retailer_data(
        name="BestBuy", id=1, base_rate=2.0, mpx_rate=2.0,
        gc_portal_eligible=false,
        bonuses=BonusOffer[FlatTieredBonus(1, [(100.0, 500.0)])],
        tc_inclusions="electronics", tc_exclusions="", tc_confidence=1.0
    )
    nike = make_retailer_data(
        name="Nike", id=2, base_rate=3.0, mpx_rate=3.0,
        gc_portal_eligible=false,
        bonuses=BonusOffer[],
        tc_inclusions="electronics", tc_exclusions="", tc_confidence=1.0
    )
    retailers = [bestbuy, nike]

    items = [(name="Item A", p_list=60.0), (name="Item B", p_list=60.0)]
    card = CardTier("none", 0.0, Dict{String,Float64}())

    # Greedy: each item independently goes to Nike (higher base rate 3.0 vs 2.0)
    greedy = greedy_basket(items, retailers, "Electronics", card, 500.0)

    # MILP: should find that consolidating at BestBuy triggers 500 bonus miles
    # BestBuy: 2 * 60 * 2.0 = 240 base + 500 bonus = 740
    # Nike: 2 * 60 * 3.0 = 360 base + 0 bonus = 360
    milp_result = milp_basket(items, retailers, "Electronics", card, 500.0; time_limit=10.0)

    @test milp_result !== nothing
    @test milp_result.feasible == true
    @test milp_result.total_miles > greedy.total_miles  # MILP found the bonus consolidation

    # Both items should be at BestBuy
    for a in milp_result.assignments
        @test a.retailer_name == "BestBuy"
    end
end

@testset "milp_basket — infeasible (zero budget)" begin
    bestbuy = make_retailer_data(
        name="BestBuy", id=1, base_rate=2.0, mpx_rate=2.0,
        gc_portal_eligible=false, bonuses=BonusOffer[],
        tc_inclusions="electronics", tc_exclusions="", tc_confidence=1.0
    )
    retailers = [bestbuy]

    items = [(name="Item A", p_list=100.0)]
    card = CardTier("none", 0.0, Dict{String,Float64}())

    result = milp_basket(items, retailers, "Electronics", card, 0.0; time_limit=5.0)
    # Budget=0 but items have positive p_cash → infeasible
    # However, the model assigns each item to exactly one order and budget <= 0
    # This should return nothing (infeasible)
    @test result === nothing
end

@testset "milp_basket — basic feasible" begin
    bestbuy = make_retailer_data(
        name="BestBuy", id=1, base_rate=2.0, mpx_rate=2.0,
        gc_portal_eligible=false, bonuses=BonusOffer[],
        tc_inclusions="electronics", tc_exclusions="", tc_confidence=1.0
    )
    retailers = [bestbuy]

    items = [(name="TV", p_list=100.0)]
    card = CardTier("none", 0.0, Dict{String,Float64}())

    result = milp_basket(items, retailers, "Electronics", card, 500.0; time_limit=10.0)
    @test result !== nothing
    @test result.feasible == true
    @test result.total_miles > 0.0
    @test length(result.assignments) == 1
    @test result.total_spend <= 500.0
end

end  # if milp_available
