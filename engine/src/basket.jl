# basket.jl — Greedy and MILP basket optimization
# Phase 8: Order-level MILP per v3-spec.md section 5
# CRITICAL: Decision variables are order-level (x[i,o], y[o], z[o,j]),
# NOT item-level. Each order o has a fixed (retailer, path) pair.
# CRITICAL: No dual variables. HiGHS returns NO_SOLUTION for dual_status on MIPs.

using JuMP
using HiGHS

# ---------------------------------------------------------------------------
# Result structs
# ---------------------------------------------------------------------------

struct ItemAssignment
    item_name::String
    retailer_name::String
    path::String
    miles::Float64
    spend::Float64  # p_cash for this item
end

struct GreedyResult
    assignments::Vector{ItemAssignment}
    total_miles::Float64
    total_spend::Float64
    feasible::Bool
end

struct MILPResult
    assignments::Vector{ItemAssignment}
    total_miles::Float64
    total_spend::Float64
    feasible::Bool
    optimality_gap::Union{Float64, Nothing}
    termination_status::String
    solve_time_seconds::Float64
end

# ---------------------------------------------------------------------------
# Candidate order: a fixed (retailer, path) pair
# ---------------------------------------------------------------------------

struct CandidateOrder
    index::Int
    retailer_data  # RetailerData
    path::PathType
    retailer_name::String
    base_rate::Float64
    mpx_rate::Float64  # 0.0 if not available
    gc_portal_eligible::Bool
    bonuses::Vector{BonusOffer}
end

# ---------------------------------------------------------------------------
# Per-item miles computation for a candidate order
# ---------------------------------------------------------------------------

"""
    item_miles(order, spend, card, category) -> NamedTuple

Compute miles earned by placing an item with the given SpendVector into the given
candidate order. Uses the same formulas as score_direct/score_mpx/score_stacked.
"""
function item_miles(order::CandidateOrder, spend::SpendVector, card::CardTier, category::String)
    if order.path == direct
        rc = classify_category_from_tc(
            category,
            order.retailer_data.tc_inclusions,
            order.retailer_data.tc_exclusions,
            order.retailer_data.tc_confidence
        )
        delta = portal_delta(rc)
        portal = delta * spend.p_portal * order.base_rate
        c_r = card_rate(card, category)
        card_m = spend.p_card * c_r
        bonus_m = 0.0
        if rc != excluded
            bonus_m = total_bonus_miles(order.bonuses, spend.p_portal, order.base_rate)
        end
        total = portal + card_m + bonus_m
        return (total=total, portal=portal, card=card_m, bonus=bonus_m, mpx=0.0)
    elseif order.path == mpx
        if order.mpx_rate <= 0.0
            return (total=0.0, portal=0.0, card=0.0, bonus=0.0, mpx=0.0)
        end
        mpx_m = spend.p_cash * order.mpx_rate
        card_m = spend.p_cash * card.base_rate
        chase_bonus = 0.25 * mpx_m
        total = mpx_m + card_m + chase_bonus
        return (total=total, portal=0.0, card=card_m, bonus=chase_bonus, mpx=mpx_m)
    else  # stacked
        if order.mpx_rate <= 0.0
            return (total=0.0, portal=0.0, card=0.0, bonus=0.0, mpx=0.0)
        end
        # Leg 1: MPX
        mpx_m = spend.p_cash * order.mpx_rate
        card_m = spend.p_cash * card.base_rate
        chase_bonus = 0.25 * mpx_m
        # Leg 2: Portal with gift card
        portal = 0.0
        bonus_m = 0.0
        if order.gc_portal_eligible
            rc = classify_category_from_tc(
                category,
                order.retailer_data.tc_inclusions,
                order.retailer_data.tc_exclusions,
                order.retailer_data.tc_confidence
            )
            if rc != excluded
                delta = portal_delta(rc)
                portal = delta * spend.p_portal * order.base_rate
                bonus_m = total_bonus_miles(order.bonuses, spend.p_portal, order.base_rate)
            end
        end
        total = mpx_m + card_m + chase_bonus + portal + bonus_m
        return (total=total, portal=portal, card=card_m, bonus=(chase_bonus + bonus_m), mpx=mpx_m)
    end
end

"""
    per_item_miles_no_bonus(order, spend, card, category) -> Float64

Compute per-item miles WITHOUT order-level bonuses (flat_tiered, per_order_flat).
These bonuses depend on the order subtotal, not individual item prices,
so they are handled separately in the MILP via z[o,j] tier variables.
Includes: base portal rate + card miles + rate_multiplier bonuses.
"""
function per_item_miles_no_bonus(order::CandidateOrder, spend::SpendVector, card::CardTier, category::String)
    if order.path == direct
        rc = classify_category_from_tc(
            category,
            order.retailer_data.tc_inclusions,
            order.retailer_data.tc_exclusions,
            order.retailer_data.tc_confidence
        )
        delta = portal_delta(rc)
        portal = delta * spend.p_portal * order.base_rate
        c_r = card_rate(card, category)
        card_m = spend.p_card * c_r
        rate_bonus = 0.0
        if rc != excluded
            for b in order.bonuses
                if isa(b, RateMultiplierBonus)
                    rate_bonus += compute_bonus(b, spend.p_portal, order.base_rate)
                end
            end
        end
        return portal + card_m + rate_bonus
    elseif order.path == mpx
        if order.mpx_rate <= 0.0
            return 0.0
        end
        mpx_m = spend.p_cash * order.mpx_rate
        card_m = spend.p_cash * card.base_rate
        chase_bonus = 0.25 * mpx_m
        return mpx_m + card_m + chase_bonus
    else  # stacked
        if order.mpx_rate <= 0.0
            return 0.0
        end
        mpx_m = spend.p_cash * order.mpx_rate
        card_m = spend.p_cash * card.base_rate
        chase_bonus = 0.25 * mpx_m
        portal = 0.0
        rate_bonus = 0.0
        if order.gc_portal_eligible
            rc = classify_category_from_tc(
                category,
                order.retailer_data.tc_inclusions,
                order.retailer_data.tc_exclusions,
                order.retailer_data.tc_confidence
            )
            if rc != excluded
                delta = portal_delta(rc)
                portal = delta * spend.p_portal * order.base_rate
                for b in order.bonuses
                    if isa(b, RateMultiplierBonus)
                        rate_bonus += compute_bonus(b, spend.p_portal, order.base_rate)
                    end
                end
            end
        end
        return mpx_m + card_m + chase_bonus + portal + rate_bonus
    end
end

# ---------------------------------------------------------------------------
# Build candidate orders from retailers
# ---------------------------------------------------------------------------

function build_candidate_orders(retailers::Vector)::Vector{CandidateOrder}
    orders = CandidateOrder[]
    idx = 0
    for r in retailers
        mpx_rate_val = r.retailer.mpx_rate === nothing ? 0.0 : Float64(r.retailer.mpx_rate)
        # Direct path — always valid
        idx += 1
        push!(orders, CandidateOrder(
            idx, r, direct, r.retailer.name,
            r.retailer.base_rate, mpx_rate_val,
            r.retailer.gc_portal_eligible, r.bonuses
        ))
        # MPX path — only if mpx_rate > 0
        if mpx_rate_val > 0.0
            idx += 1
            push!(orders, CandidateOrder(
                idx, r, mpx, r.retailer.name,
                r.retailer.base_rate, mpx_rate_val,
                r.retailer.gc_portal_eligible, r.bonuses
            ))
        end
        # Stacked path — only if mpx_rate > 0
        # DECISION: For stacked, the same retailer is both GC source and destination.
        # Cross-retailer stacked paths are handled in rank_all but not in basket MILP
        # to keep the candidate set manageable.
        if mpx_rate_val > 0.0
            idx += 1
            push!(orders, CandidateOrder(
                idx, r, stacked, r.retailer.name,
                r.retailer.base_rate, mpx_rate_val,
                r.retailer.gc_portal_eligible, r.bonuses
            ))
        end
    end
    return orders
end

# ---------------------------------------------------------------------------
# Greedy basket optimizer
# ---------------------------------------------------------------------------

"""
    greedy_basket(items, retailers, category, card, budget) -> GreedyResult

Fast greedy solver: for each item independently, find the highest-miles
assignment across all candidate orders. Sort items by miles-per-dollar
descending and assign greedily until budget is exhausted.
"""
function greedy_basket(
    items::Vector,
    retailers::Vector,
    category::String,
    card::CardTier,
    budget::Float64
)::GreedyResult
    orders = build_candidate_orders(retailers)

    # For each item, find the best order assignment
    item_options = []
    for item in items
        spend = SpendVector(Float64(item.p_list); tax_rate=0.0)
        best_miles = 0.0
        best_order = nothing
        for o in orders
            m = item_miles(o, spend, card, category)
            if m.total > best_miles
                best_miles = m.total
                best_order = o
            end
        end
        push!(item_options, (
            name=String(item.name),
            p_list=Float64(item.p_list),
            spend=spend,
            best_miles=best_miles,
            best_order=best_order,
        ))
    end

    # Sort by miles per dollar descending (assign highest-value items first)
    sort!(item_options; by=x -> x.p_list > 0.0 ? -(x.best_miles / x.p_list) : 0.0)

    assignments = ItemAssignment[]
    total_miles = 0.0
    total_spend = 0.0
    all_assigned = true

    for opt in item_options
        p_cash = opt.spend.p_cash
        if opt.best_order === nothing
            all_assigned = false
            continue
        end
        if total_spend + p_cash > budget
            all_assigned = false
            continue
        end
        push!(assignments, ItemAssignment(
            opt.name,
            opt.best_order.retailer_name,
            string(opt.best_order.path),
            opt.best_miles,
            p_cash
        ))
        total_miles += opt.best_miles
        total_spend += p_cash
    end

    return GreedyResult(assignments, total_miles, total_spend, all_assigned)
end

# ---------------------------------------------------------------------------
# MILP basket optimizer
# ---------------------------------------------------------------------------

# Bonus tier for MILP — local struct to avoid name collisions
struct OrderBonusTier
    min_spend::Float64
    bonus_miles::Float64
    once_per_member::Bool
    retailer_id::Int
end

"""
    milp_basket(items, retailers, category, card, budget; time_limit=28.0) -> MILPResult or nothing

Order-level MILP per v3-spec.md section 5.1.
Decision variables:
  x[i,o] binary — item i assigned to order o
  y[o] binary — order o is active
  z[t] binary — bonus tier t activated

Returns nothing if infeasible or no feasible incumbent found within time limit.
Does NOT use dual variables (HiGHS returns NO_SOLUTION for dual_status on MIPs).
"""
function milp_basket(
    items::Vector,
    retailers::Vector,
    category::String,
    card::CardTier,
    budget::Float64;
    time_limit::Float64 = 28.0
)::Union{MILPResult, Nothing}
    orders = build_candidate_orders(retailers)
    n_items = length(items)
    n_orders = length(orders)

    if n_items == 0 || n_orders == 0
        return nothing
    end

    # Precompute spend vectors
    spends = [SpendVector(Float64(item.p_list); tax_rate=0.0) for item in items]
    p_cash_vals = [s.p_cash for s in spends]

    # c[i,o] = miles for item i in order o (base+card+rate_multiplier, no flat/per_order bonuses)
    c = zeros(Float64, n_items, n_orders)
    for i in 1:n_items
        for o in 1:n_orders
            c[i, o] = per_item_miles_no_bonus(orders[o], spends[i], card, category)
        end
    end

    # Collect order-level bonus tiers for each order
    order_tiers = Vector{Vector{OrderBonusTier}}(undef, n_orders)
    for o in 1:n_orders
        tiers = OrderBonusTier[]
        ord = orders[o]
        # Only direct and stacked paths earn portal bonuses
        if ord.path == direct || (ord.path == stacked && ord.gc_portal_eligible)
            rc = classify_category_from_tc(
                category,
                ord.retailer_data.tc_inclusions,
                ord.retailer_data.tc_exclusions,
                ord.retailer_data.tc_confidence
            )
            if rc != excluded
                for b in ord.bonuses
                    if isa(b, FlatTieredBonus)
                        for (ms, bm) in b.thresholds
                            push!(tiers, OrderBonusTier(ms, bm, false, b.retailer_id))
                        end
                    elseif isa(b, PerOrderFlatBonus)
                        push!(tiers, OrderBonusTier(b.min_spend, b.bonus_miles, false, b.retailer_id))
                    end
                end
            end
        end
        order_tiers[o] = tiers
    end

    # Flatten tier list for z variable indexing
    tier_list = Tuple{Int, Int, OrderBonusTier}[]  # (order_idx, tier_idx_in_order, tier)
    for o in 1:n_orders
        for (j, t) in enumerate(order_tiers[o])
            push!(tier_list, (o, j, t))
        end
    end
    n_tiers = length(tier_list)

    # Build MILP model
    model = Model(HiGHS.Optimizer)
    set_silent(model)
    set_time_limit_sec(model, time_limit)
    set_optimizer_attribute(model, "mip_rel_gap", 0.01)

    # Decision variables
    @variable(model, x[1:n_items, 1:n_orders], Bin)
    @variable(model, y[1:n_orders], Bin)

    # Tier activation variables
    if n_tiers > 0
        @variable(model, z[1:n_tiers], Bin)
    end

    # Order subtotal (p_portal basis for bonus thresholds)
    @variable(model, s[1:n_orders] >= 0)

    # Constraint: each item assigned to exactly one order
    for i in 1:n_items
        @constraint(model, sum(x[i, o] for o in 1:n_orders) == 1)
    end

    # Constraint: order activation linking
    for o in 1:n_orders
        for i in 1:n_items
            @constraint(model, y[o] >= x[i, o])
        end
        @constraint(model, y[o] <= sum(x[i, o] for i in 1:n_items))
    end

    # Constraint: order subtotal = sum of p_portal for assigned items
    for o in 1:n_orders
        @constraint(model, s[o] == sum(spends[i].p_portal * x[i, o] for i in 1:n_items))
    end

    # Constraint: tier activation with tight Big-M
    M_global = min(budget, sum(sp.p_portal for sp in spends))
    if n_tiers > 0
        for t_idx in 1:n_tiers
            o_idx, _, tier = tier_list[t_idx]
            @constraint(model, z[t_idx] <= y[o_idx])
            # If tier is active, subtotal must meet threshold
            @constraint(model, s[o_idx] >= tier.min_spend * z[t_idx])
            # Tier can only activate if subtotal meets threshold
            # z[t] <= (s[o] / min_spend) but linearized: min_spend * z[t] <= s[o] (already above)
        end
    end

    # Constraint: budget
    @constraint(model, sum(p_cash_vals[i] * x[i, o] for i in 1:n_items, o in 1:n_orders) <= budget)

    # Objective: maximize total miles
    obj = @expression(model, sum(c[i, o] * x[i, o] for i in 1:n_items, o in 1:n_orders))

    # Add tier bonus miles
    if n_tiers > 0
        obj = @expression(model, obj + sum(tier_list[t][3].bonus_miles * z[t] for t in 1:n_tiers))
    end

    @objective(model, Max, obj)

    # Solve
    start_time = time()
    JuMP.optimize!(model)
    solve_time = time() - start_time

    status = termination_status(model)
    if status == MOI.OPTIMAL || (status == MOI.TIME_LIMIT && has_values(model))
        # Extract solution
        assignments = ItemAssignment[]
        total_miles = 0.0
        total_spend = 0.0

        for i in 1:n_items
            for o in 1:n_orders
                if value(x[i, o]) > 0.5
                    m = c[i, o]
                    total_miles += m
                    total_spend += p_cash_vals[i]
                    push!(assignments, ItemAssignment(
                        items[i].name,
                        orders[o].retailer_name,
                        string(orders[o].path),
                        m,
                        p_cash_vals[i]
                    ))
                    break
                end
            end
        end

        # Add tier bonus miles
        if n_tiers > 0
            for t_idx in 1:n_tiers
                if value(z[t_idx]) > 0.5
                    total_miles += tier_list[t_idx][3].bonus_miles
                end
            end
        end

        gap = nothing
        try
            gap = relative_gap(model)
        catch
            # gap may not be available
        end

        return MILPResult(
            assignments, total_miles, total_spend, true,
            gap, string(status), solve_time
        )
    else
        return nothing
    end
end

# ---------------------------------------------------------------------------
# Breakpoint sweep — Phase 9: piecewise-optimal sensitivity analysis
# Per v3-spec.md §7.4: as spend varies, at what breakpoints does the
# optimal earning path change?
# ---------------------------------------------------------------------------

struct SweepSegment
    spend_from::Float64
    spend_to::Float64
    retailer_name::String
    path::String
    miles_at_midpoint::Float64
    risk_class::String
end

"""
    breakpoint_sweep(retailers, category, card_tier; p_min=0.0, p_max=1000.0, tax_rate=0.0)

Sweep spend from p_min to p_max, identifying breakpoints where the optimal
retailer/path changes. The breakpoints come from bonus thresholds (flat_tiered
tier thresholds, per_order_flat min_spend values) and the boundary values p_min/p_max.

Within each interval between consecutive breakpoints, all scoring functions are
linear in spend (no thresholds are crossed mid-interval). We evaluate rank_all
at the midpoint of each interval and record the best result.

Returns a Vector{SweepSegment} of contiguous, non-overlapping segments covering
[p_min, p_max].
"""
function breakpoint_sweep(
    retailers::Vector,
    category::String,
    card_tier::CardTier;
    p_min::Float64 = 0.0,
    p_max::Float64 = 1000.0,
    tax_rate::Float64 = 0.0
)::Vector{SweepSegment}
    # Edge case: single point
    if p_min >= p_max
        spend = SpendVector(p_min; tax_rate=tax_rate)
        results = rank_all(retailers, category, spend, card_tier)
        if isempty(results)
            return [SweepSegment(p_min, p_min, "", "", 0.0, "uncertain")]
        end
        top = results[1]
        return [SweepSegment(p_min, p_min, top.retailer_name, string(top.path),
                             top.total_miles, string(top.risk_class))]
    end

    # Step 1: Collect breakpoints from all retailers' bonuses
    breakpoints = Set{Float64}()
    push!(breakpoints, p_min)
    push!(breakpoints, p_max)

    for r in retailers
        for b in r.bonuses
            if isa(b, FlatTieredBonus)
                for (threshold, _) in b.thresholds
                    push!(breakpoints, threshold)
                end
            elseif isa(b, PerOrderFlatBonus)
                push!(breakpoints, b.min_spend)
            elseif isa(b, RateMultiplierBonus)
                # Rate multipliers don't have spend thresholds that create breakpoints
                # (they apply uniformly), but if there were a min_order_value it would
                # be modeled as a PerOrderFlatBonus or FlatTieredBonus instead.
            end
        end
    end

    # Step 2: Filter to [p_min, p_max], deduplicate, sort
    bp_sorted = sort!(collect(filter(b -> b >= p_min && b <= p_max, breakpoints)))

    # Ensure at least 2 breakpoints
    if length(bp_sorted) < 2
        bp_sorted = [p_min, p_max]
    end

    # Step 3: Evaluate each interval at its midpoint
    segments = SweepSegment[]
    for k in 1:(length(bp_sorted) - 1)
        b_start = bp_sorted[k]
        b_end = bp_sorted[k + 1]
        midpoint = (b_start + b_end) / 2.0

        spend = SpendVector(midpoint; tax_rate=tax_rate)
        results = rank_all(retailers, category, spend, card_tier)

        if isempty(results)
            push!(segments, SweepSegment(b_start, b_end, "", "", 0.0, "uncertain"))
        else
            top = results[1]
            push!(segments, SweepSegment(b_start, b_end, top.retailer_name,
                                         string(top.path), top.total_miles,
                                         string(top.risk_class)))
        end
    end

    return segments
end
