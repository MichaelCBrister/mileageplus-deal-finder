# runtests.jl — Test runner for MileagePlusDealFinder engine

using Test

# Load source files
include(joinpath(@__DIR__, "..", "src", "types.jl"))
include(joinpath(@__DIR__, "..", "src", "bonus.jl"))
include(joinpath(@__DIR__, "..", "src", "scoring.jl"))
include(joinpath(@__DIR__, "..", "src", "database.jl"))
include(joinpath(@__DIR__, "..", "src", "basket.jl"))

@testset "MileagePlusDealFinder Engine" begin
    include("test_bonus.jl")
    include("test_scoring.jl")
    include("test_phase4.jl")
    include("test_phase8.jl")
    include("test_phase9.jl")
end
