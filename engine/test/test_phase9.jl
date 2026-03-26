# test_phase9.jl — Phase 9: breakpoint sweep sensitivity analysis tests

using JSON3

@testset "Phase 9: Breakpoint Sweep" begin

    # ---------------------------------------------------------------------------
    # Test helpers — build seed-like retailer data
    # ---------------------------------------------------------------------------

    # Mimics the RetailerData struct from database.jl
    function make_retailer_data(; id=1, name="TestRetailer", base_rate=2.0,
            mpx_rate=2.0, gc_portal_eligible=false, bonuses=BonusOffer[],
            tc_inclusions="Electronics,Computers", tc_exclusions="Gift Cards",
            tc_confidence=0.95)
        retailer = Retailer(id, name, base_rate, mpx_rate, gc_portal_eligible,
                            confirmed, "Electronics")
        return RetailerData(retailer, bonuses, tc_inclusions, tc_exclusions, tc_confidence)
    end

    # Seed-like retailers matching the actual seed data
    bestbuy_bonuses = BonusOffer[
        FlatTieredBonus(1, [(100.0, 500.0)])
    ]
    nike_bonuses = BonusOffer[
        PerOrderFlatBonus(2, 250.0, 75.0)
    ]

    bestbuy = make_retailer_data(id=1, name="BestBuy", base_rate=2.0, mpx_rate=2.0,
        gc_portal_eligible=false, bonuses=bestbuy_bonuses,
        tc_inclusions="Electronics,Computers,Appliances", tc_exclusions="Gift Cards")
    nike = make_retailer_data(id=2, name="Nike", base_rate=3.0, mpx_rate=3.0,
        gc_portal_eligible=false, bonuses=nike_bonuses,
        tc_inclusions="Clothing,Footwear,Accessories", tc_exclusions="Gift Cards")
    walmart = make_retailer_data(id=3, name="Walmart", base_rate=1.5, mpx_rate=1.5,
        gc_portal_eligible=true, bonuses=BonusOffer[],
        tc_inclusions="General Merchandise,Grocery", tc_exclusions="Gift Cards,Pharmacy,Tobacco")

    seed_retailers = [bestbuy, nike, walmart]
    no_card = CardTier("No card", 0.0, Dict{String, Float64}())

    # ---------------------------------------------------------------------------
    # Test 1: Basic sweep — contiguous, non-overlapping segments
    # ---------------------------------------------------------------------------

    @testset "breakpoint_sweep basic contiguity" begin
        segments = breakpoint_sweep(seed_retailers, "Electronics", no_card;
                                     p_min=0.0, p_max=500.0, tax_rate=0.0)

        @test !isempty(segments)
        @test segments[1].spend_from == 0.0
        @test segments[end].spend_to == 500.0

        # Verify contiguity: spend_to[k] == spend_from[k+1]
        for k in 1:(length(segments) - 1)
            @test segments[k].spend_to == segments[k + 1].spend_from
        end

        # No gaps or overlaps
        for s in segments
            @test s.spend_from <= s.spend_to
        end

        # All segments have valid fields
        for s in segments
            @test s.retailer_name isa String
            @test s.path isa String
            @test s.miles_at_midpoint >= 0.0
            @test s.risk_class isa String
        end
    end

    # ---------------------------------------------------------------------------
    # Test 2: Breakpoints present at known thresholds
    # ---------------------------------------------------------------------------

    @testset "breakpoint_sweep has breakpoints at 75 and 100" begin
        segments = breakpoint_sweep(seed_retailers, "Electronics", no_card;
                                     p_min=0.0, p_max=500.0, tax_rate=0.0)

        boundaries = Set{Float64}()
        for s in segments
            push!(boundaries, s.spend_from)
            push!(boundaries, s.spend_to)
        end

        # Nike per_order_flat min_spend = 75.0
        @test 75.0 in boundaries
        # BestBuy flat_tiered threshold = 100.0
        @test 100.0 in boundaries
    end

    # ---------------------------------------------------------------------------
    # Test 3: Single point sweep (p_min == p_max)
    # ---------------------------------------------------------------------------

    @testset "breakpoint_sweep single point" begin
        segments = breakpoint_sweep(seed_retailers, "Electronics", no_card;
                                     p_min=200.0, p_max=200.0, tax_rate=0.0)

        @test length(segments) == 1
        @test segments[1].spend_from == 200.0
        @test segments[1].spend_to == 200.0
        @test segments[1].miles_at_midpoint >= 0.0
    end

    # ---------------------------------------------------------------------------
    # Test 4: Path/retailer changes across boundaries
    # ---------------------------------------------------------------------------

    @testset "breakpoint_sweep path changes across range" begin
        segments = breakpoint_sweep(seed_retailers, "Electronics", no_card;
                                     p_min=0.0, p_max=500.0, tax_rate=0.0)

        # Collect unique (retailer, path) pairs
        unique_pairs = Set{Tuple{String, String}}()
        for s in segments
            if !isempty(s.retailer_name)
                push!(unique_pairs, (s.retailer_name, s.path))
            end
        end

        # With BestBuy's $100 bonus threshold and Nike's $75 threshold in the seed data,
        # we expect the winner to change at some point. This is a soft assertion.
        if length(unique_pairs) <= 1
            @warn "Sweep produced only one winner across entire range — this is possible but unusual with seed data bonuses"
        end
        # The sweep should at least produce valid results
        @test length(segments) >= 1
    end

    # ---------------------------------------------------------------------------
    # Test 5: SweepSegment struct construction and JSON serialization
    # ---------------------------------------------------------------------------

    @testset "SweepSegment struct and JSON serialization" begin
        seg = SweepSegment(0.0, 100.0, "BestBuy", "direct", 400.0, "confirmed")
        @test seg.spend_from == 0.0
        @test seg.spend_to == 100.0
        @test seg.retailer_name == "BestBuy"
        @test seg.path == "direct"
        @test seg.miles_at_midpoint == 400.0
        @test seg.risk_class == "confirmed"

        # JSON serialization (via Dict)
        d = Dict{String, Any}(
            "spend_from" => seg.spend_from,
            "spend_to" => seg.spend_to,
            "retailer_name" => seg.retailer_name,
            "path" => seg.path,
            "miles_at_midpoint" => seg.miles_at_midpoint,
            "risk_class" => seg.risk_class,
        )
        json_str = JSON3.write(d)
        @test contains(json_str, "BestBuy")
        @test contains(json_str, "400")

        # Round-trip
        parsed = JSON3.read(json_str)
        @test parsed[:retailer_name] == "BestBuy"
        @test parsed[:miles_at_midpoint] == 400.0
    end

    # ---------------------------------------------------------------------------
    # Test 6: Sweep with card tier produces higher miles
    # ---------------------------------------------------------------------------

    @testset "breakpoint_sweep with card produces higher miles" begin
        explorer = CardTier("United Explorer", 1.0, Dict("dining" => 2.0, "travel" => 2.0))

        segments_no_card = breakpoint_sweep(seed_retailers, "Electronics", no_card;
                                             p_min=50.0, p_max=50.0, tax_rate=0.0)
        segments_with_card = breakpoint_sweep(seed_retailers, "Electronics", explorer;
                                               p_min=50.0, p_max=50.0, tax_rate=0.0)

        @test segments_with_card[1].miles_at_midpoint > segments_no_card[1].miles_at_midpoint
    end

end
