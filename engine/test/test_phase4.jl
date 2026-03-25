# test_phase4.jl — Unit tests for Phase 4: score_mpx, score_stacked, rank_all, worst_risk

# ---------------------------------------------------------------------------
# Helper: construct minimal RetailerData for testing
# RetailerData is defined in database.jl but we construct it inline here.
# ---------------------------------------------------------------------------

function make_retailer_data(;
    name="TestRetailer",
    base_rate=2.0,
    mpx_rate=2.0,
    gc_portal_eligible=false,
    risk=confirmed,
    category="",
    bonuses=BonusOffer[],
    tc_inclusions="",
    tc_exclusions="",
    tc_confidence=1.0,
    id=1
)
    retailer = Retailer(id, name, base_rate, mpx_rate, gc_portal_eligible, risk, category)
    return RetailerData(retailer, bonuses, tc_inclusions, tc_exclusions, tc_confidence)
end

# ---------------------------------------------------------------------------
# worst_risk tests
# ---------------------------------------------------------------------------

@testset "worst_risk" begin
    @test worst_risk(confirmed, confirmed) == confirmed
    @test worst_risk(confirmed, uncertain) == uncertain
    @test worst_risk(confirmed, excluded) == excluded
    @test worst_risk(uncertain, excluded) == excluded
    @test worst_risk(uncertain, uncertain) == uncertain
    @test worst_risk(excluded, confirmed) == excluded
    @test worst_risk(excluded, excluded) == excluded
end

# ---------------------------------------------------------------------------
# score_mpx tests
# ---------------------------------------------------------------------------

@testset "score_mpx — basic case, no card" begin
    # BestBuy: mpx_rate=2.0, p_cash=100.0, card=none
    # mpx_miles = 100 * 2.0 = 200
    # card_miles = 100 * 0.0 = 0
    # chase_bonus = 0.25 * 200 = 50
    # total = 250
    rd = make_retailer_data(name="BestBuy", mpx_rate=2.0)
    spend = SpendVector(100.0; tax_rate=0.0)
    card = CardTier("none", 0.0, Dict{String,Float64}())
    result = score_mpx(rd, spend, card)

    @test result.mpx_miles    ≈ 200.0
    @test result.card_miles   ≈ 0.0
    @test result.bonus_miles  ≈ 50.0   # chase bonus
    @test result.total_miles  ≈ 250.0
    @test result.portal_miles ≈ 0.0
    @test result.risk_class   == confirmed
    @test result.path         == mpx
end

@testset "score_mpx — with explorer card" begin
    # BestBuy: mpx_rate=2.0, p_cash=100.0, explorer (base_rate=1.0)
    # mpx_miles = 200, card = 100, chase_bonus = 50, total = 350
    rd = make_retailer_data(name="BestBuy", mpx_rate=2.0)
    spend = SpendVector(100.0; tax_rate=0.0)
    card = CardTier("United Explorer", 1.0, Dict{String,Float64}())
    result = score_mpx(rd, spend, card)

    @test result.card_miles  ≈ 100.0
    @test result.total_miles ≈ 350.0
end

@testset "score_mpx — zero mpx_rate returns zeros" begin
    rd = make_retailer_data(name="NoMPX", mpx_rate=0.0)
    spend = SpendVector(100.0; tax_rate=0.0)
    card = CardTier("none", 0.0, Dict{String,Float64}())
    result = score_mpx(rd, spend, card)

    @test result.total_miles ≈ 0.0
    @test result.risk_class  == confirmed
end

@testset "score_mpx — nothing mpx_rate returns zeros" begin
    rd = make_retailer_data(name="NoMPX", mpx_rate=nothing)
    result = score_mpx(rd, SpendVector(100.0; tax_rate=0.0), CardTier("none", 0.0, Dict{String,Float64}()))
    @test result.total_miles ≈ 0.0
end

# ---------------------------------------------------------------------------
# score_stacked tests
# ---------------------------------------------------------------------------

@testset "score_stacked — gamma_r=false degrades to MPX" begin
    # gc=BestBuy (mpx_rate=2.0), dest=Nike (gc_portal_eligible=false)
    # p_cash=100, no card. Leg 2 contributes nothing.
    # Same as score_mpx(BestBuy)
    gc = make_retailer_data(name="BestBuy", mpx_rate=2.0, id=1)
    dest = make_retailer_data(name="Nike", base_rate=3.0, mpx_rate=3.0,
                               gc_portal_eligible=false, id=2,
                               tc_inclusions="Footwear", tc_exclusions="Gift Cards")
    spend = SpendVector(100.0; tax_rate=0.0)
    card = CardTier("none", 0.0, Dict{String,Float64}())

    stacked_result = score_stacked(gc, dest, "Footwear", spend, card)
    mpx_result = score_mpx(gc, spend, card)

    @test stacked_result.total_miles ≈ mpx_result.total_miles
    @test stacked_result.portal_miles ≈ 0.0
    @test stacked_result.risk_class == confirmed
    @test stacked_result.path == stacked
end

@testset "score_stacked — gamma_r=true, confirmed category" begin
    # gc=BestBuy (mpx_rate=2.0), dest=Walmart (base_rate=1.5, gc_portal_eligible=true)
    # category="General Merchandise" → confirmed for Walmart
    # p_list=100, p_cash=100, p_portal=100, no card
    #
    # Leg 1: mpx=200, card=0, chase_bonus=50
    # Leg 2: portal = 1.5*100 = 150, bonus = 0 (no Walmart bonus)
    # Total = 200 + 0 + 50 + 150 + 0 = 400
    gc = make_retailer_data(name="BestBuy", mpx_rate=2.0, id=1)
    dest = make_retailer_data(name="Walmart", base_rate=1.5, mpx_rate=1.5,
                               gc_portal_eligible=true, id=3,
                               tc_inclusions="General Merchandise,Grocery",
                               tc_exclusions="Gift Cards,Pharmacy,Tobacco")
    spend = SpendVector(100.0; tax_rate=0.0)
    card = CardTier("none", 0.0, Dict{String,Float64}())

    result = score_stacked(gc, dest, "General Merchandise", spend, card)

    @test result.mpx_miles    ≈ 200.0    # leg1 mpx
    @test result.portal_miles ≈ 150.0    # leg2 portal
    @test result.card_miles   ≈ 0.0      # no card
    @test result.bonus_miles  ≈ 50.0     # leg1 chase bonus only (no Walmart bonus)
    @test result.total_miles  ≈ 400.0
    @test result.risk_class   == confirmed
    @test result.path         == stacked
    @test result.gc_source    == "BestBuy"
    @test result.destination  == "Walmart"
end

@testset "score_stacked — gamma_r=true, excluded category (Gift Cards)" begin
    # gc=BestBuy, dest=Walmart, category="Gift Cards" → excluded for Walmart
    # Leg 2 portal=0, bonus=0. Total = Leg 1 only = 250
    gc = make_retailer_data(name="BestBuy", mpx_rate=2.0, id=1)
    dest = make_retailer_data(name="Walmart", base_rate=1.5, mpx_rate=1.5,
                               gc_portal_eligible=true, id=3,
                               tc_inclusions="General Merchandise,Grocery",
                               tc_exclusions="Gift Cards,Pharmacy,Tobacco")
    spend = SpendVector(100.0; tax_rate=0.0)
    card = CardTier("none", 0.0, Dict{String,Float64}())

    result = score_stacked(gc, dest, "Gift Cards", spend, card)

    @test result.portal_miles ≈ 0.0
    @test result.total_miles  ≈ 250.0    # only Leg 1: 200 + 0 + 50
    # Risk is :confirmed because excluded Leg 2 means no Leg 2 miles,
    # not that the whole stacked path is excluded. No risky miles in the total.
    @test result.risk_class   == confirmed
end

@testset "score_stacked — NO card miles on Leg 2" begin
    # Verify card miles only come from Leg 1 (gift card purchase)
    gc = make_retailer_data(name="BestBuy", mpx_rate=2.0, id=1)
    dest = make_retailer_data(name="Walmart", base_rate=1.5, mpx_rate=1.5,
                               gc_portal_eligible=true, id=3,
                               tc_inclusions="General Merchandise",
                               tc_exclusions="Gift Cards")
    spend = SpendVector(100.0; tax_rate=0.0)
    card = CardTier("United Explorer", 1.0, Dict{String,Float64}())

    result = score_stacked(gc, dest, "General Merchandise", spend, card)

    # Card miles = 100 * 1.0 = 100 (Leg 1 only)
    # NOT 100 * 1.0 + 100 * 1.0 (would be 200 if Leg 2 card miles existed)
    @test result.card_miles ≈ 100.0
end

# ---------------------------------------------------------------------------
# rank_all tests
# ---------------------------------------------------------------------------

@testset "rank_all — ordering with three seed retailers" begin
    # Mimic seed data: BestBuy(base=2,mpx=2), Nike(base=3,mpx=3), Walmart(base=1.5,mpx=1.5,gc=true)
    bestbuy = make_retailer_data(name="BestBuy", base_rate=2.0, mpx_rate=2.0, id=1,
                gc_portal_eligible=false,
                tc_inclusions="Electronics,Computers,Appliances", tc_exclusions="Gift Cards,Services",
                bonuses=BonusOffer[FlatTieredBonus(1, [(100.0, 500.0)])])
    nike = make_retailer_data(name="Nike", base_rate=3.0, mpx_rate=3.0, id=2,
                gc_portal_eligible=false,
                tc_inclusions="Clothing,Footwear,Accessories", tc_exclusions="Gift Cards",
                bonuses=BonusOffer[PerOrderFlatBonus(2, 250.0, 75.0)])
    walmart = make_retailer_data(name="Walmart", base_rate=1.5, mpx_rate=1.5, id=3,
                gc_portal_eligible=true,
                tc_inclusions="General Merchandise,Grocery", tc_exclusions="Gift Cards,Pharmacy,Tobacco")

    retailers = [bestbuy, nike, walmart]
    spend = SpendVector(200.0; tax_rate=0.0)
    card = CardTier("none", 0.0, Dict{String,Float64}())

    results = rank_all(retailers, "Electronics", spend, card)

    # Non-empty
    @test length(results) > 0

    # All sorted descending by total
    for i in 1:length(results)-1
        @test results[i].total_miles >= results[i+1].total_miles
    end

    # All paths are valid
    for r in results
        @test r.path in [direct, mpx, stacked]
    end

    # BestBuy direct should have Electronics as confirmed → portal+bonus
    bb_direct = filter(r -> r.retailer_name == "BestBuy" && r.path == direct, results)
    @test length(bb_direct) == 1
    @test bb_direct[1].portal_miles ≈ 400.0  # 2.0 * 200
    @test bb_direct[1].bonus_miles ≈ 500.0   # FlatTiered at 200 >= 100

    # Stacked results with Walmart as destination should exist
    stacked_to_walmart = filter(r -> r.path == stacked && r.destination == "Walmart", results)
    @test length(stacked_to_walmart) > 0
end

@testset "rank_all — risk filter" begin
    bestbuy = make_retailer_data(name="BestBuy", base_rate=2.0, mpx_rate=2.0, id=1,
                gc_portal_eligible=false,
                tc_inclusions="Electronics", tc_exclusions="Gift Cards")
    retailers = [bestbuy]
    spend = SpendVector(100.0; tax_rate=0.0)
    card = CardTier("none", 0.0, Dict{String,Float64}())

    # Electronics is confirmed for BestBuy
    results_confirmed = rank_all(retailers, "Electronics", spend, card;
                                  risk_filter=Set([confirmed]))
    for r in results_confirmed
        @test r.risk_class == confirmed
    end
end

# ---------------------------------------------------------------------------
# classify_category_from_tc tests
# ---------------------------------------------------------------------------

@testset "classify_category_from_tc" begin
    @test classify_category_from_tc("Electronics", "Electronics,Computers", "Gift Cards", 0.95) == confirmed
    @test classify_category_from_tc("Gift Cards", "Electronics,Computers", "Gift Cards", 0.95) == excluded
    @test classify_category_from_tc("Toys", "Electronics,Computers", "Gift Cards", 0.95) == excluded  # not in inclusions → excluded (Phase 5 reconciliation)
    @test classify_category_from_tc("Anything", "", "", 0.5) == uncertain  # low confidence
end
