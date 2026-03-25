# test_scoring.jl — Unit tests for score_direct and SpendVector

# ---------------------------------------------------------------------------
# SpendVector tests
# ---------------------------------------------------------------------------

@testset "SpendVector" begin

    @testset "direct path (no gc_denom): p_card includes tax, p_cash = p_card" begin
        sv = SpendVector(100.0; tax_rate = 0.08)
        @test sv.p_list    ≈ 100.0
        @test sv.p_portal  ≈ 100.0   # portal-eligible = list price
        @test sv.p_card    ≈ 108.0   # 100 * 1.08
        @test sv.p_cash    ≈ 108.0   # direct path: pay the card charge
        @test sv.v_residual ≈ 0.0
    end

    @testset "p_portal and p_card correctly separated (tax_rate=0)" begin
        sv = SpendVector(200.0; tax_rate = 0.0)
        @test sv.p_portal == 200.0
        @test sv.p_card   == 200.0
    end

    @testset "p_card > p_portal when tax_rate > 0" begin
        sv = SpendVector(100.0; tax_rate = 0.10)
        @test sv.p_card > sv.p_portal
        @test sv.p_card ≈ 110.0
    end

    @testset "gc_denom path: p_cash = denomination, v_residual = denom - p_list" begin
        sv = SpendVector(80.0; tax_rate = 0.08, gc_denom = 100.0)
        @test sv.p_list    ≈ 80.0
        @test sv.p_card    ≈ 86.4    # 80 * 1.08
        @test sv.p_cash    ≈ 100.0   # paid gc_denom for the gift card
        @test sv.v_residual ≈ 20.0   # 100 - 80
    end

    @testset "gc_denom exactly equals p_list: v_residual = 0" begin
        sv = SpendVector(50.0; tax_rate = 0.08, gc_denom = 50.0)
        @test sv.p_cash     ≈ 50.0
        @test sv.v_residual ≈ 0.0
    end

    @testset "configurable tax rate: 0% tax" begin
        sv = SpendVector(100.0; tax_rate = 0.0)
        @test sv.p_card ≈ 100.0
        @test sv.p_cash ≈ 100.0
    end
end

# ---------------------------------------------------------------------------
# score_direct tests
# ---------------------------------------------------------------------------

# Helper: build a simple retailer and card for tests
function make_retailer(;
    base_rate=5.0,
    risk=confirmed,
    category="shopping",
    id=1
)
    return Retailer(id, "TestRetailer", base_rate, nothing, false, risk, category)
end

function make_card(; base_rate=1.0, category="shopping", cat_rate=2.0)
    return CardTier("TestCard", base_rate, Dict(category => cat_rate))
end

@testset "score_direct — basic correctness" begin

    @testset "correct total = portal + card + bonus for known input" begin
        # Retailer: base_rate=5, risk=confirmed, category="shopping"
        # Card: base_rate=1.0, shopping category rate=2.0
        # Spend: p_list=100, tax=0.08 → p_portal=100, p_card=108
        # No bonuses
        #
        # portal_miles = 1.0 * 100 * 5.0 = 500
        # card_miles   = 108 * 2.0       = 216
        # bonus_miles  = 0
        # total        = 716
        retailer = make_retailer(base_rate = 5.0, risk = confirmed, category = "shopping")
        card     = make_card(base_rate = 1.0, category = "shopping", cat_rate = 2.0)
        spend    = SpendVector(100.0; tax_rate = 0.08)
        result   = score_direct(retailer, spend, card, BonusOffer[])

        @test result.portal_miles ≈ 500.0
        @test result.card_miles   ≈ 216.0
        @test result.bonus_miles  ≈ 0.0
        @test result.total_miles  ≈ 716.0
        @test result.risk_class   == confirmed
        @test result.path         == direct
    end

    @testset "MPD = total_miles / p_cash" begin
        retailer = make_retailer(base_rate = 5.0)
        card     = make_card(cat_rate = 2.0)
        spend    = SpendVector(100.0; tax_rate = 0.08)   # p_cash = 108
        result   = score_direct(retailer, spend, card, BonusOffer[])
        @test result.mpd ≈ result.total_miles / spend.p_cash
    end
end

@testset "score_direct — CRITICAL: card miles are independent of delta" begin

    @testset "card miles > 0 when risk_class = excluded (delta = 0)" begin
        # This is the #1 invariant: card miles NEVER multiplied by δ
        # portal_miles should be 0 (excluded), card_miles must still be > 0
        retailer = make_retailer(base_rate = 5.0, risk = excluded)
        card     = make_card(cat_rate = 2.0)
        spend    = SpendVector(100.0; tax_rate = 0.08)  # p_card = 108
        result   = score_direct(retailer, spend, card, BonusOffer[])

        @test result.portal_miles ≈ 0.0     # excluded → portal zeroed
        @test result.card_miles   > 0.0     # MUST be > 0 regardless of δ
        @test result.card_miles   ≈ 216.0   # p_card * c_r = 108 * 2.0
        @test result.risk_class   == excluded
    end

    @testset "card miles equal regardless of confirmed vs excluded risk" begin
        retailer_confirmed = make_retailer(risk = confirmed)
        retailer_excluded  = make_retailer(risk = excluded)
        card  = make_card(cat_rate = 2.0)
        spend = SpendVector(100.0; tax_rate = 0.08)

        r_conf = score_direct(retailer_confirmed, spend, card, BonusOffer[])
        r_excl = score_direct(retailer_excluded,  spend, card, BonusOffer[])

        @test r_conf.card_miles ≈ r_excl.card_miles
    end

    @testset "card miles > 0 when risk_class = uncertain" begin
        retailer = make_retailer(risk = uncertain)
        card     = make_card(cat_rate = 1.5)
        spend    = SpendVector(50.0; tax_rate = 0.08)
        result   = score_direct(retailer, spend, card, BonusOffer[])
        @test result.card_miles > 0.0
        @test result.risk_class == uncertain
    end
end

@testset "score_direct — portal miles behavior by risk class" begin

    @testset "confirmed: portal miles = p_portal * base_rate" begin
        retailer = make_retailer(base_rate = 4.0, risk = confirmed)
        card     = make_card(cat_rate = 1.0)
        spend    = SpendVector(100.0; tax_rate = 0.0)
        result   = score_direct(retailer, spend, card, BonusOffer[])
        @test result.portal_miles ≈ 400.0
    end

    @testset "excluded: portal miles = 0, bonus miles = 0" begin
        retailer = make_retailer(base_rate = 4.0, risk = excluded)
        bonus    = PerOrderFlatBonus(1, 500.0, 0.0)  # would normally trigger
        card     = make_card(cat_rate = 1.0)
        spend    = SpendVector(100.0; tax_rate = 0.0)
        result   = score_direct(retailer, spend, card, BonusOffer[bonus])
        @test result.portal_miles ≈ 0.0
        @test result.bonus_miles  ≈ 0.0
    end

    @testset "uncertain: portal miles included (with warning via risk_class)" begin
        retailer = make_retailer(base_rate = 4.0, risk = uncertain)
        card     = make_card(cat_rate = 1.0)
        spend    = SpendVector(100.0; tax_rate = 0.0)
        result   = score_direct(retailer, spend, card, BonusOffer[])
        @test result.portal_miles ≈ 400.0
        @test result.risk_class   == uncertain
    end
end

@testset "score_direct — with bonuses" begin

    @testset "RateMultiplier :total bonus adds to portal miles correctly" begin
        # base=5, bonus rate=8 total → bonus portion = (8-5)*p_portal
        retailer = make_retailer(base_rate = 5.0, risk = confirmed)
        bonus    = RateMultiplierBonus(1, 8.0, total)
        card     = make_card(cat_rate = 1.0)
        spend    = SpendVector(100.0; tax_rate = 0.0)
        result   = score_direct(retailer, spend, card, BonusOffer[bonus])

        @test result.portal_miles ≈ 500.0          # 5*100
        @test result.bonus_miles  ≈ 300.0          # (8-5)*100
        @test result.total_miles  ≈ 500.0 + 100.0 + 300.0  # portal+card+bonus
    end

    @testset "FlatTieredBonus applies to p_portal" begin
        retailer = make_retailer(base_rate = 3.0, risk = confirmed)
        bonus    = FlatTieredBonus(1, [(100.0, 200.0), (200.0, 500.0)])
        card     = make_card(cat_rate = 1.0)

        # spend = 150 → tier 1 (200 bonus miles)
        spend_150 = SpendVector(150.0; tax_rate = 0.0)
        r150 = score_direct(retailer, spend_150, card, BonusOffer[bonus])
        @test r150.bonus_miles ≈ 200.0

        # spend = 250 → tier 2 (500 bonus miles)
        spend_250 = SpendVector(250.0; tax_rate = 0.0)
        r250 = score_direct(retailer, spend_250, card, BonusOffer[bonus])
        @test r250.bonus_miles ≈ 500.0
    end

    @testset "PerOrderFlatBonus: 0 when below min_spend" begin
        retailer = make_retailer(base_rate = 1.0, risk = confirmed)
        bonus    = PerOrderFlatBonus(1, 500.0, 50.0)
        card     = make_card(cat_rate = 1.0)
        spend    = SpendVector(30.0; tax_rate = 0.0)
        result   = score_direct(retailer, spend, card, BonusOffer[bonus])
        @test result.bonus_miles ≈ 0.0
    end
end

@testset "score_direct — fixture retailer: Macy's" begin
    # Macy's: base_rate=5.0, RateMultiplier 8.0 :total, card=2.0, risk=confirmed
    # price=100, tax=0.08
    # p_portal = 100, p_card = 108
    # portal_miles = 1.0 * 100 * 5.0 = 500
    # card_miles   = 108 * 2.0       = 216
    # bonus_miles  = (8-5)*100       = 300
    # total        = 1016
    retailer = Retailer(1, "Macy's", 5.0, nothing, false, confirmed, "shopping")
    bonus    = RateMultiplierBonus(1, 8.0, total)
    card     = CardTier("United Explorer", 2.0, Dict{String,Float64}())
    spend    = SpendVector(100.0; tax_rate = 0.08)
    result   = score_direct(retailer, spend, card, BonusOffer[bonus])

    @test result.portal_miles ≈ 500.0
    @test result.card_miles   ≈ 216.0
    @test result.bonus_miles  ≈ 300.0
    @test result.total_miles  ≈ 1016.0
    @test result.risk_class   == confirmed
    @test result.card_miles   > 0.0   # invariant check
end

@testset "score_direct — fixture retailer: Sephora electronics (uncertain)" begin
    # Sephora: base_rate=4.0, no bonus, card=2.0
    # electronics product → risk=uncertain
    # portal_miles should be > 0 (uncertain ≠ excluded)
    # card_miles must be > 0
    retailer = Retailer(5, "Sephora", 4.0, nothing, false, uncertain, "beauty")
    card     = CardTier("United Explorer", 2.0, Dict{String,Float64}())
    spend    = SpendVector(100.0; tax_rate = 0.08)
    result   = score_direct(retailer, spend, card, BonusOffer[])

    @test result.risk_class   == uncertain
    @test result.card_miles   > 0.0    # CRITICAL: card miles always earned
    @test result.portal_miles > 0.0    # uncertain: portal miles included with warning
end
