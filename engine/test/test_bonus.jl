# test_bonus.jl — Unit tests for compute_bonus dispatch across bonus types

@testset "FlatTieredBonus" begin
    bonus = FlatTieredBonus(1, [(100.0, 200.0), (200.0, 500.0)])

    @testset "spend below all thresholds returns 0" begin
        @test compute_bonus(bonus, 50.0, 3.0) == 0.0
    end

    @testset "spend exactly at lower threshold returns lower tier" begin
        @test compute_bonus(bonus, 100.0, 3.0) == 200.0
    end

    @testset "spend between thresholds returns lower tier" begin
        @test compute_bonus(bonus, 150.0, 3.0) == 200.0
    end

    @testset "spend at upper threshold returns upper tier" begin
        @test compute_bonus(bonus, 200.0, 3.0) == 500.0
    end

    @testset "spend above upper threshold returns upper tier" begin
        @test compute_bonus(bonus, 300.0, 3.0) == 500.0
    end

    @testset "single threshold" begin
        b = FlatTieredBonus(1, [(50.0, 300.0)])
        @test compute_bonus(b, 49.99, 3.0) == 0.0
        @test compute_bonus(b, 50.0, 3.0)  == 300.0
    end

    @testset "empty thresholds returns 0" begin
        b = FlatTieredBonus(1, Tuple{Float64,Float64}[])
        @test compute_bonus(b, 999.0, 3.0) == 0.0
    end
end

@testset "RateMultiplierBonus — semantics dispatch" begin
    base_rate = 3.0
    spend     = 100.0

    @testset ":total semantics — effective rate replaces base; bonus = (rate - base) * spend" begin
        bonus = RateMultiplierBonus(1, 8.0, total)
        # effective rate = 8, base = 3, bonus = (8-3)*100 = 500
        @test compute_bonus(bonus, spend, base_rate) ≈ 500.0
    end

    @testset ":incremental semantics — bonus = rate * spend" begin
        bonus = RateMultiplierBonus(1, 2.0, incremental)
        # bonus = 2 * 100 = 200
        @test compute_bonus(bonus, spend, base_rate) ≈ 200.0
    end

    @testset ":total vs :incremental differ for same rate value" begin
        # Both use rate=5.0 but semantics differ
        b_total = RateMultiplierBonus(1, 5.0, total)
        b_incr  = RateMultiplierBonus(1, 5.0, incremental)
        # :total bonus  = (5-3)*100 = 200
        # :incr  bonus  = 5*100     = 500
        @test compute_bonus(b_total, spend, base_rate) ≈ 200.0
        @test compute_bonus(b_incr, spend, base_rate)  ≈ 500.0
        @test compute_bonus(b_total, spend, base_rate) != compute_bonus(b_incr, spend, base_rate)
    end

    @testset ":up_to semantics — bonus = max(0, rate - base) * spend" begin
        bonus_above = RateMultiplierBonus(1, 8.0, up_to)
        # bonus = (8-3)*100 = 500 (cap is above base)
        @test compute_bonus(bonus_above, spend, base_rate) ≈ 500.0

        bonus_below = RateMultiplierBonus(1, 2.0, up_to)
        # cap (2) < base (3) → no additional bonus
        @test compute_bonus(bonus_below, spend, base_rate) ≈ 0.0
    end

    @testset ":flat_bonus semantics — returns rate as flat miles" begin
        bonus = RateMultiplierBonus(1, 250.0, flat_bonus)
        # flat miles = 250, ignores spend and base_rate
        @test compute_bonus(bonus, spend, base_rate)     ≈ 250.0
        @test compute_bonus(bonus, 0.0, base_rate)       ≈ 250.0
        @test compute_bonus(bonus, 1000.0, base_rate)    ≈ 250.0
    end

    @testset ":total guard — bonus cannot go negative when rate < base" begin
        bonus = RateMultiplierBonus(1, 1.0, total)
        # rate (1) < base (3) → bonus = max(0, 1-3)*100 = 0
        @test compute_bonus(bonus, spend, base_rate) ≈ 0.0
    end
end

@testset "PerOrderFlatBonus" begin
    bonus = PerOrderFlatBonus(1, 500.0, 50.0)

    @testset "spend below min_spend returns 0" begin
        @test compute_bonus(bonus, 49.99, 1.0) == 0.0
    end

    @testset "spend exactly at min_spend returns bonus_miles" begin
        @test compute_bonus(bonus, 50.0, 1.0) == 500.0
    end

    @testset "spend above min_spend returns bonus_miles" begin
        @test compute_bonus(bonus, 100.0, 1.0) == 500.0
    end

    @testset "spend of 0 returns 0" begin
        @test compute_bonus(bonus, 0.0, 1.0) == 0.0
    end
end

@testset "total_bonus_miles — multiple bonuses" begin
    bonuses = BonusOffer[
        PerOrderFlatBonus(1, 200.0, 50.0),
        RateMultiplierBonus(1, 2.0, incremental),
    ]
    # At spend=100, base=3:
    #   PerOrderFlat: 200 (100 >= 50)
    #   RateMultiplier incremental: 2*100 = 200
    #   total: 400
    @test total_bonus_miles(bonuses, 100.0, 3.0) ≈ 400.0

    # At spend=30, base=3:
    #   PerOrderFlat: 0 (30 < 50)
    #   RateMultiplier: 2*30 = 60
    #   total: 60
    @test total_bonus_miles(bonuses, 30.0, 3.0) ≈ 60.0
end
